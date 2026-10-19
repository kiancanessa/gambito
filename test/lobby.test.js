// Fase 1: partidas en vivo para el lobby (solo clasificatorias; las de amigos son privadas).
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

const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();

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

test('/api/live lista las partidas clasificatorias en curso y oculta las de amigos', async () => {
  assert.deepEqual((await (await fetch(`${base}/api/live`)).json()).games, []);

  const [a, b, c, d] = [await guest('LiveUno'), await guest('LiveDos'), await guest('AmigoUno'), await guest('AmigoDos')];
  const [ca, cb, cc, cd] = [await connect(a.token), await connect(b.token), await connect(c.token), await connect(d.token)];

  // partida con amigo: privada
  cc.send({ t: 'create', tc: 'blitz5', color: 'w' });
  const { code: friendCode } = await cc.waitFor((m) => m.t === 'created');
  cd.send({ t: 'join', code: friendCode });
  await cd.waitFor((m) => m.t === 'state' && m.status === 'playing');

  // clasificatoria: pública
  ca.send({ t: 'queue', tc: 'blitz3' });
  cb.send({ t: 'queue', tc: 'blitz3' });
  const { code } = await ca.waitFor((m) => m.t === 'matched');

  const live = (await (await fetch(`${base}/api/live`)).json()).games;
  assert.equal(live.length, 1);
  assert.equal(live[0].code, code);
  assert.equal(live[0].tc, 'blitz3');
  assert.deepEqual([live[0].w.name, live[0].b.name].sort(), ['LiveDos', 'LiveUno']);
  assert.ok(!live.some((g) => g.code === friendCode), 'las partidas con amigo no se listan');
  assert.equal(typeof live[0].spectators, 'number');

  // cuando termina, desaparece de la lista
  const whiteIsA = (await ca.waitFor((m) => m.t === 'state' && m.code === code)).you === 'w';
  (whiteIsA ? ca : cb).send({ t: 'move', uci: 'e2e4' });
  await new Promise((r) => setTimeout(r, 100));
  (whiteIsA ? cb : ca).send({ t: 'move', uci: 'e7e5' });
  await new Promise((r) => setTimeout(r, 100));
  (whiteIsA ? cb : ca).send({ t: 'resign' });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual((await (await fetch(`${base}/api/live`)).json()).games, []);
  [ca, cb, cc, cd].forEach((x) => x.close());
});
