// Fase 0: topes anti-abuso, final por tiempo con material insuficiente y CORS para clientes alojados aparte.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Chess } from 'chess.js';
import WebSocket from 'ws';
import { LIMITS } from '../server/config.js';
import { startServer } from '../server/index.js';
import { hasMatingMaterial } from '../server/rooms.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
let app;
let base;

const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();

// Petición HTTP con cabeceras arbitrarias (fetch no deja fijar `Origin`).
const raw = (method, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

async function connect(token, origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, origin ? { headers: { Origin: origin } } : undefined);
  const msgs = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    msgs.push(m);
    waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
  });
  const c = {
    ws,
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const found = msgs.find(pred);
        if (found) return resolve(found);
        const t = setTimeout(() => reject(new Error(`timeout; últimos: ${JSON.stringify(msgs.slice(-3))}`)), ms);
        waiters.push({ test: pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    close: () => ws.close(),
  };
  c.send({ t: 'auth', token });
  await c.waitFor((m) => m.t === 'authed' || m.t === 'error');
  return c;
}

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => {
  delete process.env.ALLOWED_ORIGINS;
  await app.close();
});

describe('material suficiente para ganar por tiempo', () => {
  const has = (fen, color) => hasMatingMaterial(new Chess(fen), color);
  test('casos básicos', () => {
    assert.equal(has('k7/8/8/8/8/8/8/KN6 w - - 0 1', 'b'), false, 'rey solo no puede mate');
    assert.equal(has('k7/8/8/8/8/8/8/KN6 w - - 0 1', 'w'), false, 'rey y caballo contra rey solo: insuficiente');
    assert.equal(has('k7/8/8/8/8/8/R7/K7 w - - 0 1', 'w'), true, 'torre basta');
    assert.equal(has('k7/8/8/8/8/8/P7/K7 w - - 0 1', 'w'), true, 'peón puede coronar');
    assert.equal(has('k7/8/8/8/8/8/8/KNB5 w - - 0 1', 'w'), true, 'dos piezas menores bastan');
    assert.equal(has('k7/p7/8/8/8/8/8/KN6 w - - 0 1', 'w'), true, 'una menor basta si el rival tiene más piezas (mate posible)');
  });

  test('si cae la bandera y el rival no puede mate, son tablas', async () => {
    const [a, b] = [await guest('Flag1'), await guest('Flag2')];
    const [ca, cb] = [await connect(a.token), await connect(b.token)];
    ca.send({ t: 'create', tc: 'bullet', color: 'w' });
    const { code } = await ca.waitFor((m) => m.t === 'created');
    cb.send({ t: 'join', code });
    await cb.waitFor((m) => m.t === 'state' && m.status === 'playing');
    ca.send({ t: 'move', uci: 'e2e4' });
    await cb.waitFor((m) => m.t === 'state' && m.moves.length === 1);
    cb.send({ t: 'move', uci: 'e7e5' });
    await ca.waitFor((m) => m.t === 'state' && m.moves.length === 2);
    // Posición: blancas con rey y caballo; negras solo con rey. Si las blancas se quedan sin tiempo,
    // las negras no pueden dar mate → tablas.
    const room = app.rooms.get(code);
    room.chess.load('k7/8/8/8/8/8/8/KN6 w - - 0 1');
    room.clocks.w = 60;
    room.lastTick = Date.now();
    room.scheduleFlag();
    const over = await cb.waitFor((m) => m.t === 'state' && m.status === 'over');
    assert.deepEqual(over.result, { winner: null, reason: 'tiempo con material insuficiente' });
    ca.close();
    cb.close();
  });
});

