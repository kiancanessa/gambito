// Royale Circuit: torneo eliminatorio de 8 jugadores, bajo demanda (Fase 4).
//
// Flujo: los jugadores se inscriben; al llegar a 8 (o pasado `fillAfterMs`, rellenando con bots) arranca el cuadro
// de cuartos → semifinales → final. Las partidas con humanos son salas normales (`Room`) con asientos reservados;
// las partidas entre bots se resuelven por probabilidad de rating para no hacer esperar a nadie.
// Un empate se repite con los colores cambiados; tras `maxDraws` empates pasa el mejor cabeza de serie.
// Los premios se guardan en `tournament_results` y se cobran por la cartera verificada (fuente `circuit`).
import crypto from 'node:crypto';
import { Chess } from 'chess.js';

export const CIRCUIT = {
  size: 8,
  tc: 'blitz3_2',
  fillAfterMs: 60_000, // espera máxima antes de rellenar con bots
  intermissionMs: 8_000, // pausa entre rondas
  noShowMs: 60_000, // tiempo para sentarse en la sala de tu partida
  botMoveMs: [500, 1500],
  botSimMs: [6_000, 14_000], // duración simulada de un bot contra otro
  maxDraws: 3,
  keepFinishedMs: 5 * 60_000,
  rounds: ['Cuartos de final', 'Semifinal', 'Final'],
  // Premios por la ronda alcanzada. Todo cosmético o monedas: nunca ventaja de juego.
  prizes: {
    quarter: { coins: 30, xp: 30 },
    semi: { coins: 60, xp: 60 },
    final: { coins: 120, xp: 120 },
    champion: { coins: 250, xp: 250, item: 'set:royal' },
  },
};

const BOT_NAMES = ['Peón', 'Caballo', 'Alfil', 'Torre', 'Dama', 'Rey', 'Gambito', 'Enroque'];
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PLACEMENTS = ['quarter', 'semi', 'final'];
// Cabezas de serie 1-8 → emparejamientos de cuartos: 1v8, 4v5, 2v7, 3v6 (los dos primeros cruzan, y los dos últimos).
const SEED_PAIRS = [[0, 7], [3, 4], [1, 6], [2, 5]];

const between = ([lo, hi], rnd = Math.random) => lo + rnd() * (hi - lo);
const other = (c) => (c === 'w' ? 'b' : 'w');

// ----- Bot de torneo: legal, con preferencia por mate en 1, capturas y sin regalar mate en 1 -----
export function chooseBotMove(fen, rnd = Math.random) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const scored = moves.map((m) => {
    chess.move(m);
    let score = rnd() * 2;
    if (chess.isCheckmate()) score += 1000;
    else {
      if (m.captured) score += PIECE_VALUE[m.captured] * 3 - (PIECE_VALUE[m.piece] > PIECE_VALUE[m.captured] ? PIECE_VALUE[m.piece] : 0) * 0.5;
      if (chess.inCheck()) score += 1.5;
      if (m.promotion) score += 8;
      // no regalar mate en 1
      for (const r of chess.moves({ verbose: true })) {
        chess.move(r);
        if (chess.isCheckmate()) score -= 500;
        chess.undo();
        if (score < -400) break;
      }
    }
    chess.undo();
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].m;
  return best.from + best.to + (best.promotion ?? '');
}

// Jugador "virtual": hace de WebSocket dentro de la sala y responde a cada `state`.
function makeBotSocket(room, user, role, delayMs) {
  const ws = {
    readyState: 1,
    meta: { user, room: room.code, role },
    busy: false,
    send(raw) {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.t !== 'state' || m.status !== 'playing' || m.turn !== role || ws.busy) return;
      ws.busy = true;
      setTimeout(() => {
        ws.busy = false;
        if (room.status !== 'playing' || room.chess.turn() !== role) return;
        const uci = chooseBotMove(room.chess.fen());
        if (uci) room.move(ws, uci);
      }, Math.max(0, delayMs()));
    },
  };
  return ws;
}

