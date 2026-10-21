// Salas de partida en tiempo real. El servidor es la autoridad: valida jugadas, relojes y resultado.
import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { ratingChanges } from './elo.js';
import { assessGame, recordFlags } from './fairplay.js';
import { nullMetrics } from './metrics.js';

export const TIME_CONTROLS = {
  none: { id: 'none', base: 0, inc: 0 },
  bullet: { id: 'bullet', base: 60, inc: 0 },
  blitz3: { id: 'blitz3', base: 180, inc: 0 },
  blitz3_2: { id: 'blitz3_2', base: 180, inc: 2 },
  blitz5: { id: 'blitz5', base: 300, inc: 0 },
  rapid10: { id: 'rapid10', base: 600, inc: 0 },
  rapid15_10: { id: 'rapid15_10', base: 900, inc: 10 },
};

export const EMOTE_COUNT = 12; // los textos viven en el cliente; aquí solo se valida el id
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DISCONNECT_GRACE_MS = 45_000;

const genCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const other = (c) => (c === 'w' ? 'b' : 'w');
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * ¿Puede `color` dar mate con el material que tiene? Se usa al caer la bandera del rival: si no puede,
 * la partida es tablas (reglas FIDE/lichess) en vez de victoria por tiempo.
 * Suficiente = algún peón/torre/dama, dos o más piezas menores, o una menor si el rival conserva piezas.
 */
export function hasMatingMaterial(chess, color) {
  let minors = 0;
  let others = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.type === 'k') continue;
      if (p.color === color) {
        if (p.type === 'n' || p.type === 'b') minors += 1;
        else return true;
      } else {
        others += 1;
      }
    }
  }
  return minors >= 2 || (minors === 1 && others > 0);
}

export class Room {
  constructor(manager, { code, tcId = 'none', rated = false, colorPref = 'r', reserved = null, strict = false, circuit = null }) {
    this.m = manager;
    this.code = code;
    this.tc = TIME_CONTROLS[tcId] ?? TIME_CONTROLS.none;
    this.rated = rated;
    this.hostColor = colorPref === 'w' || colorPref === 'b' ? colorPref : Math.random() < 0.5 ? 'w' : 'b';
    this.reserved = reserved; // { w: userId, b: userId } para revanchas
    this.strict = strict; // con `reserved`, solo esos usuarios pueden sentarse (torneos); el resto entra como espectador
    this.circuit = circuit; // { id, round, label } si es una partida del Royale Circuit
    this.onOver = null; // gancho al terminar la partida (lo usan los torneos)
    this.players = { w: null, b: null };
    this.sockets = new Set();
    this.chess = new Chess();
    this.uci = [];
    this.status = 'waiting'; // waiting | playing | over
    this.result = null;
    this.ratingDelta = null;
    this.clocks = this.tc.base ? { w: this.tc.base * 1000, b: this.tc.base * 1000 } : null;
    this.running = null;
    this.lastTick = 0;
    this.drawOffer = null;
    this.rematchVotes = new Set();
    this.rematchCode = null;
    this.createdAt = Date.now();
    this.touched = Date.now();
    this.flagTimer = null;
    this.dcTimers = {};
    this.emoteAt = { w: 0, b: 0 };
    this.thinks = []; // [{ role, ms }]: tiempo que tardó cada jugada (para las heurísticas de juego limpio)
    this.lastMoveAt = 0;
    this.unrated = null; // motivo por el que una partida clasificatoria no puntúa ('pair' | 'quick')
  }

  // ----- Asientos -----
  hasPlayer(userId) {
    return ['w', 'b'].some((c) => this.players[c]?.id === userId);
  }

  isFull() {
    return !!(this.players.w && this.players.b);
  }

  spectatorCount() {
    return Math.max(0, this.sockets.size - ['w', 'b'].reduce((n, c) => n + (this.players[c]?.socks.size ?? 0), 0));
  }