describe('topes anti-abuso', () => {
  test('máximo de partidas abiertas por jugador; cancelar libera cupo', async () => {
    const old = LIMITS.roomsPerUser;
    LIMITS.roomsPerUser = 2;
    try {
      const u = await guest('Creador');
      // Una conexión por sala: así cada sala sigue ocupada y cuenta como abierta.
      const conns = [];
      for (let i = 0; i < 2; i += 1) {
        const c = await connect(u.token);
        c.send({ t: 'create', tc: 'none' });
        await c.waitFor((m) => m.t === 'created');
        conns.push(c);
      }
      const extra = await connect(u.token);
      extra.send({ t: 'create', tc: 'none' });
      const err = await extra.waitFor((m) => m.t === 'error');
      assert.equal(err.code, 'limit');
      // cancelar (salir) una sala vacía en espera la elimina y libera el cupo
      conns[0].send({ t: 'leave' });
      await new Promise((r) => setTimeout(r, 100));
      extra.send({ t: 'create', tc: 'none' });
      await extra.waitFor((m) => m.t === 'created');
      [...conns, extra].forEach((c) => c.close());
    } finally {
      LIMITS.roomsPerUser = old;
    }
  });

  test('creación de salas limitada por minuto', async () => {
    const old = LIMITS.createsPerMinute;
    LIMITS.createsPerMinute = 3;
    try {
      const u = await guest('Spammer');
      const c = await connect(u.token);
      for (let i = 0; i < 3; i += 1) {
        c.send({ t: 'create', tc: 'none' });
        await c.waitFor((m) => m.t === 'created' && !m.seen && (m.seen = true));
        c.send({ t: 'leave' });
      }
      c.send({ t: 'create', tc: 'none' });
      const err = await c.waitFor((m) => m.t === 'error' && m.code === 'limit');
      assert.match(err.message, /rápido/);
      c.close();
    } finally {
      LIMITS.createsPerMinute = old;
    }
  });

  test('máximo de conexiones WebSocket por IP', async () => {
    const old = LIMITS.wsPerIp;
    LIMITS.wsPerIp = 2;
    try {
      const u = await guest('Sockets');
      const a = await connect(u.token);
      const b = await connect(u.token);
      await assert.rejects(connect(u.token), (e) => e.status === 429 || /socket hang up|ECONNRESET|429/.test(e.message));
      a.close();
      b.close();
      await new Promise((r) => setTimeout(r, 150)); // el contador baja al cerrarse
      const again = await connect(u.token);
      again.close();
    } finally {
      LIMITS.wsPerIp = old;
    }
  });

  test('máximo de conexiones por cuenta', async () => {
    const old = LIMITS.socketsPerUser;
    LIMITS.socketsPerUser = 2;
    try {
      const u = await guest('Pestañas');
      const a = await connect(u.token);
      const b = await connect(u.token);
      const c = await connect(u.token);
      assert.ok(c.msgs.some((m) => m.t === 'error' && m.code === 'limit'));
      [a, b, c].forEach((x) => x.close());
    } finally {
      LIMITS.socketsPerUser = old;
    }
  });
});

describe('CORS y WebSocket para un cliente alojado aparte', () => {
  const ORIGIN = 'https://cliente.example';

  test('la API responde al origen autorizado y rechaza al resto', async () => {
    process.env.ALLOWED_ORIGINS = `${ORIGIN}/, https://otro.example`;
    const pre = await raw('OPTIONS', '/api/guest', { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
    assert.match(pre.headers['access-control-allow-headers'], /Authorization/i);

    const bad = await raw('OPTIONS', '/api/guest', { Origin: 'https://malo.example', 'Access-Control-Request-Method': 'POST' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], undefined);

    const get = await raw('GET', '/api/stats', { Origin: ORIGIN });
    assert.equal(get.status, 200);
    assert.equal(get.headers['access-control-allow-origin'], ORIGIN);
    const noCors = await raw('GET', '/api/stats', { Origin: 'https://malo.example' });
    assert.equal(noCors.headers['access-control-allow-origin'], undefined);
  });

  test('el WebSocket acepta el origen autorizado y bloquea otros', async () => {
    process.env.ALLOWED_ORIGINS = ORIGIN;
    const u = await guest('Remoto');
    const ok = await connect(u.token, ORIGIN);
    assert.ok(ok.msgs.some((m) => m.t === 'authed'));
    ok.close();
    await assert.rejects(connect(u.token, 'https://malo.example'));
    delete process.env.ALLOWED_ORIGINS;
    await assert.rejects(connect(u.token, ORIGIN), 'sin ALLOWED_ORIGINS, un origen ajeno no puede conectar');
  });
});