export class CircuitManager {
  /**
   * @param {object} o
   * @param {import('./rooms.js').RoomManager} o.rooms
   * @param {ReturnType<import('./db.js').openDb>} o.db
   * @param {object} [o.options]  sobrescribe `CIRCUIT` (pruebas)
   */
  constructor({ rooms, db, options = {} }) {
    this.rooms = rooms;
    this.db = db;
    this.cfg = { ...CIRCUIT, ...options };
    this.tournaments = new Map();
    this.timers = new Set();
    this.closed = false;
  }

  // ----- Utilidades -----
  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  active(userId) {
    for (const t of this.tournaments.values()) {
      if (t.status === 'finished') continue;
      const e = t.entrants.find((x) => x.id === userId);
      if (e && !e.out) return { t, e };
    }
    return null;
  }

  registering() {
    return [...this.tournaments.values()].find((t) => t.status === 'registering') ?? null;
  }

  // ----- Inscripción -----
  join(user, ws) {
    const found = this.active(user.id);
    if (found) {
      found.e.socks.add(ws);
      this.pushTo(found.e, found.t);
      return found.t;
    }
    let t = this.registering();
    if (!t) {
      t = {
        id: crypto.randomUUID(),
        tc: this.cfg.tc,
        size: this.cfg.size,
        status: 'registering',
        createdAt: Date.now(),
        fillAt: Date.now() + this.cfg.fillAfterMs,
        entrants: [],
        rounds: [],
        round: 0,
        champion: null,
      };
      this.tournaments.set(t.id, t);
      this.later(() => this.start(t), this.cfg.fillAfterMs);
    }
    t.entrants.push({ id: user.id, name: user.name, rating: user.rating, bot: false, socks: new Set([ws]), out: false, seed: null, placement: null });
    if (t.entrants.length >= t.size) this.start(t);
    else this.broadcast(t);
    return t;
  }

  leave(userId) {
    const t = this.registering();
    const i = t ? t.entrants.findIndex((e) => e.id === userId) : -1;
    if (i < 0) return false;
    t.entrants.splice(i, 1);
    if (!t.entrants.length) this.tournaments.delete(t.id);
    else this.broadcast(t);
    return true;
  }

  // Un jugador reconectado vuelve a recibir el estado de su torneo.
  sync(user, ws) {
    const found = this.active(user.id) ?? this.latestOf(user.id);
    if (!found) return null;
    found.e.socks.add(ws);
    this.pushTo(found.e, found.t);
    return found.t;
  }

  latestOf(userId) {
    for (const t of [...this.tournaments.values()].reverse()) {
      const e = t.entrants.find((x) => x.id === userId);
      if (e) return { t, e };
    }
    return null;
  }

  detachSocket(ws) {
    for (const t of this.tournaments.values()) {
      for (const e of t.entrants) e.socks.delete(ws);
      // En inscripción, quien se desconecta del todo libera su plaza.
      if (t.status === 'registering') {
        const gone = t.entrants.filter((e) => !e.bot && e.socks.size === 0);
        if (gone.length) {
          t.entrants = t.entrants.filter((e) => !gone.includes(e));
          if (!t.entrants.length) this.tournaments.delete(t.id);
          else this.broadcast(t);
        }
      }
    }
  }

  // ----- Arranque -----
  start(t) {
    if (t.status !== 'registering' || !this.tournaments.has(t.id)) return;
    let n = 0;
    while (t.entrants.length < t.size) {
      const name = `Bot ${BOT_NAMES[n % BOT_NAMES.length]}`; // 7 bots como máximo: los nombres no se repiten
      t.entrants.push({ id: `bot-${crypto.randomBytes(4).toString('hex')}`, name, rating: 850 + Math.floor(Math.random() * 450), bot: true, socks: new Set(), out: false, seed: null, placement: null });
      n += 1;
    }
    t.entrants.sort((a, b) => b.rating - a.rating);
    t.entrants.forEach((e, i) => (e.seed = i + 1));
    t.status = 'running';
    t.startedAt = Date.now();
    const round0 = SEED_PAIRS.map(([x, y], slot) => this.newMatch(0, slot, t.entrants[x], t.entrants[y]));
    t.rounds = [round0, [this.newMatch(1, 0), this.newMatch(1, 1)], [this.newMatch(2, 0)]];
    this.broadcast(t);
    this.later(() => round0.forEach((m) => this.startMatch(t, m)), 3000);
  }

