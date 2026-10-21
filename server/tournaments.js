// Royale Circuit: torneos eliminatorios programados por un organizador automático (sin salas de usuario y sin bots).
//
// Ciclo de vida:  scheduled (programado) → open (inscripción abierta) → closed (inscripción cerrada) → running (en curso)
//                 → finished (finalizado)   ·   cancelled (cancelado: menos jugadores presentes que el mínimo)
//
// · El organizador mantiene siempre el siguiente torneo de cada formato (`CIRCUIT.formats`), alineado al reloj.
// · Un único `tick()` mueve los estados según la hora; nada depende de temporizadores sueltos, así que un reinicio
//   del servidor se recupera leyendo la base de datos (`recover`).
// · Cuadro de eliminación simple (bracket.js). Con menos inscritos que plazas, los mejores cabezas de serie pasan la primera ronda con «bye».
// · Las partidas son salas normales (`Room`) con asientos reservados. El servidor decide cada resultado; el cliente nunca declara nada.
// · Toda escritura que cambia el cuadro pasa por transacciones con comprobación de estado (circuit-store.js).
//
// Desempate (explícito): una partida sin ganador (tablas o abortada) se repite con los colores cambiados; tras `maxDraws`
// empates sin decisión, pasa el mejor cabeza de serie (mayor rating al inscribirse; a igualdad, quien se inscribió antes).
// Incomparecencia: quien no se sienta en su sala en `noShowMs` pierde; si no aparece ninguno, pasa el mejor cabeza de serie.
// Desconexión durante la partida: la sala da 45 s de gracia y después da la victoria al rival (rooms.js).
import crypto from 'node:crypto';
import { bySeed, firstRound, nextSlot, placementOf, roundName } from './bracket.js';

const MIN = 60_000;
export const CIRCUIT = {
  formats: [
    { id: 'blitz8', name: 'Royale Blitz', size: 8, minPlayers: 4, tc: 'blitz3_2', everyMs: 20 * MIN },
    { id: 'rapid16', name: 'Royale Rapid', size: 16, minPlayers: 8, tc: 'rapid10', everyMs: 60 * MIN },
  ],
  autoSchedule: true,
  openLeadMs: 15 * MIN, // la inscripción se abre, como mucho, 15 min antes del inicio
  closeLeadMs: 1 * MIN, // y se cierra 1 min antes (ese margen sirve para comprobar quién está conectado)
  minLeadMs: 2 * MIN, // el organizador no programa torneos que empiecen antes de este margen
  fullStartDelayMs: 30_000, // si se llenan las plazas, se cierra la inscripción y empieza 30 s después
  firstMatchDelayMs: 5_000,
  intermissionMs: 10_000, // pausa entre rondas
  rematchMs: 2_500, // pausa antes de repetir una partida sin ganador
  noShowMs: 60_000, // tiempo para sentarse en la sala de tu partida
  restartGraceMs: 25_000, // tras un reinicio: margen para que los jugadores vuelvan a conectarse
  maxDraws: 3,
  keepFinishedMs: 5 * MIN, // cuánto sigue un torneo terminado en memoria (después se lee de la base de datos)
  tickMs: 1000,
  rounds: null, // (reservado)
  // Premios por puesto. Todo cosmético o monedas: nunca ventaja de juego. Se cobran con la cartera verificada (fuente `circuit`).
  prizes: {
    r32: { coins: 15, xp: 15 },
    r16: { coins: 20, xp: 20 },
    quarter: { coins: 30, xp: 30 },
    semi: { coins: 60, xp: 60 },
    final: { coins: 120, xp: 120 },
    champion: { coins: 250, xp: 250, item: 'set:royal' },
  },
};

export const RULES = {
  draw: 'Si una partida termina en tablas o se aborta, se repite con los colores cambiados.',
  tiebreak: 'Tras 3 partidas sin ganador pasa el mejor cabeza de serie (mayor rating al inscribirse; a igualdad, quien se inscribió antes).',
  noShow: 'Quien no entra a su partida en 60 s la pierde. Si no aparece ninguno, pasa el mejor cabeza de serie.',
  disconnect: 'Si te desconectas en plena partida tienes 45 s para volver; después gana tu rival.',
  byes: 'Con menos inscritos que plazas, los mejores cabezas de serie pasan la primera ronda sin jugar.',
  presence: 'Al cerrarse la inscripción solo siguen quienes están conectados; si no se llega al mínimo, el torneo se cancela.',
};

