// Fase 4: Royale Circuit (torneo eliminatorio de 8, bajo demanda) con bots, partidas reales y premios por cartera.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { CIRCUIT, chooseBotMove } from '../server/tournaments.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
const FAST = { fillAfterMs: 400, intermissionMs: 60, noShowMs: 1500, botMoveMs: [0, 4], botSimMs: [20, 60], maxDraws: 2, keepFinishedMs: 60_000 };
let app;
let base;

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES, circuitOptions: FAST });
  base = `http://127.0.0.1:${app.port}`;
});
after(() => app.close());

const json = { 'Content-Type': 'application/json' };
const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
const auth = (g) => ({ ...json, Authorization: `Bearer ${g.token}` });
const getJson = async (g, p) => (await fetch(`${base}${p}`, g ? { headers: auth(g) } : {})).json();

// Cliente de pruebas: se identifica y, si `plays`, entra solo en cada partida del torneo y juega con el bot.
async function player(g, { plays = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const log = [];
  const waiters = [];
  const c = { log, circuit: null, ws, you: {} };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    log.push(m);
    if (m.t === 'circuit_state') c.circuit = m.circuit;
    if (plays && m.t === 'circuit_match') ws.send(JSON.stringify({ t: 'join', code: m.code }));
    if (plays && m.t === 'state' && m.circuit && m.status === 'playing' && m.turn === m.you) {
      const uci = chooseBotMove(m.fen);
      if (uci) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'move', uci })), 140); // por debajo del límite de 40 mensajes / 5 s
    }
    waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
  });
  await new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.waitFor = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const f = log.find(pred);
      if (f) return resolve(f);
      const t = setTimeout(() => reject(new Error('timeout esperando mensaje')), ms);
      waiters.push({ test: pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  c.send({ t: 'auth', token: g.token });
  await c.waitFor((m) => m.t === 'authed');
  return c;
}

const waitUntil = async (fn, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condición no cumplida a tiempo');
};

describe('bot de torneo', () => {
  test('juega jugadas legales, da mate en 1 y no regala mate en 1', () => {
    // mate del pasillo en 1: Ra8#
    assert.equal(chooseBotMove('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'), 'a1a8');
    assert.equal(chooseBotMove('7k/8/8/8/8/8/8/K7 b - - 0 1') !== null, true);
    assert.equal(chooseBotMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), null, 'sin jugadas (ahogado/mate)');
  });
});