  newMatch(round, slot, a = null, b = null) {
    return { id: `${round}-${slot}`, round, slot, a, b, status: 'pending', code: null, draws: 0, winner: null, reason: null, timer: null, room: null };
  }

  // ----- Partidas -----
  startMatch(t, m) {
    if (t.status !== 'running' || m.status === 'done' || !m.a || !m.b) return;
    m.status = 'playing';
    if (m.a.bot && m.b.bot) {
      // bot contra bot: resultado simulado según rating
      const pa = 1 / (1 + 10 ** ((m.b.rating - m.a.rating) / 400));
      const winner = Math.random() < pa ? m.a : m.b;
      this.later(() => this.finishMatch(t, m, winner, 'simulada'), between(this.cfg.botSimMs));
      this.broadcast(t);
      return;
    }
    this.openGame(t, m);
  }

  openGame(t, m) {
    // Colores: la partida n alterna (empates → se repite con los colores cambiados).
    const swap = m.draws % 2 === 1;
    const white = swap ? m.b : m.a;
    const black = swap ? m.a : m.b;
    const room = this.rooms.create({
      tcId: t.tc,
      rated: false,
      colorPref: 'w',
      reserved: { w: white.id, b: black.id },
      strict: true,
      circuit: { id: t.id, round: m.round, label: this.cfg.rounds[m.round] },
    });
    m.room = room;
    m.code = room.code;
    room.onOver = (r) => this.onGameOver(t, m, r);
    for (const [e, role] of [[white, 'w'], [black, 'b']]) {
      if (!e.bot) continue;
      const ws = makeBotSocket(room, { id: e.id, name: e.name, rating: e.rating, games: 99 }, role, () => between(this.cfg.botMoveMs));
      room.seat({ id: e.id, name: e.name, rating: e.rating, games: 99 }, ws);
      ws.meta.role = role;
    }
    for (const e of [m.a, m.b]) {
      if (e.bot) continue;
      for (const ws of e.socks) ws.readyState === 1 && ws.send(JSON.stringify({ t: 'circuit_match', code: room.code, round: m.round, label: this.cfg.rounds[m.round], opponent: (e === m.a ? m.b : m.a).name }));
    }
    clearTimeout(m.timer);
    m.timer = this.later(() => this.noShow(t, m, room), this.cfg.noShowMs);
    room.broadcast();
    this.broadcast(t);
  }

  // Quien no se sienta a tiempo pierde; si ninguno aparece, pasa el mejor cabeza de serie.
  noShow(t, m, room) {
    if (m.status !== 'playing' || m.room !== room || room.status !== 'waiting') return;
    const here = [m.a, m.b].filter((e) => room.hasPlayer(e.id));
    if (here.length === 2) return;
    const winner = here[0] ?? (m.a.seed < m.b.seed ? m.a : m.b);
    m.room = null; // así el gancho de fin de sala no lo toma por un empate
    room.end(null, 'abortada');
    this.finishMatch(t, m, winner, here.length ? 'incomparecencia' : 'ninguno se presentó');
  }

  onGameOver(t, m, room) {
    if (m.status !== 'playing' || m.room !== room) return;
    clearTimeout(m.timer);
    const winnerRole = room.result?.winner;
    if (winnerRole) {
      const id = room.players[winnerRole]?.id;
      const winner = [m.a, m.b].find((e) => e.id === id);
      if (winner) return this.finishMatch(t, m, winner, room.result.reason);
    }
    // Tablas o partida abortada: se repite con los colores cambiados; al agotarse, decide el cabeza de serie.
    m.draws += 1;
    if (m.draws >= this.cfg.maxDraws) return this.finishMatch(t, m, m.a.seed < m.b.seed ? m.a : m.b, 'desempate por cabeza de serie');
    this.later(() => this.openGame(t, m), 2500);
    return undefined;
  }

