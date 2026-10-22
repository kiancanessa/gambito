// Integridad del ajedrez por WebSocket real (PROMPT 10): el servidor es la autoridad sobre asientos, turnos, jugadas, resultado y puntos.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { LIMITS } from '../server/config.js';
import { startServer } from '../server/index.js';

LIMITS.guestsPerHour = 100_000;
let app;
let base;
before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0 });
  base = `http://127.0.0.1:${app.port}`;
});
after(() => app.close());

let n = 0;
const guest = async (name = 'Int') => (await (await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${name}${++n}` }) })).json());
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const rating = async (g) => (await (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${g.token}` } })).json()).user.rating;
const gamesIn = (code) => app.db.raw.prepare('SELECT COUNT(*) AS n FROM games WHERE code = ?').get(code).n;

async function connect(g) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  const c = {
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    last: (pred = () => true) => msgs.filter(pred).at(-1),
    state: () => msgs.filter((m) => m.t === 'state').at(-1),
    waitFor: async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const f = msgs.find(pred);
        if (f) return f;
        await pause(15);
      }
      throw new Error('timeout');
    },
    close: () => ws.close(),
  };
  c.send({ t: 'auth', token: g.token });
  await c.waitFor((m) => m.t === 'authed');
  return c;
}

// Dos jugadores en una partida con amigos ya en marcha (blancas = a).
async function table(tc = 'none') {
  const [a, b] = [await guest('Blanca'), await guest('Negra')];
  const [ca, cb] = [await connect(a), await connect(b)];
  ca.send({ t: 'create', tc, color: 'w' });
  const { code } = await ca.waitFor((m) => m.t === 'created');
  cb.send({ t: 'join', code });
  await cb.waitFor((m) => m.t === 'state' && m.status === 'playing');
  return { a, b, ca, cb, code, close: () => [ca, cb].forEach((c) => c.close()) };
}

describe('asientos y turnos', () => {
  test('un tercero que entra a una partida llena es espectador y no puede mover, rendir ni ofrecer tablas', async () => {
    const t = await table();
    const c = await guest('Colado');
    const cc = await connect(c);
    cc.send({ t: 'join', code: t.code });
    const st = await cc.waitFor((m) => m.t === 'state');
    assert.equal(st.you, 's');
    for (const m of [{ t: 'move', uci: 'e2e4' }, { t: 'resign' }, { t: 'draw', action: 'offer' }, { t: 'draw', action: 'accept' }, { t: 'rematch' }]) cc.send(m);
    await pause(150);
    assert.deepEqual(t.ca.state().moves, []);
    assert.equal(t.ca.state().status, 'playing');
    assert.equal(t.ca.state().drawOffer, null);
    t.close();
    cc.close();
  });

  test('fuera de turno, jugada ilegal y pieza ajena se rechazan y la partida no cambia', async () => {
    const t = await table();
    t.cb.send({ t: 'move', uci: 'e7e5' }); // las negras no pueden abrir
    t.ca.send({ t: 'move', uci: 'e2e5' }); // salto de peón
    t.ca.send({ t: 'move', uci: 'e7e5' }); // pieza del rival
    t.ca.send({ t: 'move', uci: 'a1a8' }); // torre bloqueada
    await pause(200);
    assert.deepEqual(t.ca.state().moves, []);
    t.ca.send({ t: 'move', uci: 'e2e4' });
    await t.cb.waitFor((m) => m.t === 'state' && m.moves?.length === 1);
    t.ca.send({ t: 'move', uci: 'd2d4' }); // otra vez las blancas
    await pause(150);
    assert.deepEqual(t.cb.state().moves, ['e2e4']);
    t.close();
  });

  test('la misma cuenta en dos pestañas: la jugada duplicada se aplica una sola vez', async () => {
    const t = await table();
    const tab2 = await connect(t.a);
    tab2.send({ t: 'join', code: t.code });
    await tab2.waitFor((m) => m.t === 'state' && m.you === 'w');
    t.ca.send({ t: 'move', uci: 'e2e4' });
    tab2.send({ t: 'move', uci: 'e2e4' });
    await pause(200);
    assert.deepEqual(t.cb.state().moves, ['e2e4']);
    t.close();
    tab2.close();
  });

  test('quien se desconecta y vuelve recupera su asiento; un tercero no puede ocuparlo', async () => {
    const t = await table();
    t.ca.send({ t: 'move', uci: 'e2e4' });
    t.cb.send({ t: 'move', uci: 'e7e5' });
    await pause(100);
    t.ca.close();
    await t.cb.waitFor((m) => m.t === 'state' && m.players?.w?.online === false);
    const intruder = await connect(await guest('Intruso'));
    intruder.send({ t: 'join', code: t.code });
    assert.equal((await intruder.waitFor((m) => m.t === 'state')).you, 's', 'el asiento libre de las blancas no se puede ocupar');
    const back = await connect(t.a);
    back.send({ t: 'join', code: t.code });
    const st = await back.waitFor((m) => m.t === 'state' && m.you === 'w');
    assert.deepEqual(st.moves, ['e2e4', 'e7e5']);
    back.send({ t: 'move', uci: 'g1f3' });
    await t.cb.waitFor((m) => m.t === 'state' && m.moves?.length === 3);
    t.cb.close();
    intruder.close();
    back.close();
  });
});