describe('Royale Circuit', { timeout: 200_000 }, () => {
  test('inscripción: se rellena con bots, se juega el cuadro entero y se pagan los premios', async () => {
    const g = await guest('Aspirante');
    const stranger = await guest('Intruso');
    const p = await player(g);
    const s = await player(stranger, { plays: false });

    assert.equal((await getJson(null, '/api/circuit')).open, null);
    p.send({ t: 'circuit_join' });
    const reg = await p.waitFor((m) => m.t === 'circuit_state' && m.circuit?.status === 'registering');
    assert.equal(reg.circuit.entrants.length, 1);
    assert.equal(reg.circuit.you.id, g.user.id);
    const open = (await getJson(null, '/api/circuit')).open;
    assert.equal(open.joined, 1);
    assert.deepEqual(open.names, ['Aspirante']);

    // se arranca al vencer fillAfterMs: 7 bots, cuadro de 4 + 2 + 1
    const running = await p.waitFor((m) => m.t === 'circuit_state' && m.circuit?.status === 'running', 3000);
    assert.equal(running.circuit.entrants.length, 8);
    assert.equal(running.circuit.entrants.filter((e) => e.bot).length, 7);
    assert.deepEqual(running.circuit.matches.map((r) => r.length), [4, 2, 1]);
    const seeds = running.circuit.entrants.map((e) => e.seed).sort((a, b) => a - b);
    assert.deepEqual(seeds, [1, 2, 3, 4, 5, 6, 7, 8]);
    const names = running.circuit.entrants.map((e) => e.name);
    assert.equal(new Set(names).size, 8, 'sin nombres repetidos');

    // su primera partida es una sala normal, con asientos reservados: un intruso solo puede mirar
    const match = await p.waitFor((m) => m.t === 'circuit_match', 5000);
    assert.equal(match.label, 'Cuartos de final');
    s.send({ t: 'join', code: match.code });
    const seen = await s.waitFor((m) => m.t === 'state' && m.code === match.code);
    assert.equal(seen.you, 's', 'un ajeno no ocupa un asiento reservado');
    assert.equal(seen.circuit.round, 0);
    assert.equal(seen.rated, false);

    // el torneo termina solo
    const done = await waitUntil(() => (p.circuit?.status === 'finished' ? p.circuit : null), 150_000);
    assert.ok(done.champion);
    assert.ok(done.matches.flat().every((m) => m.status === 'done' || m.a === null || m.b === null || m.status === 'done'));
    assert.equal(done.matches[2][0].status, 'done');
    assert.ok(['quarter', 'semi', 'final', 'champion'].includes(done.you.placement) || done.champion.id === g.user.id);

    // premios: guardados en el servidor y cobrables una sola vez por la cartera verificada
    const mine = (await getJson(g, '/api/circuit/me')).results;
    assert.equal(mine.length, 1);
    const placement = mine[0].placement;
    assert.deepEqual(
      { coins: mine[0].coins, item: mine[0].item },
      { coins: CIRCUIT.prizes[placement].coins, item: CIRCUIT.prizes[placement].item ?? null },
    );
    const claim = (oid) => fetch(`${base}/api/wallet/ops`, { method: 'POST', headers: auth(g), body: JSON.stringify({ ops: [{ oid, t: 'earn', source: 'circuit', key: `circuit:${mine[0].id}` }] }) }).then((r) => r.json());
    const first = await claim('c1');
    assert.equal(first.results[0].ok, true);
    assert.equal(first.wallet.coins, 100 + mine[0].coins);
    if (placement === 'champion') assert.ok(first.wallet.owned.includes('set:royal'), 'el campeón recibe el set exclusivo');
    else assert.ok(!first.wallet.owned.includes('set:royal'));
    assert.equal((await claim('c2')).results[0].reason, 'dup');
    // nadie más puede cobrar ese premio
    const rob = await fetch(`${base}/api/wallet/ops`, { method: 'POST', headers: auth(stranger), body: JSON.stringify({ ops: [{ oid: 'x', t: 'earn', source: 'circuit', key: `circuit:${mine[0].id}` }] }) }).then((r) => r.json());
    assert.equal(rob.results[0].reason, 'unverified');

    const pub = await getJson(null, '/api/circuit');
    assert.ok(pub.champions.length >= 1);
    p.ws.close();
    s.ws.close();
  });

  test('incomparecencia: quien no se sienta a tiempo pierde y pasa el rival', async () => {
    const g = await guest('Fantasma');
    const p = await player(g, { plays: false }); // recibe la partida pero nunca entra
    p.send({ t: 'circuit_join' });
    await p.waitFor((m) => m.t === 'circuit_match', 5000);
    const out = await waitUntil(() => (p.circuit?.you?.out ? p.circuit : null), 15_000);
    assert.equal(out.you.placement, 'quarter');
    const lost = out.matches[0].find((m) => m.a?.id === g.user.id || m.b?.id === g.user.id);
    assert.equal(lost.reason, 'incomparecencia');
    assert.notEqual(lost.winner, g.user.id);
    p.ws.close();
  });

  test('salir en inscripción libera la plaza y no se puede cobrar un premio inexistente', async () => {
    const g = await guest('Indeciso');
    const p = await player(g, { plays: false });
    p.send({ t: 'circuit_join' });
    await p.waitFor((m) => m.t === 'circuit_state' && m.circuit?.status === 'registering');
    p.send({ t: 'circuit_leave' });
    await p.waitFor((m) => m.t === 'circuit_state' && m.circuit === null);
    assert.equal((await getJson(null, '/api/circuit')).open, null);
    const r = await fetch(`${base}/api/wallet/ops`, { method: 'POST', headers: auth(g), body: JSON.stringify({ ops: [{ oid: 'z', t: 'earn', source: 'circuit', key: 'circuit:no-existe' }] }) }).then((x) => x.json());
    assert.equal(r.results[0].reason, 'unverified');
    p.ws.close();
  });

  test('el set del premio no se puede comprar ni importar desde un guardado', async () => {
    const g = await guest('Listo');
    await fetch(`${base}/api/save`, { method: 'PUT', headers: auth(g), body: JSON.stringify({ data: { coins: 5000, owned: ['set:royal'] }, updatedAt: 1 }) });
    const w = (await getJson(g, '/api/wallet')).wallet;
    assert.ok(!w.owned.includes('set:royal'));
    const r = await fetch(`${base}/api/wallet/ops`, { method: 'POST', headers: auth(g), body: JSON.stringify({ ops: [{ oid: 'b', t: 'buy', kind: 'set', id: 'royal' }] }) }).then((x) => x.json());
    assert.equal(r.results[0].reason, 'exclusive');
  });
});