  seat(user, ws) {
    this.touched = Date.now();
    let role = ['w', 'b'].find((c) => this.players[c]?.id === user.id);
    if (!role) {
      const reservedRole = this.reserved && ['w', 'b'].find((c) => this.reserved[c] === user.id && !this.players[c]);
      const free = ['w', 'b'].filter((c) => !this.players[c]);
      if (reservedRole) role = reservedRole;
      else if (this.strict) role = 's';
      else if (free.length) role = !this.players.w && !this.players.b ? this.hostColor : free[0];
      else role = 's';
      if (role !== 's') this.players[role] = { id: user.id, name: user.name, rating: user.rating, games: user.games ?? 0, socks: new Set() };
    }
    if (role !== 's') {
      const p = this.players[role];
      p.socks.add(ws);
      p.name = user.name;
      p.dcAt = 0; // volvió: ya no corre la cuenta atrás de desconexión
      clearTimeout(this.dcTimers[role]);
    }
    this.sockets.add(ws);
    ws.meta.room = this.code;
    ws.meta.role = role;
    if (this.status === 'waiting' && this.players.w && this.players.b) {
      this.status = 'playing';
      this.lastMoveAt = Date.now();
    }
    return role;
  }

  detach(ws, { explicit = false } = {}) {
    this.sockets.delete(ws);
    const role = ws.meta.role;
    ws.meta.room = null;
    ws.meta.role = null;
    // El anfitrión cancela su sala vacía: se borra ya (así no cuenta para su tope de partidas abiertas).
    if (explicit && this.status === 'waiting' && this.sockets.size === 0) {
      this.m.remove(this);
      return;
    }
    if (!role || role === 's') return;
    const p = this.players[role];
    p?.socks.delete(ws);
    if (p && p.socks.size === 0 && this.status === 'playing') {
      clearTimeout(this.dcTimers[role]);
      p.dcAt = Date.now() + DISCONNECT_GRACE_MS;
      this.dcTimers[role] = setTimeout(() => {
        if (this.status !== 'playing' || p.socks.size) return;
        if (this.uci.length >= 2) this.end(other(role), 'desconexión');
        else this.end(null, 'abortada');
      }, DISCONNECT_GRACE_MS);
      this.dcTimers[role].unref?.(); // no debe impedir que el proceso termine (apagado y pruebas)
    }
    this.broadcast();
  }

  // ----- Estado -----
  clockSnapshot() {
    if (!this.clocks) return null;
    const c = { w: this.clocks.w, b: this.clocks.b, running: this.running };
    if (this.running) c[this.running] = Math.max(0, c[this.running] - (Date.now() - this.lastTick));
    return c;
  }