describe('resultado y puntos: una sola vez', () => {
  test('rendirse repetidas veces, o rendirse tras el mate, no duplica la partida ni mueve el Elo dos veces', async () => {
    const [a, b] = [await guest('RankA'), await guest('RankB')];
    const [ca, cb] = [await connect(a), await connect(b)];
    ca.send({ t: 'queue', tc: 'blitz5' });
    cb.send({ t: 'queue', tc: 'blitz5' });
    const st = await ca.waitFor((m) => m.t === 'state' && m.status === 'playing', 5000);
    const [white, black] = st.you === 'w' ? [ca, cb] : [cb, ca];
    const script = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5', 'c6a5', 'c4b5', 'c7c6', 'd5c6', 'b7c6', 'b5e2', 'h7h6', 'g5f3', 'e5e4', 'f3e5', 'f8d6'];
    for (const [i, uci] of script.entries()) {
      (i % 2 === 0 ? white : black).send({ t: 'move', uci });
      await pause(25);
    }
    for (let i = 0; i < 6; i += 1) black.send({ t: 'resign' });
    await white.waitFor((m) => m.t === 'state' && m.status === 'over');
    await pause(150);
    const code = st.code;
    assert.equal(gamesIn(code), 1, 'se guardó una sola partida');
    const finished = white.state();
    assert.equal(finished.result.reason, 'rendición');
    const [ra, rb] = [await rating(a), await rating(b)];
    for (let i = 0; i < 4; i += 1) {
      white.send({ t: 'resign' });
      black.send({ t: 'resign' });
      white.send({ t: 'draw', action: 'offer' });
      white.send({ t: 'move', uci: 'a2a3' });
    }
    await pause(200);
    assert.equal(gamesIn(code), 1);
    assert.deepEqual([await rating(a), await rating(b)], [ra, rb], 'ningún mensaje posterior cambia los puntos');
    assert.notEqual(ra, rb);
    ca.close();
    cb.close();
  });

  test('tras el mate la sala no admite más jugadas ni cambia el resultado', async () => {
    const t = await table();
    for (const [i, uci] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
      (i % 2 === 0 ? t.ca : t.cb).send({ t: 'move', uci });
      await pause(40);
    }
    await t.ca.waitFor((m) => m.t === 'state' && m.status === 'over');
    const before = t.ca.state();
    assert.deepEqual(before.result, { winner: 'b', reason: 'jaque mate' });
    t.ca.send({ t: 'move', uci: 'a2a3' });
    t.ca.send({ t: 'resign' });
    t.cb.send({ t: 'move', uci: 'a7a6' });
    await pause(150);
    assert.deepEqual(t.ca.state().result, before.result);
    assert.deepEqual(t.ca.state().moves, before.moves);
    t.close();
  });
});
