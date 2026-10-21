// Royale Circuit: organizador automático, estados, inscripciones, cuadro de eliminación simple, partidas reales,
// incomparecencias, empates, byes, no-duplicación de resultados, recuperación tras reinicio y tiempo real.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { CIRCUIT } from '../server/tournaments.js';
import { chooseBotMove } from './helpers/practice-bot.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
const FORMAT = { id: 't8', name: 'Torneo de prueba', size: 8, minPlayers: 4, tc: 'blitz3_2', everyMs: 1e9 };
// Tiempos cortos para pruebas; `autoSchedule: false` (cada prueba programa sus torneos a mano, nada se inventa).
const FAST = { autoSchedule: false, formats: [FORMAT], openLeadMs: 60_000, closeLeadMs: 200, minLeadMs: 0, fullStartDelayMs: 250, firstMatchDelayMs: 100, intermissionMs: 100, rematchMs: 60, noShowMs: 1500, restartGraceMs: 300, maxDraws: 2, tickMs: 25, keepFinishedMs: 60_000 };
// «Manual»: los partidos no arrancan solos; las pruebas cierran los partidos desde el servidor para controlar el cuadro.
const MANUAL = { ...FAST, firstMatchDelayMs: 1e9, intermissionMs: 1e9, noShowMs: 1e9 };

