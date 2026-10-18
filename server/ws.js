// WebSocket: partidas con amigos, emparejamiento clasificatorio, espectadores y emotes.
import { WebSocketServer } from 'ws';
import { sha256 } from './auth.js';
import { TIME_CONTROLS } from './rooms.js';

export function attachWs(server, { db, rooms, matchmaker }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    // Solo mismo origen (evita que otras webs abran sockets con tu sesión).
    if (url.pathname !== '/ws' || (origin && new URL(origin).host !== req.headers.host)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const leaveRoom = (ws) => {
    const room = ws.meta.room && rooms.get(ws.meta.room);
    room?.detach(ws);
  };

  function onMessage(ws, raw) {
    const meta = ws.meta;
    const now = Date.now();
    if (now - meta.windowStart > 5000) {
      meta.windowStart = now;
      meta.count = 0;
    }
    if (++meta.count > 40) return; // más de 40 mensajes en 5 s: se ignora

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'auth') {
      const user = typeof msg.token === 'string' ? db.userByToken(sha256(msg.token)) : null;
      if (!user) return send(ws, { t: 'error', code: 'auth', message: 'Sesión no válida' });
      meta.user = user;
      return send(ws, { t: 'authed', user });
    }
    if (!meta.user) return send(ws, { t: 'error', code: 'auth', message: 'Identifícate primero' });

    const room = meta.room ? rooms.get(meta.room) : null;
    switch (msg.t) {
      case 'create': {
        leaveRoom(ws);
        matchmaker.dequeue(meta.user.id);
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
        leaveRoom(ws);
        matchmaker.dequeue(meta.user.id);
        meta.user = db.userById(meta.user.id) ?? meta.user;
        target.seat(meta.user, ws);
        target.broadcast();
        break;
      }
      case 'queue': {
        const tcId = msg.tc;
        if (!TIME_CONTROLS[tcId] || tcId === 'none') return send(ws, { t: 'error', message: 'Elige un control de tiempo' });
        leaveRoom(ws);
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
        leaveRoom(ws);
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
      matchmaker.removeSocket(ws);
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

  return {
    count: () => wss.clients.size,
    close() {
      clearInterval(heartbeat);
      wss.clients.forEach((c) => c.terminate());
      wss.close();
    },
  };
}