const MESSAGES = {
  unknown: 'Ese torneo ya no existe',
  closed: 'La inscripción de este torneo está cerrada',
  already: 'Ya estás inscrito en este torneo',
  busy: 'Ya participas en otro torneo del Circuit',
  full: 'El torneo está completo',
  notin: 'No estás inscrito en este torneo',
  limit: 'Demasiadas solicitudes seguidas',
};
export const circuitMessage = (reason) => MESSAGES[reason] ?? 'No se pudo completar la acción';

const LIVE = new Set(['scheduled', 'open', 'closed', 'running']);

export class CircuitManager {
  /**
   * @param {object} o
   * @param {import('./rooms.js').RoomManager} o.rooms
   * @param {ReturnType<import('./db.js').openDb>} o.db
   * @param {object} [o.options]  sobrescribe `CIRCUIT` (pruebas)
   */
  constructor({ rooms, db, options = {}, metrics = { inc() {} }, progression = null }) {
    this.rooms = rooms;
    this.progression = progression;
    this.metrics = metrics;
    this.db = db;
    this.store = db.circuit;
    this.cfg = { ...CIRCUIT, ...options };
    this.tournaments = new Map();
    this.watchers = new Set(); // sockets suscritos a la lista en tiempo real
    this.timers = new Set();
    this.holdUntil = 0; // tras un reinicio no se arranca ningún torneo hasta que los jugadores han podido reconectar
    this.listTimer = null;
    this.closed = false;
    this.recover(Date.now());
    this.tick(Date.now());
    this.ticker = setInterval(() => this.tick(Date.now()), this.cfg.tickMs);
    this.ticker.unref?.();
  }

  // ===== Recuperación tras un reinicio =====
  recover(now) {
    for (const row of this.store.loadLive()) {
      const t = this.hydrate(row);
      if (t.status === 'running') {
        // Las salas viven en memoria y se pierden: las partidas en juego se repiten desde cero (mismos colores, mismos empates acumulados).
        for (const m of t.matches.flat()) {
          if (m.status === 'playing') {
            m.status = 'ready';
            m.code = null;
            this.store.setMatch(t.id, m.round, m.slot, { status: 'ready', draws: m.draws }, now);
          }
          if (m.status === 'ready') m.readyAt = now + this.cfg.restartGraceMs;
        }
      }
      this.tournaments.set(t.id, t);
      this.holdUntil = now + this.cfg.restartGraceMs;
    }
  }

  // Construye el torneo en memoria a partir de filas de la base de datos (las cuentas atrás y las salas son transitorias).
  hydrate(row) {
    const t = {
      id: row.id,
      format: row.format,
      name: row.name,
      tc: row.tc,
      size: row.size,
      minPlayers: row.min_players,
      status: row.status,
      regOpensAt: row.reg_opens_at,
      regClosesAt: row.reg_closes_at,
      startsAt: row.starts_at,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      championId: row.champion_id,
      cancelReason: row.cancel_reason,
      rounds: row.rounds,
      entries: new Map(),
      matches: [],
    };
    for (const e of row.entries) {
      t.entries.set(e.user_id, { id: e.user_id, name: e.name, rating: e.rating, seed: e.seed, status: e.status, placement: e.placement, joinedAt: e.joined_at, socks: new Set() });
    }
    for (let r = 0; r < t.rounds; r += 1) t.matches.push([]);
    for (const m of row.matches) {
      t.matches[m.round][m.slot] = { id: `${m.round}-${m.slot}`, round: m.round, slot: m.slot, aId: m.a_id, bId: m.b_id, status: m.status, winnerId: m.winner_id, reason: m.reason, draws: m.draws, code: m.code, room: null, readyAt: 0, noShowAt: 0 };
    }
    return t;
  }