const apps = [];
const dirs = [];
async function start(options = FAST, extra = {}) {
  const app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES, circuitOptions: options, metricsLogMs: 0, ...extra });
  apps.push(app);
  app.base = `http://127.0.0.1:${app.port}`;
  return app;
}
after(async () => {
  await Promise.allSettled(apps.map((a) => a.close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const json = { 'Content-Type': 'application/json' };
const guest = async (app, name) => (await fetch(`${app.base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
const auth = (g) => ({ ...json, Authorization: `Bearer ${g.token}` });
const getJson = async (app, g, p) => (await fetch(`${app.base}${p}`, g ? { headers: auth(g) } : {})).json();
const waitUntil = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condición no cumplida a tiempo');
};

// Cliente de pruebas por WebSocket: se identifica y, si `plays`, entra solo en sus partidas del torneo y juega.
async function player(app, g, { plays = true, resignWhenBehind = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const log = [];
  const c = { log, ws, circuit: null, user: g.user, states: [], lists: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    log.push(m);
    if (m.t === 'circuit_state') {
      c.circuit = m.circuit;
      c.states.push(m.circuit);
    }
    if (m.t === 'circuit_list') c.lists.push(m.list);
    if (plays && m.t === 'circuit_match') ws.send(JSON.stringify({ t: 'join', code: m.code }));
    if (plays && m.t === 'state' && m.circuit && m.status === 'playing' && m.turn === m.you) {
      // Para que el cuadro entero se juegue en segundos: tras unas jugadas, el de número mayor (Jug7 frente a Jug3) se rinde.
      // Es una acción legítima de cliente: el servidor es quien registra la victoria del rival.
      const num = (n) => Number(String(n ?? '').replace(/\D/g, '')) || 0;
      const me = num(m.players[m.you]?.name);
      const rival = num(m.players[m.you === 'w' ? 'b' : 'w']?.name);
      if (resignWhenBehind && m.moves.length >= 6 && me > rival) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'resign' })), 135);
      else {
        const uci = chooseBotMove(m.fen);
        if (uci) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'move', uci })), 135); // por debajo del límite de 40 mensajes / 5 s
      }
    }
  });
  await new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.waitFor = (pred, ms = 5000) => waitUntil(() => log.find(pred), ms);
  c.send({ t: 'auth', token: g.token });
  await c.waitFor((m) => m.t === 'authed');
  return c;
}

// Jugador «de mentira» para pruebas internas: un usuario real de la base de datos con un socket falso.
let seq = 0;
function human(app, name, rating = 1000) {
  const id = `h-${++seq}-${name}`;
  app.db.createUser({ id, name, tokenHash: `hash-${id}`, recoveryHash: null });
  const ws = { readyState: 1, sent: [], meta: {}, send(raw) { this.sent.push(JSON.parse(raw)); } };
  return { user: { id, name, rating }, ws };
}
const open = (app, over = {}, startsInMs = 1500) => app.circuit.schedule({ ...FORMAT, ...over }, Date.now() + startsInMs);
const joinAll = (app, t, names, ratings = []) => names.map((n, i) => {
  const h = human(app, n, ratings[i] ?? 1500 - i * 10);
  assert.equal(app.circuit.join(h.user, t.id, h.ws).ok, true, `${n} se inscribe`);
  return h;
});
// Cierra desde el servidor todos los partidos listos con el cabeza de serie mejor como ganador, hasta coronar campeón.
function playOut(app, t) {
  for (let guard = 0; guard < 40 && t.status === 'running'; guard += 1) {
    for (const m of t.matches.flat()) {
      if (m.status !== 'done' && m.aId && m.bId) app.circuit.finishMatch(t, m, app.circuit.higherSeed(t, m), 'prueba');
    }
  }
}

describe('organizador y estados', () => {
  test('el organizador programa siempre el siguiente torneo de cada formato, alineado al reloj y sin inventar participantes', async () => {
    const app = await start({ ...FAST, autoSchedule: true, minLeadMs: 1000, formats: [{ ...FORMAT, everyMs: 60_000 }, { ...FORMAT, id: 'r16', name: 'Rapid 16', size: 16, minPlayers: 8, everyMs: 3_600_000 }] });
    const list = (await getJson(app, null, '/api/circuit')).tournaments;
    assert.deepEqual(list.map((t) => t.format).sort(), ['r16', 't8']);
    for (const t of list) {
      assert.ok(['scheduled', 'open'].includes(t.status));
      assert.equal(t.players, 0, 'nadie inscrito: nada inventado');
      assert.equal(t.startsAt % (t.format === 'r16' ? 3_600_000 : 60_000), 0, 'empieza en una marca del reloj');
      assert.ok(t.startsAt - t.regOpensAt <= FAST.openLeadMs && t.startsAt > t.regClosesAt);
    }
    // tick repetido: no se duplican torneos
    app.circuit.tick(Date.now());
    app.circuit.tick(Date.now());
    assert.equal((await getJson(app, null, '/api/circuit')).tournaments.length, 2);
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) AS n FROM circuit_tournaments').get().n, 2);
  });

  test('programado → inscripción abierta → cerrada → cancelado, cada uno a su hora', async () => {
    const app = await start({ ...FAST, openLeadMs: 700, closeLeadMs: 300 });
    const t = app.circuit.schedule(FORMAT, Date.now() + 1600);
    assert.equal(t.status, 'scheduled');
    assert.deepEqual(app.circuit.join(human(app, 'Temprano').user, t.id, null), { ok: false, reason: 'closed' }, 'antes de abrir no se admite');
    await waitUntil(() => t.status === 'open', 3000);
    assert.ok(Date.now() >= t.regOpensAt);
    await waitUntil(() => t.status === 'closed', 3000);
    assert.ok(Date.now() >= t.regClosesAt - 30);
    await waitUntil(() => t.status === 'cancelled', 3000);
    assert.match(t.cancelReason, /insuficientes/);
    assert.equal(app.circuit.store.load(t.id).status, 'cancelled');
  });
});

describe('inscripciones', () => {
  test('por WebSocket: duplicada, otro torneo, salir, fuera de plazo y torneo inexistente', async () => {
    const app = await start(MANUAL);
    const t1 = open(app, {}, 5000);
    const t2 = open(app, { id: 't8b' }, 5000);
    const g = await guest(app, 'Inscrito');
    const p = await player(app, g, { plays: false });

    p.send({ t: 'circuit_join', id: t1.id });
    const joined = await p.waitFor((m) => m.t === 'circuit_state' && m.circuit?.you?.status === 'registered');
    assert.equal(joined.circuit.players, 1);
    assert.equal(joined.circuit.entrants[0].id, g.user.id);

    p.send({ t: 'circuit_join', id: t1.id });
    assert.equal((await p.waitFor((m) => m.t === 'circuit_error' && m.reason === 'already')).id, t1.id);
    p.send({ t: 'circuit_join', id: t2.id });
    await p.waitFor((m) => m.t === 'circuit_error' && m.reason === 'busy');
    p.send({ t: 'circuit_join', id: 'no-existe' });
    await p.waitFor((m) => m.t === 'circuit_error' && m.reason === 'unknown');

    p.send({ t: 'circuit_leave', id: t1.id });
    await waitUntil(() => p.circuit?.id === t1.id && p.circuit.you === null && p.circuit.players === 0);
    p.send({ t: 'circuit_join', id: t2.id }); // libre otra vez
    await waitUntil(() => p.circuit?.id === t2.id && p.circuit.you?.status === 'registered');

    // se cierra la inscripción: ya no se puede salir ni entrar otro
    app.circuit.closeRegistration(t2, Date.now());
    p.send({ t: 'circuit_leave', id: t2.id });
    await p.waitFor((m) => m.t === 'circuit_error' && m.reason === 'closed' && m.id === t2.id);
    const late = await player(app, await guest(app, 'Tardio'), { plays: false });
    late.send({ t: 'circuit_join', id: t2.id });
    await late.waitFor((m) => m.t === 'circuit_error' && m.reason === 'closed');
    assert.equal(app.circuit.registered(t2).length, 1);
    p.ws.close();
    late.ws.close();
  });

  test('al llenarse el cupo se cierra la inscripción y empieza poco después; el siguiente ya no entra', async () => {
    const app = await start(MANUAL);
    const t = open(app, {}, 60_000);
    const hs = joinAll(app, t, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    assert.equal(t.status, 'closed', 'lleno → inscripción cerrada');
    assert.ok(t.startsAt - Date.now() <= FAST.fullStartDelayMs + 50, 'empieza pronto en vez de esperar a la hora prevista');
    const extra = human(app, 'Noveno');
    assert.equal(app.circuit.join(extra.user, t.id, extra.ws).ok, false);
    await waitUntil(() => t.status === 'running', 3000);
    assert.equal(hs.length, 8);
    assert.deepEqual(t.matches.map((r) => r.length), [4, 2, 1]);
  });
});

describe('arranque, ausentes y byes', () => {
  test('quien no está conectado al cerrar la inscripción queda fuera; si no se llega al mínimo, se cancela', async () => {
    const app = await start(MANUAL);
    // 3 de 4 conectados, mínimo 3: sigue sin el ausente
    const t = open(app, { minPlayers: 3 }, 700);
    const hs = joinAll(app, t, ['uno', 'dos', 'tres', 'cuatro']);
    app.circuit.detachSocket(hs[3].ws);
    await waitUntil(() => t.status === 'running', 4000);
    assert.equal(t.entries.get(hs[3].user.id).status, 'absent');
    assert.equal(app.circuit.view(t).entrants.length, 3, 'el ausente no figura en el cuadro');
    assert.deepEqual(t.matches.map((r) => r.length), [2, 1], 'con 3 jugadores, cuadro de 4 con un bye');
    // mínimo 4, solo 3 presentes: cancelado
    const t2 = open(app, { id: 't8c', minPlayers: 4 }, 700);
    const hs2 = joinAll(app, t2, ['w', 'x', 'y', 'z']);
    app.circuit.detachSocket(hs2[0].ws);
    await waitUntil(() => t2.status === 'cancelled', 4000);
    assert.match(t2.cancelReason, /3 conectados de 4/);
    assert.equal(app.circuit.active(hs2[1].user.id), null, 'los inscritos de un torneo cancelado quedan libres');
    const free = open(app, { id: 't8d' }, 5000);
    assert.equal(app.circuit.join(hs2[1].user, free.id, hs2[1].ws).ok, true, 'y pueden apuntarse a otro');
  });

  test('con 5 jugadores en un cuadro de 8: tres byes para los mejores cabezas de serie y nadie juega dos veces seguidas', async () => {
    const app = await start(MANUAL);
    const t = open(app, {}, 600);
    const hs = joinAll(app, t, ['s1', 's2', 's3', 's4', 's5'], [1900, 1800, 1700, 1600, 1500]);
    await waitUntil(() => t.status === 'running', 4000);
    const first = t.matches[0];
    assert.equal(first.filter((m) => m.reason === 'bye').length, 3);
    const byes = first.filter((m) => m.reason === 'bye').map((m) => app.circuit.entry(t, m.winnerId).seed).sort();
    assert.deepEqual(byes, [1, 2, 3]);
    assert.equal(first.filter((m) => m.status !== 'done').length, 1, 'solo juegan 4º y 5º');
    const played = first.find((m) => m.status !== 'done');
    assert.deepEqual([app.circuit.entry(t, played.aId).seed, app.circuit.entry(t, played.bId).seed].sort(), [4, 5]);
    // los de bye ya figuran en la segunda ronda
    const second = t.matches[1].flatMap((m) => [m.aId, m.bId]).filter(Boolean);
    assert.equal(second.length, 3);
    // se juega todo: el cabeza de serie 1 gana, los puestos corresponden a la ronda de caída
    playOut(app, t);
    assert.equal(t.status, 'finished');
    assert.equal(t.championId, hs[0].user.id);
    const place = Object.fromEntries(hs.map((h) => [h.user.name, app.circuit.entry(t, h.user.id).placement]));
    assert.deepEqual(place, { s1: 'champion', s2: 'final', s3: 'semi', s4: 'semi', s5: 'quarter' });
  });
});

describe('integridad del cuadro', () => {
  test('un resultado duplicado no hace avanzar dos veces al ganador ni da la vuelta al marcador', async () => {
    const app = await start(MANUAL);
    const t = open(app, { minPlayers: 4 }, 600);
    const hs = joinAll(app, t, ['a', 'b', 'c', 'd']);
    await waitUntil(() => t.status === 'running', 4000);
    const m = t.matches[0][0];
    const [w, l] = [m.aId, m.bId];
    assert.equal(app.circuit.finishMatch(t, m, w, 'mate'), true);
    // la segunda llamada (otro proceso, un temporizador y el fin de sala a la vez...) se descarta
    assert.equal(app.circuit.finishMatch(t, m, w, 'mate'), false);
    assert.equal(app.circuit.finishMatch(t, { ...m, status: 'playing' }, l, 'mate'), false, 'ni siquiera con el estado en memoria desfasado');
    assert.equal(m.winnerId, w);
    const next = t.matches[1][0];
    assert.equal([next.aId, next.bId].filter((x) => x === w).length, 1, 'el ganador ocupa una sola plaza');
    const rows = app.db.raw.prepare('SELECT a_id, b_id, status FROM circuit_matches WHERE tournament_id = ? AND round = 1').get(t.id);
    assert.equal([rows.a_id, rows.b_id].filter((x) => x === w).length, 1);
    assert.equal(app.circuit.entry(t, l).status, 'out');
    assert.equal(hs.length, 4);
  });

  test('el cliente no puede declarar resultados, tocar el cuadro ni inscribir a otro', async () => {
    const app = await start(MANUAL);
    const t = open(app, {}, 600);
    const hs = joinAll(app, t, ['a', 'b', 'c', 'd']);
    await waitUntil(() => t.status === 'running', 4000);
    const g = await guest(app, 'Tramposo');
    const p = await player(app, g, { plays: false });
    const snapshot = () => JSON.stringify({ ...app.circuit.view(t), now: 0 });
    const before = snapshot();
    const m = t.matches[0][0];
    for (const msg of [
      { t: 'circuit_result', id: t.id, winner: m.aId },
      { t: 'circuit_advance', id: t.id, round: 0, slot: 0, winner: m.bId },
      { t: 'circuit_bracket', id: t.id, matches: [[]] },
      { t: 'circuit_finish', id: t.id, champion: g.user.id },
      { t: 'circuit_join', id: t.id, user: { id: hs[0].user.id, name: 'x', rating: 9999 } },
      { t: 'circuit_join', id: t.id }, // el torneo ya está en curso: no admite inscripciones
      { t: 'circuit_leave', id: t.id },
      { t: 'resign', code: 'XXXX' },
    ]) p.send(msg);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(snapshot(), before, 'el cuadro sigue idéntico');
    assert.equal(t.entries.has(g.user.id), false);
    assert.ok(p.log.some((x) => x.t === 'circuit_error' && x.reason === 'closed'), 'la inscripción a un torneo en curso se rechaza');
    p.ws.close();
  });

  test('empates: se repite con los colores cambiados y, agotados, pasa el mejor cabeza de serie', async () => {
    const app = await start({ ...MANUAL, firstMatchDelayMs: 50, rematchMs: 50, noShowMs: 1e9 });
    const t = open(app, {}, 600);
    const hs = joinAll(app, t, ['alto', 'medio', 'bajo', 'ultimo'], [1900, 1700, 1500, 1300]);
    await waitUntil(() => t.status === 'running', 4000);
    const m = t.matches[0].find((x) => app.circuit.entry(t, x.aId).seed === 1 || app.circuit.entry(t, x.bId).seed === 1); // el seed 1 contra el 4
    await waitUntil(() => m.status === 'playing', 3000);
    const room1 = m.room;
    const w1 = room1.reserved.w;
    room1.end(null, 'tablas'); // sin ganador
    await waitUntil(() => m.status === 'playing' && m.room !== room1, 3000);
    assert.equal(m.draws, 1);
    assert.equal(m.room.reserved.b, w1, 'colores cambiados en la repetición');
    m.room.end(null, 'tablas');
    // maxDraws = 2: decide el cabeza de serie
    await waitUntil(() => m.status === 'done', 3000);
    assert.equal(m.reason, 'desempate por cabeza de serie');
    assert.equal(app.circuit.entry(t, m.winnerId).seed, 1);
    assert.equal(hs.length, 4);
  });

  test('incomparecencia: quien no se sienta a tiempo pierde; si no aparece ninguno pasa el mejor cabeza de serie', async () => {
    const app = await start({ ...MANUAL, firstMatchDelayMs: 50, noShowMs: 500 });
    const t = open(app, {}, 600);
    const hs = joinAll(app, t, ['uno', 'dos', 'tres', 'cuatro'], [1900, 1800, 1700, 1600]);
    await waitUntil(() => t.status === 'running', 4000);
    const [m1, m2] = t.matches[0]; // seed1 v seed4 · seed2 v seed3
    await waitUntil(() => m1.status === 'playing' && m2.status === 'playing', 3000);
    // en el primero entra el seed 4: ocupa su asiento; el seed 1 no
    const rival = hs[3];
    m1.room.seat({ id: rival.user.id, name: rival.user.name, rating: 1600 }, { readyState: 1, send() {}, meta: {} });
    await waitUntil(() => m1.status === 'done' && m2.status === 'done', 4000);
    assert.equal(m1.reason, 'incomparecencia');
    assert.equal(m1.winnerId, rival.user.id, 'gana quien sí se presentó, aunque tenga peor seed');
    assert.equal(m2.reason, 'ninguno se presentó');
    assert.equal(app.circuit.entry(t, m2.winnerId).seed, 2);
    assert.equal(app.circuit.entry(t, hs[0].user.id).placement, 'semi');
  });
});

describe('recuperación tras un reinicio del servidor', () => {
  test('las inscripciones y el cuadro en curso sobreviven; las partidas en juego se repiten; nadie avanza dos veces', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'circuit-'));
    dirs.push(dir);
    const dbFile = path.join(dir, 'db.sqlite');
    const opts = { ...MANUAL, restartGraceMs: 150 };

    // — Servidor A: se inscriben 4 jugadores —
    let app = await start(opts, { dbFile });
    const t = open(app, {}, 900);
    const hs = joinAll(app, t, ['a', 'b', 'c', 'd'], [1900, 1800, 1700, 1600]);
    const tid = t.id;
    await app.close();

    // — Servidor B: recupera la inscripción; los jugadores reconectan y el torneo arranca —
    app = await start(opts, { dbFile });
    let r = app.circuit.tournaments.get(tid);
    assert.ok(r, 'torneo recuperado');
    assert.equal(r.entries.size, 4);
    assert.deepEqual([...r.entries.values()].map((e) => e.name).sort(), ['a', 'b', 'c', 'd']);
    for (const h of hs) assert.equal(app.circuit.attach(h.user, h.ws), true, 'al reconectar recuperan su torneo');
    assert.ok(hs[0].ws.sent.some((m) => m.t === 'circuit_state' && m.circuit.id === tid));
    await waitUntil(() => r.status === 'running', 4000);
    assert.equal(app.circuit.listView(null).tournaments.filter((x) => x.id === tid).length, 1, 'no se duplica el torneo');
    const first = r.matches[0][0];
    assert.equal(app.circuit.finishMatch(r, first, first.aId, 'mate'), true);
    r.matches[0][1].status = 'playing'; // una partida estaba en juego en el momento de caerse el servidor
    app.circuit.store.setMatch(tid, 0, 1, { status: 'playing', code: 'ZZZ999', draws: 1 }, Date.now());
    const winner1 = first.winnerId;
    await app.close();

    // — Servidor C: el partido cerrado sigue cerrado, el que estaba en juego vuelve a estar listo con sus empates —
    app = await start(opts, { dbFile });
    r = app.circuit.tournaments.get(tid);
    assert.equal(r.status, 'running');
    assert.equal(r.matches[0][0].status, 'done');
    assert.equal(r.matches[0][0].winnerId, winner1);
    assert.equal(r.matches[0][1].status, 'ready');
    assert.equal(r.matches[0][1].draws, 1);
    assert.equal(r.matches[1][0].aId === winner1 || r.matches[1][0].bId === winner1, true, 'el ganador sigue en su plaza de la final');
    assert.equal(app.circuit.finishMatch(r, r.matches[0][0], r.matches[0][0].bId, 'otra vez'), false, 'un resultado viejo no puede reescribirse');
    playOut(app, r);
    assert.equal(r.status, 'finished');
    const row = app.circuit.store.load(tid);
    assert.equal(row.status, 'finished');
    assert.equal(row.matches.filter((m) => m.status === 'done').length, 3);
    assert.equal(row.entries.filter((e) => e.placement === 'champion').length, 1);
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) AS n FROM tournament_results WHERE tournament_id = ?').get(tid).n, 4, 'un premio por jugador, una sola vez');
    assert.equal(app.db.recentChampions(1).length, 1);
  });

  test('un torneo cerrado cuyo inicio cae durante el reinicio espera a que los jugadores reconecten', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'circuit-'));
    dirs.push(dir);
    const dbFile = path.join(dir, 'db.sqlite');
    const opts = { ...MANUAL, restartGraceMs: 500 };
    let app = await start(opts, { dbFile });
    const t = open(app, {}, 300);
    const hs = joinAll(app, t, ['a', 'b', 'c', 'd']);
    const tid = t.id;
    await app.close();
    await new Promise((r) => setTimeout(r, 450)); // la hora de inicio ya pasó
    app = await start(opts, { dbFile });
    const r = app.circuit.tournaments.get(tid);
    assert.ok(['open', 'closed'].includes(r.status), 'no se cancela ni arranca sin presencia');
    for (const h of hs) app.circuit.attach(h.user, h.ws);
    await waitUntil(() => r.status === 'running', 4000);
  });
});

describe('partida completa con jugadores reales y tiempo real', { timeout: 240_000 }, () => {
  test('8 jugadores juegan el cuadro entero, cada ronda queda guardada, se paga una sola vez y la pantalla se actualiza sola', async () => {
    const app = await start(FAST);
    const t = open(app, {}, 4000);
    const gs = await Promise.all(Array.from({ length: 8 }, (_, i) => guest(app, `Jug${i + 1}`)));
    const ps = [];
    for (const g of gs) ps.push(await player(app, g, { resignWhenBehind: true }));
    const watcherGuest = await guest(app, 'Espectador');
    const watcher = await player(app, watcherGuest, { plays: false });
    watcher.send({ t: 'circuit_watch', id: t.id });
    await watcher.waitFor((m) => m.t === 'circuit_state' && m.circuit?.id === t.id);
    assert.ok(watcher.lists.length >= 1, 'recibe la lista al suscribirse');

    for (const p of ps) p.send({ t: 'circuit_join', id: t.id });
    await waitUntil(() => t.status !== 'open' && t.status !== 'scheduled', 5000);
    assert.equal([...t.entries.values()].filter((e) => e.status !== 'absent').length, 8, 'los 8 compiten');

    await waitUntil(() => t.status === 'finished', 180_000);
    assert.ok(t.championId);

    // — persistencia de cada ronda —
    const row = app.circuit.store.load(t.id);
    assert.equal(row.status, 'finished');
    assert.equal(row.matches.length, 7);
    assert.ok(row.matches.every((m) => m.status === 'done' && [m.a_id, m.b_id].includes(m.winner_id)));
    for (const round of [0, 1, 2]) {
      const ids = row.matches.filter((m) => m.round === round).flatMap((m) => [m.a_id, m.b_id]);
      assert.equal(new Set(ids).size, ids.length, `ningún jugador repetido en la ronda ${round}`);
    }
    const wins = (id) => row.matches.filter((m) => m.winner_id === id).length;
    assert.equal(wins(row.champion_id), 3, 'el campeón ganó cuartos, semifinal y final');
    const placements = row.entries.map((e) => e.placement).sort();
    assert.deepEqual(placements, ['champion', 'final', 'quarter', 'quarter', 'quarter', 'quarter', 'semi', 'semi']);

    // — tiempo real: el espectador vio el torneo cambiar sin recargar —
    await waitUntil(() => watcher.circuit?.status === 'finished', 5000);
    const seen = new Set(watcher.states.map((s) => s.status));
    assert.ok(seen.has('running') && seen.has('finished'), 'vio pasar el torneo por en curso y finalizado');
    assert.equal(watcher.circuit.champion.id, row.champion_id);
    assert.ok(watcher.states.length >= 8, 'recibió actualizaciones sucesivas');
    await waitUntil(() => watcher.lists.at(-1)?.recent.some((x) => x.id === t.id), 3000); // la lista se refresca sola, sin recargar

    // — API pública: detalle, historial y campeones —
    const detail = await getJson(app, null, `/api/circuit/t/${t.id}`);
    assert.equal(detail.status, 'finished');
    assert.equal(detail.matches[2][0].winner, row.champion_id);
    assert.equal((await fetch(`${app.base}/api/circuit/t/no-existe`)).status, 404);
    const list = await getJson(app, null, '/api/circuit');
    assert.ok(list.champions.length >= 1);
    assert.equal(list.recent[0].id, t.id);

    // — premios: guardados en el servidor y cobrables una sola vez por la cartera verificada; nadie más puede cobrar —
    const champIdx = gs.findIndex((g) => g.user.id === row.champion_id);
    const g = gs[champIdx];
    const mine = (await getJson(app, g, '/api/circuit/me')).results;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].placement, 'champion');
    assert.deepEqual({ coins: mine[0].coins, item: mine[0].item }, { coins: CIRCUIT.prizes.champion.coins, item: 'set:royal' });
    const claim = (who, oid) => fetch(`${app.base}/api/wallet/ops`, { method: 'POST', headers: auth(who), body: JSON.stringify({ ops: [{ oid, t: 'earn', source: 'circuit', key: `circuit:${mine[0].id}` }] }) }).then((r) => r.json());
    // además del premio, el servidor ha concedido por su cuenta los logros del torneo: se mide solo lo que paga el premio
    const coinsBefore = (await getJson(app, g, '/api/wallet')).wallet.coins;
    const first = await claim(g, 'c1');
    assert.equal(first.results[0].ok, true);
    assert.equal(first.wallet.coins - coinsBefore, mine[0].coins);
    assert.ok(first.wallet.owned.includes('set:royal'));
    assert.equal((await claim(g, 'c2')).results[0].reason, 'dup');
    assert.equal((await claim(watcherGuest, 'x')).results[0].reason, 'unverified', 'quien no jugó el torneo no cobra nada');
    // cada participante cobra solo lo suyo: el perdedor de cuartos recibe el premio de cuartos, no el del campeón
    const loser = gs.find((x) => x.user.id !== row.champion_id && row.entries.find((e) => e.user_id === x.user.id).placement === 'quarter');
    const loserBefore = (await getJson(app, loser, '/api/wallet')).wallet.coins;
    const own = await claim(loser, 'y');
    assert.equal(own.results[0].ok, true);
    assert.equal(own.wallet.coins - loserBefore, CIRCUIT.prizes.quarter.coins);
    assert.ok(!own.wallet.owned.includes('set:royal'));

    for (const p of [...ps, watcher]) p.ws.close();
  });
});

describe('premios y cosméticos exclusivos', () => {
  test('el set del premio no se puede comprar ni importar desde un guardado', async () => {
    const app = await start(MANUAL);
    const g = await guest(app, 'Listo');
    await fetch(`${app.base}/api/save`, { method: 'PUT', headers: auth(g), body: JSON.stringify({ data: { coins: 5000, owned: ['set:royal'] }, updatedAt: 1 }) });
    const w = (await getJson(app, g, '/api/wallet')).wallet;
    assert.ok(!w.owned.includes('set:royal'));
    const r = await fetch(`${app.base}/api/wallet/ops`, { method: 'POST', headers: auth(g), body: JSON.stringify({ ops: [{ oid: 'b', t: 'buy', kind: 'set', id: 'royal' }] }) }).then((x) => x.json());
    assert.equal(r.results[0].reason, 'exclusive');
    const none = await fetch(`${app.base}/api/wallet/ops`, { method: 'POST', headers: auth(g), body: JSON.stringify({ ops: [{ oid: 'z', t: 'earn', source: 'circuit', key: 'circuit:no-existe' }] }) }).then((x) => x.json());
    assert.equal(none.results[0].reason, 'unverified', 'no se cobra un premio inexistente');
  });
});
