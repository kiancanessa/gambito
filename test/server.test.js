import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { expectedScore, ratingChanges } from '../server/elo.js';
import { cleanName, normalizeCode } from '../server/auth.js';
import { verifySolution } from '../server/daily.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
let app;
let base;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const guest = async (name) => (await api('/api/guest', { method: 'POST', body: { name } })).json;

// Cliente WebSocket de pruebas con espera por condición.
async function connect(token) {
  const ws = new WebSocket(`ws://localhost:${app.port}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    ws,
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const found = msgs.find(pred);
        if (found) return resolve(found);
        const t = setTimeout(() => reject(new Error(`timeout esperando mensaje; últimos: ${JSON.stringify(msgs.slice(-3))}`)), ms);
        waiters.push({ test: pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    last: (type) => [...msgs].reverse().find((m) => m.t === type),
    close: () => ws.close(),
  };
  c.send({ t: 'auth', token });
  await c.waitFor((m) => m.t === 'authed');
  return c;
}

const state = (c, pred = () => true) => c.waitFor((m) => m.t === 'state' && pred(m));

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES });
  base = app.url.replace('localhost', '127.0.0.1');
});
after(async () => app.close());

describe('elo y utilidades', () => {
  test('rating simétrico y proporcional', () => {
    assert.equal(expectedScore(1000, 1000), 0.5);
    const [a, b] = ratingChanges({ rating: 1000, games: 50 }, { rating: 1000, games: 50 }, 1);
    assert.equal(a, 12);
    assert.equal(b, -12);
    const [ua] = ratingChanges({ rating: 800, games: 50 }, { rating: 1400, games: 50 }, 1);
    assert.ok(ua > 20, 'ganar siendo el débil suma mucho');
  });
  test('nombres y códigos', () => {
    assert.equal(cleanName('  Ana   María  '), 'Ana María');
    assert.equal(cleanName('x'), null);
    assert.equal(cleanName('Hitler99', 'fallback'), 'fallback');
    assert.equal(cleanName('<b>hola</b>'), 'bholab');
    assert.equal(normalizeCode('ab-cd 12'), 'ABCD12');
  });
  test('verifySolution acepta solo mates válidos', () => {
    const p = PUZZLES[0];
    assert.equal(verifySolution(p, ['a1a8']), true);
    assert.equal(verifySolution(p, ['a1a7']), false);
    assert.equal(verifySolution(p, ['a1a8', 'g8h8']), false);
    assert.equal(verifySolution(p, []), false);
    assert.equal(verifySolution(p, ['zz']), false);
  });
});

describe('cuentas y guardado', () => {
  test('crear invitado, ver perfil, renombrar y recuperar', async () => {
    const g = await guest('Tester');
    assert.ok(g.token && g.recovery && g.user.id);
    assert.equal(g.user.rating, 1000);
    assert.equal((await api('/api/me', { token: g.token })).json.user.name, 'Tester');
    assert.equal((await api('/api/me')).status, 401);

    const renamed = await api('/api/me', { method: 'PATCH', token: g.token, body: { name: 'Nuevo Nombre' } });
    assert.equal(renamed.json.user.name, 'Nuevo Nombre');
    assert.equal((await api('/api/me', { method: 'PATCH', token: g.token, body: { name: 'a' } })).status, 400);

    const rec = await api('/api/recover', { method: 'POST', body: { code: g.recovery.toLowerCase() } });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.user.id, g.user.id);
    assert.notEqual(rec.json.token, g.token);
    // el token antiguo deja de valer
    assert.equal((await api('/api/me', { token: g.token })).status, 401);
    assert.equal((await api('/api/recover', { method: 'POST', body: { code: 'AAAA-BBBB-CCCC' } })).status, 404);
  });

  test('guardado en la nube con límite de tamaño', async () => {
    const g = await guest('Saver');
    assert.deepEqual((await api('/api/save', { token: g.token })).json, { data: null, updatedAt: 0 });
    const put = await api('/api/save', { method: 'PUT', token: g.token, body: { data: { coins: 123, owned: ['a'] } } });
    assert.equal(put.status, 200);
    const got = (await api('/api/save', { token: g.token })).json;
    assert.equal(got.data.coins, 123);
    assert.equal(got.updatedAt, put.json.updatedAt);
    const big = await api('/api/save', { method: 'PUT', token: g.token, body: { data: { blob: 'x'.repeat(70_000) } } });
    assert.ok([413, 400].includes(big.status));
    assert.equal((await api('/api/save', { method: 'PUT', token: g.token, body: { data: [1] } })).status, 400);
  });
});

describe('desafío diario', () => {
  test('puzzle, envío válido, ranking y rechazo de trampas', async () => {
    const g = await guest('Dailyer');
    const day = (await api('/api/daily', { token: g.token })).json;
    assert.equal(day.fen, PUZZLES[0].fen);
    assert.equal(day.mine, null);
    assert.equal((await api('/api/daily/submit', { method: 'POST', token: g.token, body: { moves: ['a1a7'], seconds: 10, attempts: 1 } })).status, 400);
    const ok = await api('/api/daily/submit', { method: 'POST', token: g.token, body: { moves: ['a1a8'], seconds: 12.5, attempts: 2 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.mine.rank, 1);
    assert.equal(ok.json.top[0].name, 'Dailyer');
    // el primer resultado cuenta: reenviar no lo mejora
    const again = await api('/api/daily/submit', { method: 'POST', token: g.token, body: { moves: ['a1a8'], seconds: 3, attempts: 1 } });
    assert.equal(again.json.mine.seconds, 12.5);
    const fast = await guest('Rapido');
    const r2 = await api('/api/daily/submit', { method: 'POST', token: fast.token, body: { moves: ['a1a8'], seconds: 5, attempts: 1 } });
    assert.equal(r2.json.mine.rank, 1);
    assert.equal(r2.json.top[1].name, 'Dailyer');
  });
});

describe('partidas en tiempo real', () => {
  test('mate del pastor... del loco: valida jugadas y termina en mate', async () => {
    const [a, b] = [await guest('Blancas'), await guest('Negras')];
    const [ca, cb] = [await connect(a.token), await connect(b.token)];
    ca.send({ t: 'create', tc: 'none', color: 'w' });
    const { code } = await ca.waitFor((m) => m.t === 'created');
    cb.send({ t: 'join', code });
    const sb = await state(cb, (s) => s.status === 'playing');
    assert.equal(sb.you, 'b');
    assert.equal((await state(ca, (s) => s.status === 'playing')).you, 'w');

    ca.send({ t: 'move', uci: 'e2e5' }); // ilegal
    await ca.waitFor((m) => m.t === 'error');
    cb.send({ t: 'move', uci: 'e7e5' }); // no es su turno
    await cb.waitFor((m) => m.t === 'error');

    const play = async (c, uci, n) => {
      c.send({ t: 'move', uci });
      await state(ca, (s) => s.moves.length === n);
      await state(cb, (s) => s.moves.length === n);
    };
    await play(ca, 'f2f3', 1);
    await play(cb, 'e7e5', 2);
    await play(ca, 'g2g4', 3);
    cb.send({ t: 'move', uci: 'd8h4' });
    const over = await state(ca, (s) => s.status === 'over');
    assert.deepEqual(over.result, { winner: 'b', reason: 'jaque mate' });
    assert.equal(over.moves.length, 4);
    ca.close();
    cb.close();
  });

  test('rendición, tablas, espectador, emotes y revancha con colores cambiados', async () => {
    const [a, b, s] = [await guest('Uno'), await guest('Dos'), await guest('Mirón')];
    const [ca, cb, cs] = [await connect(a.token), await connect(b.token), await connect(s.token)];
    ca.send({ t: 'create', tc: 'blitz5', color: 'b' });
    const { code } = await ca.waitFor((m) => m.t === 'created');
    cb.send({ t: 'join', code });
    cs.send({ t: 'join', code });
    const spec = await state(cs, (st) => st.you === 's');
    assert.equal(spec.players.b.name, 'Uno');
    assert.equal(spec.players.w.name, 'Dos');

    cs.send({ t: 'move', uci: 'e2e4' });
    await cs.waitFor((m) => m.t === 'error');
    cb.send({ t: 'emote', id: 3 });
    const em = await ca.waitFor((m) => m.t === 'emote');
    assert.deepEqual([em.from, em.id], ['w', 3]);
    await cs.waitFor((m) => m.t === 'emote');

    cb.send({ t: 'draw', action: 'offer' });
    await state(ca, (st) => st.drawOffer === 'w');
    ca.send({ t: 'draw', action: 'decline' });
    await state(cb, (st) => st.drawOffer === null);

    // Rendirse antes de que ambos hayan movido aborta la partida (sin ganador).
    cb.send({ t: 'move', uci: 'e2e4' });
    await state(ca, (st) => st.moves.length === 1);
    cb.send({ t: 'resign' });
    const aborted = await state(ca, (st) => st.status === 'over');
    assert.deepEqual(aborted.result, { winner: null, reason: 'abortada' });
    ca.send({ t: 'rematch' });
    cb.send({ t: 'rematch' });
    const rm0 = await state(ca, (st) => st.rematchCode);
    ca.send({ t: 'join', code: rm0.rematchCode });
    cb.send({ t: 'join', code: rm0.rematchCode });
    const sa0 = await state(ca, (st) => st.code === rm0.rematchCode && st.status === 'playing');
    assert.equal(sa0.you, 'w', 'Uno jugaba con negras y en la revancha lleva blancas');
    const wc = (await state(cb, (st) => st.code === rm0.rematchCode && st.status === 'playing')).you === 'w' ? cb : ca;
    const bc = wc === cb ? ca : cb;
    wc.send({ t: 'move', uci: 'e2e4' });
    await state(bc, (st) => st.moves.length === 1);
    bc.send({ t: 'move', uci: 'e7e5' });
    await state(wc, (st) => st.moves.length === 2);
    bc.send({ t: 'resign' });
    const over = await state(wc, (st) => st.code === rm0.rematchCode && st.status === 'over');
    assert.deepEqual(over.result, { winner: 'w', reason: 'rendición' });

    [ca, cb, cs].forEach((c) => c.close());
  });

  test('el reloj corre desde la 2ª jugada y la caída de bandera pierde', async () => {
    const [a, b] = [await guest('Reloj1'), await guest('Reloj2')];
    const [ca, cb] = [await connect(a.token), await connect(b.token)];
    ca.send({ t: 'create', tc: 'bullet', color: 'w' });
    const { code } = await ca.waitFor((m) => m.t === 'created');
    cb.send({ t: 'join', code });
    await state(cb, (s) => s.status === 'playing');
    ca.send({ t: 'move', uci: 'e2e4' });
    const s1 = await state(cb, (s) => s.moves.length === 1);
    assert.equal(s1.clocks.running, null, 'sin reloj tras la primera jugada');
    cb.send({ t: 'move', uci: 'e7e5' });
    const s2 = await state(ca, (s) => s.moves.length === 2);
    assert.equal(s2.clocks.running, 'w');
    // Se fuerza el reloj blanco a casi cero para no esperar un minuto.
    const room = app.rooms.get(code);
    room.clocks.w = 60;
    room.lastTick = Date.now();
    room.scheduleFlag();
    const over = await state(cb, (s) => s.status === 'over');
    assert.deepEqual(over.result, { winner: 'b', reason: 'tiempo' });
    ca.close();
    cb.close();
  });

  test('reconexión: el jugador vuelve a su asiento', async () => {
    const [a, b] = [await guest('Recon1'), await guest('Recon2')];
    const [ca, cb] = [await connect(a.token), await connect(b.token)];
    ca.send({ t: 'create', tc: 'none', color: 'w' });
    const { code } = await ca.waitFor((m) => m.t === 'created');
    cb.send({ t: 'join', code });
    await state(cb, (s) => s.status === 'playing');
    ca.send({ t: 'move', uci: 'd2d4' });
    await state(cb, (s) => s.moves.length === 1);
    ca.close();
    await state(cb, (s) => s.players.w.online === false);
    const ca2 = await connect(a.token);
    ca2.send({ t: 'join', code });
    const back = await state(ca2, (s) => s.code === code);
    assert.equal(back.you, 'w');
    assert.equal(back.moves.length, 1);
    await state(cb, (s) => s.players.w.online === true);
    ca2.close();
    cb.close();
  });
});

describe('emparejamiento clasificatorio', () => {
  test('dos jugadores de rating parecido se emparejan y el Elo se actualiza', async () => {
    const [a, b] = [await guest('Rank1'), await guest('Rank2')];
    const [ca, cb] = [await connect(a.token), await connect(b.token)];
    ca.send({ t: 'queue', tc: 'blitz3' });
    await ca.waitFor((m) => m.t === 'queued');
    cb.send({ t: 'queue', tc: 'blitz3' });
    const ma = await ca.waitFor((m) => m.t === 'matched');
    const mb = await cb.waitFor((m) => m.t === 'matched');
    assert.equal(ma.code, mb.code);
    const sa = await state(ca, (s) => s.status === 'playing' && s.rated);
    // el color es aleatorio: se juega con el que toque
    const whiteClient = sa.you === 'w' ? ca : cb;
    const blackClient = sa.you === 'w' ? cb : ca;
    whiteClient.send({ t: 'move', uci: 'e2e4' });
    await state(blackClient, (s) => s.moves.length === 1);
    blackClient.send({ t: 'move', uci: 'e7e5' });
    await state(whiteClient, (s) => s.moves.length === 2);
    blackClient.send({ t: 'resign' });
    const over = await state(whiteClient, (s) => s.status === 'over');
    assert.equal(over.result.winner, 'w');
    assert.ok(over.ratingDelta.w > 0 && over.ratingDelta.b < 0);
    const winner = sa.you === 'w' ? a : b;
    assert.ok((await api('/api/me', { token: winner.token })).json.user.rating > 1000);
    const lb = (await api('/api/leaderboard')).json;
    assert.ok(lb.top.length >= 2);
    assert.ok(lb.top[0].rating >= lb.top[1].rating);
    ca.close();
    cb.close();
  });

  test('no se puede emparejar contra sí mismo y se puede salir de la cola', async () => {
    const a = await guest('Solo');
    const c1 = await connect(a.token);
    const c2 = await connect(a.token);
    c1.send({ t: 'queue', tc: 'blitz3' });
    await c1.waitFor((m) => m.t === 'queued');
    c2.send({ t: 'queue', tc: 'blitz3' }); // reemplaza a la entrada anterior del mismo usuario
    await c2.waitFor((m) => m.t === 'queued');
    assert.equal(app.matchmaker.size(), 1);
    c2.send({ t: 'dequeue' });
    await c2.waitFor((m) => m.t === 'dequeued');
    assert.equal(app.matchmaker.size(), 0);
    c1.close();
    c2.close();
  });
});

describe('estáticos y seguridad', () => {
  test('sirve la app en / y en /g/CODIGO con CSP; bloquea rutas peligrosas', async () => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal((await fetch(`${base}/g/ABC234`)).status, 200);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await api('/healthz')).status, 200);
    const stats = (await api('/api/stats')).json;
    assert.ok(stats.users >= 1);
  });
});