  // ===== Utilidades =====
  later(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  // La progresión nunca debe romper un torneo.
  safe(fn) {
    try {
      fn();
    } catch (err) {
      console.error('[circuit] progresión', err);
    }
  }

  entry(t, id) {
    return id ? (t.entries.get(id) ?? null) : null;
  }

  registered(t) {
    return [...t.entries.values()].filter((e) => e.status === 'registered');
  }

  // Torneo vivo en el que está el usuario (inscrito o compitiendo).
  active(userId) {
    for (const t of this.tournaments.values()) {
      if (!LIVE.has(t.status)) continue;
      const e = t.entries.get(userId);
      if (e && (e.status === 'registered' || e.status === 'active')) return { t, e };
    }
    return null;
  }

  // ===== Organizador automático =====
  ensureSchedule(now) {
    if (!this.cfg.autoSchedule) return;
    for (const f of this.cfg.formats) {
      const pending = [...this.tournaments.values()].some((t) => t.format === f.id && ['scheduled', 'open', 'closed'].includes(t.status));
      if (pending) continue;
      let startsAt = (Math.floor(now / f.everyMs) + 1) * f.everyMs;
      while (startsAt - now < this.cfg.minLeadMs) startsAt += f.everyMs;
      this.schedule(f, startsAt, now);
    }
  }

  /** Programa un torneo de un formato. La inscripción se abre `openLeadMs` antes y se cierra `closeLeadMs` antes del inicio. */
  schedule(format, startsAt, now = Date.now()) {
    const f = typeof format === 'string' ? this.cfg.formats.find((x) => x.id === format) : format;
    if (!f) throw new Error('formato de torneo desconocido');
    const regOpensAt = Math.max(now, startsAt - this.cfg.openLeadMs);
    const t = {
      id: crypto.randomUUID(),
      format: f.id,
      name: f.name,
      tc: f.tc,
      size: f.size,
      minPlayers: f.minPlayers,
      status: now >= regOpensAt ? 'open' : 'scheduled',
      regOpensAt,
      regClosesAt: Math.max(regOpensAt, startsAt - this.cfg.closeLeadMs),
      startsAt,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      championId: null,
      cancelReason: null,
      rounds: 0,
      entries: new Map(),
      matches: [],
    };
    this.store.create({ id: t.id, format: t.format, name: t.name, tc: t.tc, size: t.size, minPlayers: t.minPlayers, status: t.status, regOpensAt, regClosesAt: t.regClosesAt, startsAt, createdAt: now });
    this.tournaments.set(t.id, t);
    this.broadcastList();
    return t;
  }

  // ===== Reloj =====
  tick(now) {
    for (const t of [...this.tournaments.values()]) {
      try {
        this.advance(t, now);
      } catch (err) {
        console.error('[circuit] error al avanzar el torneo', t.id, err);
      }
    }
    this.ensureSchedule(now);
  }

  advance(t, now) {
    switch (t.status) {
      case 'scheduled':
        if (now >= t.regOpensAt && this.store.update(t.id, { status: 'open' }, ['scheduled'])) {
          t.status = 'open';
          this.broadcast(t);
        }
        break;
      case 'open':
        if (now >= t.regClosesAt) this.closeRegistration(t, now);
        break;
      case 'closed':
        if (now >= t.startsAt && now >= this.holdUntil) this.begin(t, now);
        break;
      case 'running':
        for (const m of t.matches.flat()) {
          if (m.status === 'ready' && now >= m.readyAt) this.startMatch(t, m, now);
          else if (m.status === 'playing' && m.room && m.room.status === 'waiting' && now >= m.noShowAt) this.noShow(t, m, m.room, now);
        }
        break;
      default:
        if (t.finishedAt && now - t.finishedAt > this.cfg.keepFinishedMs) this.tournaments.delete(t.id);
    }
  }

  closeRegistration(t, now, { full = false } = {}) {
    const startsAt = full ? Math.min(t.startsAt, now + this.cfg.fullStartDelayMs) : t.startsAt;
    if (!this.store.update(t.id, { status: 'closed', reg_closes_at: Math.min(t.regClosesAt, now), starts_at: startsAt }, ['open'])) return;
    t.status = 'closed';
    t.regClosesAt = Math.min(t.regClosesAt, now);
    t.startsAt = startsAt;
    this.broadcast(t);
  }

  // ===== Inscripción =====
  join(user, tid, ws) {
    const t = this.tournaments.get(tid);
    if (!t) return { ok: false, reason: 'unknown' };
    const now = Date.now();
    const res = this.store.register(tid, user, now);
    if (!res.ok) return res;
    t.entries.set(user.id, { id: user.id, name: user.name, rating: user.rating ?? 1000, seed: null, status: 'registered', placement: null, joinedAt: now, socks: new Set(ws ? [ws] : []) });
    if (res.count >= t.size) this.closeRegistration(t, now, { full: true });
    this.broadcast(t);
    return res;
  }

  leave(user, tid) {
    const t = this.tournaments.get(tid);
    if (!t) return { ok: false, reason: 'unknown' };
    const res = this.store.withdraw(tid, user.id, Date.now());
    if (res.ok) {
      t.entries.delete(user.id);
      this.broadcast(t);
    }
    return res;
  }

  // Asocia el socket a los torneos del usuario (al identificarse o reconectar) y le envía el estado y su partida pendiente.
  attach(user, ws) {
    let any = false;
    for (const t of this.tournaments.values()) {
      const e = t.entries.get(user.id);
      if (!e || !LIVE.has(t.status)) continue;
      e.socks.add(ws);
      any = true;
      this.pushTo(e, t);
      const m = this.pendingMatchOf(t, user.id);
      if (m) this.sendMatch(t, m, e, ws);
    }
    return any;
  }

  pendingMatchOf(t, userId) {
    return t.matches.flat().find((m) => m.status === 'playing' && m.room && m.room.status !== 'over' && (m.aId === userId || m.bId === userId)) ?? null;
  }

  detachSocket(ws) {
    this.watchers.delete(ws);
    for (const t of this.tournaments.values()) for (const e of t.entries.values()) e.socks.delete(ws);
  }

  // ===== Arranque =====
  begin(t, now) {
    const entries = this.registered(t);
    const present = entries.filter((e) => e.socks.size > 0);
    const absent = entries.filter((e) => e.socks.size === 0);
    if (present.length < t.minPlayers) {
      this.cancel(t, `Jugadores insuficientes: ${present.length} conectados de ${t.minPlayers} necesarios`, now);
      return;
    }
    present.sort(bySeed);
    const plan = firstRound(present.length);
    const matches = Array.from({ length: plan.rounds }, (_, r) =>
      Array.from({ length: plan.size / 2 ** (r + 1) }, (__, slot) => ({ round: r, slot, aId: null, bId: null, status: 'pending', winnerId: null, reason: null })),
    );
    for (const f of plan.first) {
      const m = matches[0][f.slot];
      m.aId = f.a === null ? null : present[f.a].id;
      m.bId = f.b === null ? null : present[f.b].id;
      if (f.bye) {
        m.status = 'done';
        m.winnerId = m.aId ?? m.bId;
        m.reason = 'bye';
      } else m.status = 'ready';
    }
    // Los pases directos (bye) ya ocupan su plaza en la segunda ronda.
    for (const m of matches[0]) {
      if (m.reason !== 'bye' || !matches[1]) continue;
      const to = nextSlot(m.slot);
      matches[1][to.slot][`${to.side}Id`] = m.winnerId;
    }
    if (matches[1]) for (const m of matches[1]) if (m.aId && m.bId) m.status = 'ready';
    const res = this.store.start({
      tid: t.id,
      absent: absent.map((e) => e.id),
      seeds: present.map((e, i) => ({ id: e.id, seed: i + 1 })),
      matches: matches.flat(),
      rounds: plan.rounds,
      now,
    });
    if (!res.ok) return;
    this.metrics.inc('circuit_started_total');
    this.safe(() => this.progression?.recordCircuitJoin(present.map((e) => e.id), t.id));
    for (const e of absent) e.status = 'absent';
    present.forEach((e, i) => {
      e.status = 'active';
      e.seed = i + 1;
    });
    t.status = 'running';
    t.startedAt = now;
    t.rounds = plan.rounds;
    t.matches = matches.map((round) =>
      round.map((m) => ({ id: `${m.round}-${m.slot}`, ...m, draws: 0, code: null, room: null, readyAt: m.status === 'ready' ? now + this.cfg.firstMatchDelayMs : 0, noShowAt: 0 })),
    );
    this.broadcast(t);
  }

  cancel(t, reason, now = Date.now()) {
    if (!this.store.cancel(t.id, reason, now)) return false;
    this.metrics.inc('circuit_cancelled_total');
    t.status = 'cancelled';
    t.cancelReason = reason;
    t.finishedAt = now;
    this.broadcast(t);
    return true;
  }

  // ===== Partidas =====
  startMatch(t, m, now) {
    if (t.status !== 'running' || m.status !== 'ready' || !m.aId || !m.bId) return;
    // Colores: la partida alterna con cada repetición (empate → se repite con los colores cambiados).
    const swap = m.draws % 2 === 1;
    const white = this.entry(t, swap ? m.bId : m.aId);
    const black = this.entry(t, swap ? m.aId : m.bId);
    const room = this.rooms.create({
      tcId: t.tc,
      rated: false,
      colorPref: 'w',
      reserved: { w: white.id, b: black.id },
      strict: true,
      circuit: { id: t.id, round: m.round, label: roundName(m.round, t.rounds), tournament: t.name },
    });
    m.status = 'playing';
    m.room = room;
    m.code = room.code;
    m.noShowAt = now + this.cfg.noShowMs;
    room.onOver = (r) => this.onGameOver(t, m, r);
    this.store.setMatch(t.id, m.round, m.slot, { status: 'playing', code: m.code, draws: m.draws }, now);
    for (const e of [white, black]) for (const ws of e.socks) this.sendMatch(t, m, e, ws);
    room.broadcast();
    this.broadcast(t);
  }

  sendMatch(t, m, e, ws) {
    if (ws.readyState !== 1) return;
    const rival = this.entry(t, e.id === m.aId ? m.bId : m.aId);
    ws.send(JSON.stringify({ t: 'circuit_match', code: m.code, tournament: t.id, round: m.round, label: roundName(m.round, t.rounds), opponent: rival?.name ?? '' }));
  }

  // Quien no se sienta a tiempo pierde; si ninguno aparece, pasa el mejor cabeza de serie.
  noShow(t, m, room, now) {
    if (m.status !== 'playing' || m.room !== room || room.status !== 'waiting') return;
    const here = [m.aId, m.bId].filter((id) => room.hasPlayer(id));
    if (here.length === 2) return;
    const winnerId = here[0] ?? this.higherSeed(t, m);
    m.room = null; // así el gancho de fin de sala no lo toma por un empate
    room.end(null, 'abortada');
    this.finishMatch(t, m, winnerId, here.length ? 'incomparecencia' : 'ninguno se presentó', now);
  }

  higherSeed(t, m) {
    return this.entry(t, m.aId).seed < this.entry(t, m.bId).seed ? m.aId : m.bId;
  }

  onGameOver(t, m, room) {
    if (m.status !== 'playing' || m.room !== room) return;
    const now = Date.now();
    const winnerId = room.result?.winner ? room.players[room.result.winner]?.id : null;
    if (winnerId && (winnerId === m.aId || winnerId === m.bId)) {
      this.finishMatch(t, m, winnerId, room.result.reason, now);
      return;
    }
    // Tablas o partida abortada: se repite con los colores cambiados; al agotarse, decide el cabeza de serie.
    m.draws += 1;
    if (m.draws >= this.cfg.maxDraws) {
      this.finishMatch(t, m, this.higherSeed(t, m), 'desempate por cabeza de serie', now);
      return;
    }
    m.status = 'ready';
    m.room = null;
    m.readyAt = now + this.cfg.rematchMs;
    this.store.setMatch(t.id, m.round, m.slot, { status: 'ready', draws: m.draws }, now);
    this.broadcast(t);
  }

  /** Cierra un partido. Si otra llamada ya lo cerró, la base de datos lo rechaza y no pasa nada (sin dobles avances). */
  finishMatch(t, m, winnerId, reason, now = Date.now()) {
    if (m.status === 'done') return false;
    const loserId = winnerId === m.aId ? m.bId : m.aId;
    const placement = placementOf(m.round, t.rounds);
    const nxt = m.round + 1 < t.rounds ? { round: m.round + 1, ...nextSlot(m.slot) } : null;
    let res;
    try {
      res = this.store.completeMatch({ tid: t.id, round: m.round, slot: m.slot, winnerId, loserId, reason, placement, next: nxt, now });
    } catch (err) {
      console.error('[circuit] no se pudo cerrar el partido', t.id, m.id, err);
      return false;
    }
    if (!res.ok) return false;
    m.status = 'done';
    m.winnerId = winnerId;
    m.reason = reason;
    m.room = null;
    const loser = this.entry(t, loserId);
    loser.status = 'out';
    loser.placement = placement;
    if (nxt) {
      const next = t.matches[nxt.round][nxt.slot];
      next[`${nxt.side}Id`] = winnerId;
      if (res.ready) {
        next.status = 'ready';
        next.readyAt = now + this.cfg.intermissionMs;
      }
      this.broadcast(t);
    } else {
      this.finish(t, winnerId, now);
    }
    return true;
  }

  finish(t, championId, now) {
    const champion = this.entry(t, championId);
    champion.placement = 'champion';
    const players = [...t.entries.values()].filter((e) => e.placement || e.id === championId);
    const results = players.map((e) => ({ userId: e.id, placement: e.placement, ...(this.cfg.prizes[e.placement] ?? {}) }));
    t.championId = championId; // el puesto del campeón ya está fijado; la base de datos lo confirma en `finish`
    const legacy = { tc: t.tc, size: t.size, champion: champion.name, bracket: JSON.stringify(this.bracketOf(t)), createdAt: t.createdAt };
    let res;
    try {
      res = this.store.finish({ tid: t.id, championId, now, legacy, results });
    } catch (err) {
      console.error('[circuit] no se pudo cerrar el torneo', t.id, err);
      return;
    }
    if (!res.ok) return;
    this.metrics.inc('circuit_finished_total');
    this.safe(() => this.progression?.recordCircuitResults(results.map((r) => ({ userId: r.userId, placement: r.placement, xp: r.xp ?? 0 })), t.id));
    champion.status = 'champion';
    t.status = 'finished';
    t.finishedAt = now;
    this.broadcast(t);
  }

  // ===== Vistas =====
  entrantView(e) {
    return e && { id: e.id, name: e.name, rating: e.rating, seed: e.seed, status: e.status, placement: e.placement };
  }

  bracketOf(t) {
    return t.matches.map((round) =>
      round.map((m) => ({ a: this.entrantView(this.entry(t, m.aId)), b: this.entrantView(this.entry(t, m.bId)), winner: m.winnerId, reason: m.reason })),
    );
  }

  roundNames(t) {
    return Array.from({ length: t.rounds }, (_, r) => roundName(r, t.rounds));
  }

  summary(t) {
    const all = [...t.entries.values()];
    const players = t.status === 'open' || t.status === 'scheduled' || t.status === 'closed' ? all.filter((e) => e.status === 'registered').length : all.filter((e) => ['active', 'out', 'champion'].includes(e.status)).length;
    const current = t.status === 'running' ? t.matches.findIndex((r) => r.some((m) => m.status !== 'done')) : -1;
    const champion = this.entry(t, t.championId);
    return {
      id: t.id,
      format: t.format,
      name: t.name,
      tc: t.tc,
      size: t.size,
      minPlayers: t.minPlayers,
      status: t.status,
      players,
      regOpensAt: t.regOpensAt,
      regClosesAt: t.regClosesAt,
      startsAt: t.startsAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      rounds: t.rounds,
      round: current,
      roundName: current >= 0 ? roundName(current, t.rounds) : null,
      champion: champion ? { id: champion.id, name: champion.name } : null,
      cancelReason: t.cancelReason,
      live: t.matches.flat().filter((m) => m.status === 'playing' && m.code).length,
    };
  }

  view(t, userId = null) {
    const mine = this.entry(t, userId);
    const matchCode = mine && t.matches.flat().find((m) => m.status === 'playing' && m.code && (m.aId === mine.id || m.bId === mine.id))?.code;
    return {
      ...this.summary(t),
      now: Date.now(),
      roundNames: this.roundNames(t),
      entrants: [...t.entries.values()].filter((e) => e.status !== 'absent').sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.joinedAt - b.joinedAt).map((e) => this.entrantView(e)),
      matches: t.matches.map((round) =>
        round.map((m) => ({
          id: m.id,
          round: m.round,
          slot: m.slot,
          a: this.entrantView(this.entry(t, m.aId)),
          b: this.entrantView(this.entry(t, m.bId)),
          status: m.status,
          bye: m.reason === 'bye',
          code: m.status === 'playing' ? m.code : null,
          winner: m.winnerId,
          reason: m.reason,
          draws: m.draws,
        })),
      ),
      rules: RULES,
      prizes: this.cfg.prizes,
      you: mine
        ? { id: mine.id, status: mine.status, out: mine.status === 'out', placement: mine.placement, prize: mine.placement ? (this.cfg.prizes[mine.placement] ?? null) : null, matchCode: matchCode ?? null }
        : null,
    };
  }

