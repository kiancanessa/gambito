// Fase 3: historial y repeticiones. Solo ven una partida quienes la jugaron.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
let app;
let base;

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES });
  base = `http://127.0.0.1:${app.port}`;
});
after(() => app.close());

const json = { 'Content-Type': 'application/json' };
const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
const get = (g, p) => fetch(`${base}${p}`, g ? { headers: { Authorization: `Bearer ${g.token}` } } : {});

async function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const f = msgs.find(pred);
        if (f) return resolve(f);
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push({ test: pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    close: () => ws.close(),
  };
  c.send({ t: 'auth', token });
  await c.waitFor((m) => m.t === 'authed');
  return c;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('historial y repeticiones: solo los participantes, con jugadas y resultado correctos', async () => {
  const [a, b, outsider] = [await guest('Repite1'), await guest('Repite2'), await guest('Curioso')];
  assert.equal((await get(a, '/api/me/games')).status, 200);
  assert.deepEqual((await (await get(a, '/api/me/games')).json()).games, []);
  assert.equal((await get(null, '/api/me/games')).status, 401);

  const [ca, cb] = [await connect(a.token), await connect(b.token)];
  ca.send({ t: 'create', tc: 'blitz5', color: 'w' });
  const { code } = await ca.waitFor((m) => m.t === 'created');
  cb.send({ t: 'join', code });
  await cb.waitFor((m) => m.t === 'state' && m.status === 'playing');
  const moves = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  for (const [i, uci] of moves.entries()) {
    (i % 2 === 0 ? ca : cb).send({ t: 'move', uci });
    await pause(80);
  }
  await ca.waitFor((m) => m.t === 'state' && m.status === 'over');
  await pause(100);

  const la = (await (await get(a, '/api/me/games')).json()).games;
  const lb = (await (await get(b, '/api/me/games')).json()).games;
  assert.equal(la.length, 1);
  assert.equal(la[0].result, 'win');
  assert.equal(lb[0].result, 'loss');
  assert.equal(la[0].opponent, 'Repite2');
  assert.equal(la[0].plies, 7);
  assert.equal(la[0].you, 'w');
  assert.equal(lb[0].you, 'b');

  const full = (await (await get(a, `/api/games/${la[0].id}`)).json()).game;
  assert.deepEqual(full.moves, moves);
  assert.equal(full.white.name, 'Repite1');
  assert.equal(full.winner, 'w');
  assert.equal((await (await get(b, `/api/games/${la[0].id}`)).json()).game.you, 'b');

  assert.equal((await get(outsider, `/api/games/${la[0].id}`)).status, 404, 'un ajeno no la ve');
  assert.equal((await get(null, `/api/games/${la[0].id}`)).status, 401);
  assert.equal((await get(a, '/api/games/no-existe-esta-partida')).status, 404);
  assert.deepEqual((await (await get(outsider, '/api/me/games')).json()).games, []);
  ca.close();
  cb.close();
});