  finishMatch(t, m, winner, reason) {
    if (m.status === 'done') return;
    clearTimeout(m.timer);
    m.status = 'done';
    m.winner = winner;
    m.reason = reason;
    const loser = winner === m.a ? m.b : m.a;
    loser.out = true;
    loser.placement = PLACEMENTS[m.round];
    const next = t.rounds[m.round + 1]?.[m.slot >> 1];
    if (next) {
      if (m.slot % 2 === 0) next.a = winner;
      else next.b = winner;
      if (next.a && next.b) this.later(() => this.startMatch(t, next), this.cfg.intermissionMs);
      this.broadcast(t);
    } else {
      this.finish(t, winner);
    }
  }

  finish(t, champion) {
    t.status = 'finished';
    t.champion = champion;
    t.finishedAt = Date.now();
    champion.placement = 'champion';
    const results = t.entrants
      .filter((e) => !e.bot)
      .map((e) => ({ userId: e.id, placement: e.placement, ...this.cfg.prizes[e.placement] }));
    try {
      this.db.saveTournament({
        id: t.id,
        tc: t.tc,
        size: t.size,
        champion: champion.name,
        bracket: JSON.stringify(this.bracketOf(t)),
        createdAt: t.createdAt,
        finishedAt: t.finishedAt,
        results,
      });
    } catch (err) {
      console.error('[circuit] no se pudo guardar el torneo', err);
    }
    this.broadcast(t);
    this.later(() => this.tournaments.delete(t.id), this.cfg.keepFinishedMs);
  }

  // ----- Vistas -----
  entrantView(e) {
    return e && { id: e.id, name: e.name, rating: e.rating, bot: e.bot, seed: e.seed, out: e.out };
  }

  bracketOf(t) {
    return t.rounds.map((round) =>
      round.map((m) => ({ a: this.entrantView(m.a), b: this.entrantView(m.b), winner: m.winner?.id ?? null, reason: m.reason })),
    );
  }

  view(t, userId = null) {
    const mine = userId ? t.entrants.find((e) => e.id === userId) : null;
    const liveMatch = mine && t.rounds.flat().find((m) => m.status === 'playing' && (m.a?.id === mine.id || m.b?.id === mine.id));
    return {
      id: t.id,
      status: t.status,
      tc: t.tc,
      size: t.size,
      roundNames: this.cfg.rounds,
      fillInMs: t.status === 'registering' ? Math.max(0, t.fillAt - Date.now()) : 0,
      entrants: t.entrants.map((e) => this.entrantView(e)),
      matches: t.rounds.map((round) =>
        round.map((m) => ({
          id: m.id,
          a: this.entrantView(m.a),
          b: this.entrantView(m.b),
          status: m.status,
          code: m.status === 'playing' ? m.code : null,
          winner: m.winner?.id ?? null,
          reason: m.reason,
          draws: m.draws,
        })),
      ),
      champion: t.champion ? this.entrantView(t.champion) : null,
      you: mine ? { id: mine.id, out: mine.out, placement: mine.placement, prize: mine.placement ? this.cfg.prizes[mine.placement] : null, matchCode: liveMatch?.code ?? null } : null,
    };
  }

  pushTo(e, t) {
    const msg = JSON.stringify({ t: 'circuit_state', circuit: this.view(t, e.id) });
    for (const ws of e.socks) ws.readyState === 1 && ws.send(msg);
  }

  broadcast(t) {
    for (const e of t.entrants) if (!e.bot) this.pushTo(e, t);
  }

  // Vista pública para el lobby: inscripción abierta y partidas en directo que se pueden ver.
  publicView() {
    const all = [...this.tournaments.values()];
    const open = all.find((t) => t.status === 'registering');
    return {
      size: this.cfg.size,
      tc: this.cfg.tc,
      open: open ? { id: open.id, joined: open.entrants.length, names: open.entrants.map((e) => e.name), fillInMs: Math.max(0, open.fillAt - Date.now()) } : null,
      running: all
        .filter((t) => t.status === 'running')
        .map((t) => ({
          id: t.id,
          round: t.rounds.findIndex((r) => r.some((m) => m.status !== 'done')),
          live: t.rounds.flat().filter((m) => m.status === 'playing' && m.code).map((m) => ({ code: m.code, a: m.a.name, b: m.b.name, label: this.cfg.rounds[m.round] })),
        })),
      champions: this.db.recentChampions(5),
    };
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