  // Torneo por id: de memoria si está vivo; si no, leído (solo lectura) de la base de datos.
  get(id) {
    const live = this.tournaments.get(id);
    if (live) return live;
    const row = this.store.load(id);
    return row ? this.hydrate(row) : null;
  }

  detail(id, userId = null) {
    const t = typeof id === 'string' && id.length <= 64 ? this.get(id) : null;
    return t ? this.view(t, userId) : null;
  }

  listView(userId = null) {
    const live = [...this.tournaments.values()].filter((t) => LIVE.has(t.status)).sort((a, b) => a.startsAt - b.startsAt);
    const mine = userId ? (this.active(userId)?.t.id ?? null) : null;
    return {
      now: Date.now(),
      formats: this.cfg.formats.map((f) => ({ id: f.id, name: f.name, size: f.size, minPlayers: f.minPlayers, tc: f.tc, everyMs: f.everyMs })),
      tournaments: live.map((t) => ({ ...this.summary(t), joined: ['registered', 'active'].includes(t.entries.get(userId)?.status) })),
      mine,
      recent: this.store.recent(8).map((r) => ({ id: r.id, name: r.name, tc: r.tc, size: r.size, status: r.status, finishedAt: r.finished_at, cancelReason: r.cancel_reason, champion: r.champion_name, players: r.players })),
      champions: this.db.recentChampions(5),
      rules: RULES,
      prizes: this.cfg.prizes,
    };
  }

