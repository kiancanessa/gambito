// WebSocket: partidas con amigos, emparejamiento clasificatorio, espectadores y emotes.
import { WebSocketServer } from 'ws';
import { sha256 } from './auth.js';
import { LIMITS, TRUST_PROXY, allowedOrigins } from './config.js';
import { TIME_CONTROLS } from './rooms.js';
import { circuitMessage } from './tournaments.js';

const KNOWN_MESSAGES = new Set(['auth', 'create', 'join', 'queue', 'dequeue', 'move', 'resign', 'draw', 'emote', 'rematch', 'leave', 'invite', 'circuit_join', 'circuit_leave', 'circuit_sync', 'circuit_watch', 'circuit_unwatch']);

const clientIp = (req) => {
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || 'unknown';
};

// ¿Puede este origen abrir sockets? Mismo origen, o uno de ALLOWED_ORIGINS (cliente alojado aparte).
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes que no son navegadores (bots, pruebas)
  try {
    if (new URL(origin).host === req.headers.host) return true;
  } catch {
    return false;
  }
  return allowedOrigins().includes(origin.replace(/\/$/, ''));
}

export function attachWs(server, { db, rooms, matchmaker, circuit, social, metrics = { inc() {} } }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const perIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || !originAllowed(req)) {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    if ((perIp.get(ip) ?? 0) >= LIMITS.wsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      metrics.inc('ws_connections_total');
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      wss.emit('connection', ws, req);
    });
  });

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  // `explicit`: el jugador decide salir (no es una desconexión): una sala vacía en espera se borra al instante.
  const leaveRoom = (ws, explicit = false) => {
    const room = ws.meta.room && rooms.get(ws.meta.room);
    room?.detach(ws, { explicit });
  };

  function onMessage(ws, raw) {
    const meta = ws.meta;
    const now = Date.now();
    if (now - meta.windowStart > 5000) {
      meta.windowStart = now;
      meta.count = 0;
    }
    if (++meta.count > 40) {
      metrics.inc('ws_dropped_total'); // más de 40 mensajes en 5 s: se ignora
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    metrics.inc('ws_messages_total', { t: KNOWN_MESSAGES.has(msg.t) ? msg.t : 'other' });

    if (msg.t === 'auth') {
      const user = typeof msg.token === 'string' ? db.userByToken(sha256(msg.token)) : null;
      if (!user) return send(ws, { t: 'error', code: 'auth', message: 'Sesión no válida' });
      let sameUser = 0;
      for (const c of wss.clients) if (c !== ws && c.meta?.user?.id === user.id) sameUser += 1;
      if (sameUser >= LIMITS.socketsPerUser) {
        send(ws, { t: 'error', code: 'limit', message: 'Demasiadas conexiones abiertas con esta cuenta' });
        return ws.close();
      }
      meta.user = user;
      send(ws, { t: 'authed', user });
      circuit.attach(user, ws); // quien ya está inscrito vuelve a recibir su torneo y su partida pendiente al reconectar
      return undefined;
    }
    if (!meta.user) return send(ws, { t: 'error', code: 'auth', message: 'Identifícate primero' });

    const room = meta.room ? rooms.get(meta.room) : null;
    switch (msg.t) {
      case 'create': {
        meta.creates = (meta.creates ?? []).filter((t) => now - t < 60_000);
        if (meta.creates.length >= LIMITS.createsPerMinute) return send(ws, { t: 'error', code: 'limit', message: 'Vas muy rápido: espera un momento para crear otra partida' });
        leaveRoom(ws, true);
        matchmaker.dequeue(meta.user.id);
        if (rooms.rooms.size >= LIMITS.totalRooms) return send(ws, { t: 'error', code: 'full', message: 'El servidor está lleno, inténtalo en unos minutos' });
        if (rooms.activeCountFor(meta.user.id) >= LIMITS.roomsPerUser) return send(ws, { t: 'error', code: 'limit', message: 'Ya tienes varias partidas abiertas. Termina o abandona alguna antes de crear otra' });
        meta.creates.push(now);
        meta.user = db.userById(meta.user.id) ?? meta.user;
        const tcId = TIME_CONTROLS[msg.tc] ? msg.tc : 'none';
        const created = rooms.create({ tcId, rated: false, colorPref: msg.color });
        created.seat(meta.user, ws);
        send(ws, { t: 'created', code: created.code });
        created.broadcast();
        break;
      }
      case 'join': {
        const target = rooms.get(msg.code);
        if (!target) return send(ws, { t: 'error', code: 'nogame', message: 'Esa partida no existe o ya terminó' });
        if (target === room) return target.broadcast();
        if (!target.hasPlayer(meta.user.id) && target.isFull() && target.spectatorCount() >= LIMITS.spectatorsPerRoom) {
          return send(ws, { t: 'error', code: 'full', message: 'La sala de espectadores está llena' });
        }
        leaveRoom(ws, true);
        matchmaker.dequeue(meta.user.id);
        meta.user = db.userById(meta.user.id) ?? meta.user;
        target.seat(meta.user, ws);
        target.broadcast();
        break;
      }
      case 'queue': {
        const tcId = msg.tc;
        if (!TIME_CONTROLS[tcId] || tcId === 'none') return send(ws, { t: 'error', message: 'Elige un control de tiempo' });
        leaveRoom(ws, true);
        meta.user = db.userById(meta.user.id) ?? meta.user;
        matchmaker.enqueue(meta.user, ws, tcId);
        send(ws, { t: 'queued', size: matchmaker.size() });
        break;
      }
      case 'dequeue':
        matchmaker.dequeue(meta.user.id);
        send(ws, { t: 'dequeued' });
        break;
      case 'move':
        room?.move(ws, msg.uci);
        break;
      case 'resign':
        room?.resign(ws);
        break;
      case 'draw':
        room?.drawAction(ws, msg.action);
        break;
      case 'emote':
        room?.emote(ws, msg.id);
        break;
      case 'rematch':
        room?.rematch(ws);
        break;
      case 'leave':
        leaveRoom(ws, true);
        break;
      // ----- Invitaciones a amigos -----
      case 'invite': {
        meta.invites = (meta.invites ?? []).filter((t) => now - t < 60_000);
        if (meta.invites.length >= 10) return send(ws, { t: 'error', message: 'Demasiadas invitaciones seguidas: espera un momento' });
        const to = typeof msg.to === 'string' ? msg.to : '';
        if (!room || room.status !== 'waiting' || meta.role === 's' || !room.hasPlayer(meta.user.id)) return send(ws, { t: 'error', message: 'Crea una partida y espera a tu rival antes de invitar' });
        if (!social.areFriends(meta.user.id, to) || social.isBlocked(meta.user.id, to)) return send(ws, { t: 'error', message: 'Solo puedes invitar a tus amigos' });
        meta.invites.push(now);
        const from = { id: meta.user.id, name: meta.user.name, rating: meta.user.rating };
        const delivered = notify(to, { t: 'invite', from, code: room.code, tc: room.tc.id });
        send(ws, delivered ? { t: 'invited', to } : { t: 'error', message: 'Tu amigo no está conectado ahora mismo' });
        break;
      }
      // ----- Royale Circuit -----
      // El cliente solo pide inscribirse, salir o mirar; el servidor valida plazos, cupos y unicidad y es el único que mueve el cuadro.
      case 'circuit_join':
      case 'circuit_leave': {
        meta.circuitActs = (meta.circuitActs ?? []).filter((x) => now - x < 60_000);
        const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
        if (meta.circuitActs.length >= 12) return send(ws, { t: 'circuit_error', reason: 'limit', message: circuitMessage('limit') });
        meta.circuitActs.push(now);
        meta.user = db.userById(meta.user.id) ?? meta.user;
        const res = msg.t === 'circuit_join' ? circuit.join(meta.user, id, ws) : circuit.leave(meta.user, id);
        if (!res.ok) return send(ws, { t: 'circuit_error', reason: res.reason, id, message: circuitMessage(res.reason) });
        send(ws, { t: 'circuit_state', circuit: circuit.detail(id, meta.user.id) });
        break;
      }
      case 'circuit_sync':
        circuit.attach(meta.user, ws);
        break;
      case 'circuit_watch':
        circuit.watch(ws, typeof msg.id === 'string' ? msg.id.slice(0, 64) : null);
        break;
      case 'circuit_unwatch':
        circuit.unwatch(ws);
        break;
      default:
    }
  }

  wss.on('connection', (ws) => {
    ws.meta = { user: null, room: null, role: null, queued: false, windowStart: Date.now(), count: 0 };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      try {
        onMessage(ws, raw);
      } catch (err) {
        console.error('[ws]', err);
      }
    });
    ws.on('close', () => {
      const n = (perIp.get(ws.ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ws.ip);
      else perIp.set(ws.ip, n);
      matchmaker.removeSocket(ws);
      circuit.detachSocket(ws);
      leaveRoom(ws);
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  // Envía un mensaje a todas las conexiones de un usuario; devuelve cuántas lo recibieron.
  function notify(userId, msg) {
    let n = 0;
    for (const c of wss.clients) {
      if (c.meta?.user?.id === userId && c.readyState === 1) {
        send(c, msg);
        n += 1;
      }
    }
    return n;
  }

  // Estado en línea de varios usuarios: online | queue (buscando partida) | playing; los que no aparecen están desconectados.
  function presence(ids) {
    const want = new Set(ids);
    const rank = { online: 1, queue: 2, playing: 3 };
    const out = {};
    for (const c of wss.clients) {
      const id = c.meta?.user?.id;
      if (!id || !want.has(id)) continue;
      const r = c.meta.room && rooms.get(c.meta.room);
      let st = 'online';
      if (c.meta.queued) st = 'queue';
      if (r && r.status === 'playing' && r.hasPlayer(id)) st = 'playing';
      if (!out[id] || rank[st] > rank[out[id]]) out[id] = st;
    }
    return out;
  }

  return {
    notify,
    presence,
    count: () => wss.clients.size,
    close() {
      clearInterval(heartbeat);
      wss.clients.forEach((c) => c.terminate());
      wss.close();
    },
  };
}