  snapshot(role) {
    // `dcLeft`: ms que le quedan a un jugador desconectado para volver antes de perder (0 si está conectado).
    const pub = (p) => p && { id: p.id, name: p.name, rating: p.rating, online: p.socks.size > 0, dcLeft: p.socks.size === 0 && p.dcAt && this.status === 'playing' ? Math.max(0, p.dcAt - Date.now()) : 0 };
    return {
      t: 'state',
      code: this.code,
      you: role,
      status: this.status,
      result: this.result,
      ratingDelta: this.ratingDelta,
      rated: this.rated,
      tc: this.tc.id,
      tcInfo: { base: this.tc.base, inc: this.tc.inc },
      fen: this.chess.fen(),
      moves: this.uci,
      turn: this.chess.turn(),
      players: { w: pub(this.players.w), b: pub(this.players.b) },
      clocks: this.clockSnapshot(),
      drawOffer: this.drawOffer,
      rematch: [...this.rematchVotes],
      rematchCode: this.rematchCode,
      spectators: this.spectatorCount(),
      circuit: this.circuit,
      unrated: this.unrated,
    };
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcast() {
    for (const ws of this.sockets) this.send(ws, this.snapshot(ws.meta.role));
  }

  // ----- Acciones -----
  fail(ws, message) {
    this.send(ws, { t: 'error', message });
    this.send(ws, this.snapshot(ws.meta.role)); // resincroniza al cliente
  }

  move(ws, uci) {
    const role = ws.meta.role;
    if (this.status !== 'playing') return this.fail(ws, 'No hay partida en curso');
    if (role !== this.chess.turn()) return this.fail(ws, 'No es tu turno');
    if (typeof uci !== 'string' || !UCI.test(uci)) return this.fail(ws, 'Jugada no válida');

    const now = Date.now();
    if (this.clocks && this.running === role) {
      this.clocks[role] -= now - this.lastTick;
      if (this.clocks[role] <= 0) {
        this.clocks[role] = 0;
        this.timeout(role);
        return;
      }
    }
    try {
      this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      return this.fail(ws, 'Jugada ilegal');
    }
    this.touched = now;
    this.m.metrics.inc('moves_total');
    this.thinks.push({ role, ms: now - (this.lastMoveAt || now) });
    this.lastMoveAt = now;
    this.uci.push(uci);
    this.drawOffer = null;

    if (this.clocks) {
      // El primer movimiento de cada bando no corre reloj; el incremento se suma desde la tercera jugada.
      if (this.uci.length > 2) this.clocks[role] += this.tc.inc * 1000;
      this.running = this.uci.length >= 2 ? this.chess.turn() : null;
      this.lastTick = now;
    }

    if (this.chess.isCheckmate()) return this.end(role, 'jaque mate');
    if (this.chess.isStalemate()) return this.end(null, 'rey ahogado');
    if (this.chess.isInsufficientMaterial()) return this.end(null, 'material insuficiente');
    if (this.chess.isThreefoldRepetition()) return this.end(null, 'triple repetición');
    if (this.chess.isDraw()) return this.end(null, 'regla de las 50 jugadas');
    this.scheduleFlag();
    this.broadcast();
  }

  scheduleFlag() {
    clearTimeout(this.flagTimer);
    if (!this.clocks || !this.running || this.status !== 'playing') return;
    const left = this.clocks[this.running] - (Date.now() - this.lastTick);
    this.flagTimer = setTimeout(() => this.checkFlag(), Math.max(0, left) + 30);
    this.flagTimer.unref?.();
  }

  checkFlag() {
    if (this.status !== 'playing' || !this.running) return;
    const left = this.clocks[this.running] - (Date.now() - this.lastTick);
    if (left <= 0) this.timeout(this.running);
    else this.scheduleFlag();
  }

  // `loser` se quedó sin tiempo: pierde, salvo que el rival no pueda dar mate con su material.
  timeout(loser) {
    const winner = other(loser);
    if (!hasMatingMaterial(this.chess, winner)) this.end(null, 'tiempo con material insuficiente');
    else this.end(winner, 'tiempo');
  }

  resign(ws) {
    const role = ws.meta.role;
    if (role === 's' || this.status !== 'playing') return;
    // Antes de que cada bando haya movido, rendirse equivale a abortar (sin efecto en el ranking).
    if (this.uci.length < 2) return this.end(null, 'abortada');
    this.end(other(role), 'rendición');
  }

  drawAction(ws, action) {
    const role = ws.meta.role;
    if (role === 's' || this.status !== 'playing') return;
    if (action === 'offer' && !this.drawOffer) this.drawOffer = role;
    else if (action === 'accept' && this.drawOffer && this.drawOffer !== role) return this.end(null, 'tablas acordadas');
    else if (action === 'decline' && this.drawOffer && this.drawOffer !== role) this.drawOffer = null;
    this.broadcast();
  }

  emote(ws, id) {
    const role = ws.meta.role;
    if (role === 's' || !Number.isInteger(id) || id < 0 || id >= EMOTE_COUNT) return;
    const now = Date.now();
    if (now - this.emoteAt[role] < 1500) return;
    this.emoteAt[role] = now;
    for (const s of this.sockets) this.send(s, { t: 'emote', from: role, id });
  }

  rematch(ws) {
    const role = ws.meta.role;
    if (role === 's' || this.status !== 'over' || !this.players.w || !this.players.b) return;
    if (this.rematchCode) return;
    this.rematchVotes.add(role);
    if (this.rematchVotes.size === 2) this.rematchCode = this.m.createRematch(this);
    this.broadcast();
  }

  end(winner, reason) {
    if (this.status === 'over') return;
    const cs = this.clockSnapshot();
    if (cs) {
      this.clocks.w = cs.w;
      this.clocks.b = cs.b;
    }
    this.running = null;
    this.status = 'over';
    this.result = { winner, reason };
    this.drawOffer = null;
    clearTimeout(this.flagTimer);
    Object.values(this.dcTimers).forEach(clearTimeout);
    this.touched = Date.now();
    this.ratingDelta = this.m.onGameEnd(this);
    this.m.metrics.inc('games_total', { mode: this.circuit ? 'circuit' : this.rated ? 'ranked' : 'friend', result: winner ? 'decisive' : reason === 'abortada' ? 'aborted' : 'draw' });
    this.broadcast();
    this.onOver?.(this);
  }

  dispose() {
    clearTimeout(this.flagTimer);
    Object.values(this.dcTimers).forEach(clearTimeout);
  }
}

export class RoomManager {
  /** @param {ReturnType<import('./db.js').openDb>} db */
  constructor(db, { metrics = nullMetrics } = {}) {
    this.db = db;
    this.metrics = metrics;
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  create({ tcId, rated = false, colorPref = 'r', reserved = null, strict = false, circuit = null }) {
    let code;
    do code = genCode();
    while (this.rooms.has(code));
    const room = new Room(this, { code, tcId, rated, colorPref, reserved, strict, circuit });
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').toUpperCase());
  }

  remove(room) {
    room.dispose();
    this.rooms.delete(room.code);
  }

  // Partidas clasificatorias en curso para el lobby ("en vivo"). Las partidas con amigo no se listan: son privadas por enlace.
  liveGames(limit = 6) {
    const list = [];
    for (const room of this.rooms.values()) {
      if (!room.rated || room.status !== 'playing' || !room.isFull()) continue;
      const { w, b } = room.players;
      list.push({
        code: room.code,
        tc: room.tc.id,
        moves: room.uci.length,
        spectators: room.spectatorCount(),
        w: { name: w.name, rating: w.rating },
        b: { name: b.name, rating: b.rating },
      });
    }
    return list.sort((x, y) => y.w.rating + y.b.rating - (x.w.rating + x.b.rating)).slice(0, limit);
  }

  // ¿Comparten sala (en juego o recién terminada) estos dos jugadores? Permite pedir amistad o reportar desde la partida.
  shareRoom(a, b) {
    for (const room of this.rooms.values()) if (room.hasPlayer(a) && room.hasPlayer(b)) return true;
    return false;
  }

  // Partidas abiertas (esperando o en juego) en las que participa el jugador.
  activeCountFor(userId) {
    let n = 0;
    for (const room of this.rooms.values()) if (room.status !== 'over' && room.hasPlayer(userId)) n += 1;
    return n;
  }

  createRematch(old) {
    // Colores intercambiados: quien jugó con negras ahora lleva blancas.
    const room = this.create({ tcId: old.tc.id, rated: old.rated, reserved: { w: old.players.b.id, b: old.players.w.id } });
    return room.code;
  }

  onGameEnd(room) {
    const { w, b } = room.players;
    if (!w || !b || room.uci.length === 0) return null;
    const gameId = crypto.randomUUID();
    this.db.insertGame({
      id: gameId,
      code: room.code,
      whiteId: w.id,
      blackId: b.id,
      winner: room.result.winner,
      reason: room.result.reason,
      moves: JSON.stringify(room.uci),
      rated: room.rated,
      tc: room.tc.id,
      createdAt: room.createdAt,
    });
    // Juego limpio: alertas para revisar y protección del ranking (ver fairplay.js).
    let assessment = { skipRating: false, flags: [] };
    try {
      assessment = assessGame({ room, db: this.db });
      recordFlags({ db: this.db, gameId, flags: assessment.flags, metrics: this.metrics });
    } catch (err) {
      console.error('[fairplay]', err);
    }
    if (!room.rated || room.result.reason === 'abortada') return null;
    if (assessment.skipRating) {
      room.unrated = assessment.reason;
      this.metrics.inc('rating_skipped_total', { reason: assessment.reason });
      return null;
    }
    const uw = this.db.userById(w.id);
    const ub = this.db.userById(b.id);
    if (!uw || !ub) return null;
    const scoreW = room.result.winner === 'w' ? 1 : room.result.winner === 'b' ? 0 : 0.5;
    const [dw, db] = ratingChanges(uw, ub, scoreW);
    const nw = Math.max(100, uw.rating + dw);
    const nb = Math.max(100, ub.rating + db);
    this.db.applyRating(w.id, nw, scoreW);
    this.db.applyRating(b.id, nb, 1 - scoreW);
    w.rating = nw;
    b.rating = nb;
    return { w: dw, b: db, ratings: { w: nw, b: nb } };
  }

  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const idle = now - room.touched;
      const empty = room.sockets.size === 0;
      if ((room.status === 'over' && idle > 20 * 60_000) || (room.status === 'waiting' && empty && idle > 3 * 60_000) || (empty && idle > 2 * 3600_000)) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  close() {
    clearInterval(this.sweeper);
    this.rooms.forEach((r) => r.dispose());
  }
}