  // Vista pública (API y lobby): el siguiente torneo por formato y los campeones recientes.
  publicView() {
    return this.listView(null);
  }

  // ===== Tiempo real =====
  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  pushTo(e, t) {
    const msg = JSON.stringify({ t: 'circuit_state', circuit: this.view(t, e.id) });
    for (const ws of e.socks) if (ws.readyState === 1) ws.send(msg);
  }

  // Cambió un torneo: se avisa a sus inscritos, a quien lo está mirando y se refresca la lista.
  broadcast(t) {
    const sent = new Set();
    for (const e of t.entries.values()) {
      if (!e.socks.size) continue;
      this.pushTo(e, t);
      for (const ws of e.socks) sent.add(ws);
    }
    let anon = null;
    for (const ws of this.watchers) {
      if (sent.has(ws) || ws.meta?.cview !== t.id) continue;
      anon ??= JSON.stringify({ t: 'circuit_state', circuit: this.view(t, null) });
      if (ws.readyState === 1) ws.send(anon);
    }
    this.broadcastList();
  }

  broadcastList() {
    if (this.listTimer || this.closed) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      for (const ws of this.watchers) this.send(ws, { t: 'circuit_list', list: this.listView(ws.meta?.user?.id ?? null) });
    }, 150);
    this.listTimer.unref?.();
  }

  /** Suscribe el socket a la lista en tiempo real y, opcionalmente, al detalle de un torneo. */
  watch(ws, id = null) {
    this.watchers.add(ws);
    ws.meta.cview = typeof id === 'string' ? id : null;
    this.send(ws, { t: 'circuit_list', list: this.listView(ws.meta.user?.id ?? null) });
    if (ws.meta.cview) {
      const v = this.detail(ws.meta.cview, ws.meta.user?.id ?? null);
      this.send(ws, { t: 'circuit_state', circuit: v });
    }
  }

  unwatch(ws) {
    this.watchers.delete(ws);
    ws.meta.cview = null;
  }

  close() {
    this.closed = true;
    clearInterval(this.ticker);
    clearTimeout(this.listTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
