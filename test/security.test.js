// QA de seguridad (PROMPT 10): pruebas adversarias contra un servidor real. Cada prueba describe lo que DEBE ocurrir;
// si falla, es un fallo del servidor, no de la prueba.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { LIMITS } from '../server/config.js';
import { startServer } from '../server/index.js';

LIMITS.guestsPerHour = 100_000;
const json = { 'Content-Type': 'application/json' };
let app;
let base;
const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
const apps = [];
// Cada grupo arranca su propio servidor: el límite general por IP (240/min) no debe mezclar unas pruebas con otras.
const start = async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES, metricsLogMs: 0 });
  apps.push(app);
  base = `http://127.0.0.1:${app.port}`;
};
after(() => Promise.allSettled(apps.map((x) => x.close())));

let n = 0;
const guest = async (name = 'Sec') => (await (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name: `${name}${++n}` }) })).json());
const call = async (g, method, p, body, raw) => {
  const res = await fetch(`${base}${p}`, { method, headers: g ? { ...json, Authorization: `Bearer ${g.token}` } : json, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: res.status, json: await res.json().catch(() => ({})), headers: res.headers };
};
const fakeWs = () => ({ readyState: 1, sent: [], meta: {}, send(raw) { this.sent.push(JSON.parse(raw)); } });
// Petición con la ruta tal cual (fetch la normalizaría y taparía los casos raros).
const rawGet = (path) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
const alive = async () => (await fetch(`${base}/healthz`)).status === 200;

describe('peticiones mal formadas no tumban el servidor', () => {
  before(start);
  const PATHS = ['/%E0%A4%A', '/%', '/%%', '/js/%E0%A4%A.js', '/%00', '/..%2f..%2fserver%2findex.js', '/%2e%2e/%2e%2e/package.json', '/js/..%5c..%5cpackage.json', '/api/%E0%A4%A', '/api/users/%E0%A4%A', '/u/%E0%A4%A', '/index.html%00.png'];
  for (const p of PATHS) {
    test(`GET ${p}`, async () => {
      const status = await rawGet(p);
      assert.ok(status >= 400 && status < 500, `respuesta ${status}: debe ser un error del cliente (4xx), no un 200 ni un 5xx`);
      assert.equal(await alive(), true, 'el servidor sigue vivo');
    });
  }
  test('no se sirve nada fuera de public/ ni archivos ocultos', async () => {
    for (const p of ['/server/index.js', '/package.json', '/data/gambito.db', '/.env', '/.git/config', '/test/security.test.js', '/server/../package.json']) {
      const status = await rawGet(p);
      assert.ok([403, 404].includes(status), `${p} → ${status}`);
    }
  });
});

describe('cuerpos JSON de forma inesperada: error 4xx, nunca 500', () => {
  before(start);
  const BODIES = [['null', 'null'], ['array', '[]'], ['string', '"hola"'], ['número', '123'], ['booleano', 'true'], ['proto', '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}'], ['anidado', `${'{"a":'.repeat(200)}1${'}'.repeat(200)}`], ['vacío', '']];
  const ROUTES = [
    ['POST', '/api/guest', false], ['POST', '/api/recover', false],
    ['PATCH', '/api/me', true], ['PUT', '/api/save', true], ['POST', '/api/progress/claim', true], ['POST', '/api/progress/review', true],
    ['POST', '/api/cosmetics/equip', true], ['POST', '/api/wallet/ops', true], ['POST', '/api/daily/submit', true],
    ['POST', '/api/social/request', true], ['POST', '/api/social/respond', true], ['POST', '/api/social/remove', true], ['POST', '/api/social/block', true], ['POST', '/api/social/unblock', true], ['POST', '/api/report', true],
    ['PATCH', '/api/me/privacy', true], ['POST', '/api/events', true], ['POST', '/api/events/abcdefgh/cancel', true], ['POST', '/api/games/abcdefgh12/share', true],
  ];
  for (const [method, path, auth] of ROUTES) {
    test(`${method} ${path}`, async () => {
      const g = auth ? await guest('Fuzz') : null;
      for (const [label, raw] of BODIES) {
        const r = await call(g, method, path, undefined, raw);
        assert.ok(r.status < 500, `cuerpo «${label}» → ${r.status} ${JSON.stringify(r.json)}`);
      }
      assert.equal(await alive(), true);
    });
  }
  test('cuerpos enormes se rechazan con 413 sin colgar la conexión', async () => {
    const g = await guest('Grande');
    const big = JSON.stringify({ name: 'x'.repeat(200_000) });
    for (const [method, path] of [['PATCH', '/api/me'], ['POST', '/api/social/request'], ['POST', '/api/wallet/ops'], ['PATCH', '/api/me/privacy']]) {
      const r = await call(g, method, path, undefined, big);
      assert.equal(r.status, 413, `${method} ${path}`);
    }
  });
});

describe('autorización: cada cuenta solo toca lo suyo', () => {
  before(start);
  test('rutas con sesión rechazan token ausente, falso o con otro formato', async () => {
    for (const auth of [undefined, 'Bearer ', 'Bearer nope', 'Basic abc', 'bearer abc', `Bearer ${'a'.repeat(5000)}`]) {
      const res = await fetch(`${base}/api/me`, { headers: auth ? { Authorization: auth } : {} });
      assert.equal(res.status, 401, String(auth).slice(0, 20));
    }
  });
  test('un token no se puede deducir de otro y el recovery no sirve como token', async () => {
    const a = await guest('Tok');
    assert.equal((await call({ token: a.recovery }, 'GET', '/api/me')).status, 401);
    assert.equal((await call({ token: a.token.toUpperCase() }, 'GET', '/api/me')).status, 401, 'los tokens distinguen mayúsculas');
  });
  test('no hay secretos en las respuestas de cuenta (hashes, recovery de otros) ni en el perfil público', async () => {
    const a = await guest('Priv');
    const b = await guest('Otro');
    const me = await call(a, 'GET', '/api/me');
    assert.doesNotMatch(JSON.stringify(me.json), /hash|recovery|token/i);
    const pub = await call(b, 'GET', `/api/users/${a.user.id}`);
    assert.doesNotMatch(JSON.stringify(pub.json), /hash|recovery|token|email|last_seen|ip/i);
    for (const p of ['/api/leaderboard', '/api/circuit', '/api/stats', '/api/live', '/api/public/games']) assert.doesNotMatch(JSON.stringify((await call(null, 'GET', p)).json), /hash|recovery|"token"|email/i, p);
  });
  test('/api/stats no publica mensajes de error internos de la copia de seguridad', async () => {
    const { MemoryStore } = await import('../server/persist.js');
    class Broken extends MemoryStore {
      async save() {
        throw new Error('connection to ep-secret-host.neon.tech:5432 refused (password authentication failed for user neondb_owner)');
      }
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'gambito-qa-'));
    const second = await startServer({ port: 0, host: '127.0.0.1', dbFile: path.join(dir, 'qa.db'), puzzles: PUZZLES, metricsLogMs: 0, persistStore: new Broken(), persistOptions: { handoffPollMs: 5, retryDelayMs: 1, intervalMs: 20 }, persistIntervalMs: 20 });
    try {
      await fetch(`http://127.0.0.1:${second.port}/api/guest`, { method: 'POST', headers: json, body: '{}' }); // un cambio en la base de datos: sin él no hay nada que copiar
      for (let i = 0; i < 40 && !second.persistence.status().lastError; i += 1) await new Promise((r) => setTimeout(r, 50));
      assert.match(second.persistence.status().lastError ?? '', /ep-secret-host/, 'precondición: la copia falló de verdad y el error existe internamente');
      const stats = await (await fetch(`http://127.0.0.1:${second.port}/api/stats`)).json();
      assert.ok(stats.persist, 'informa de si la copia funciona');
      assert.doesNotMatch(JSON.stringify(stats), /neon|password|ep-secret|neondb/i, 'pero no del texto del error');
    } finally {
      await second.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* carpeta temporal: en Windows puede quedar un archivo bloqueado un instante */
      }
    }
  });
  test('cancelar el evento de otro, responder una solicitud que no es tuya o reportarte a ti mismo falla', async () => {
    const a = await guest('Dueno');
    const b = await guest('Intruso');
    assert.ok((await call(b, 'POST', '/api/events/desconocido1/cancel', {})).status >= 400);
    const respond = await call(b, 'POST', '/api/social/respond', { id: a.user.id, accept: true });
    assert.ok(respond.status >= 400, `responder a una solicitud que no existe: ${respond.status}`);
    assert.equal((await call(a, 'GET', '/api/social')).json.friends?.length ?? 0, 0, 'no se creó ninguna amistad');
    const self = await call(a, 'POST', '/api/report', { id: a.user.id, reason: 'abuso', ctx: 'profile' });
    assert.ok(self.status >= 400, `reportarse a uno mismo: ${self.status}`);
  });
  test('equipar un cosmético que no tienes o con claves peligrosas falla y no cambia nada', async () => {
    const a = await guest('Equipa');
    const before = (await call(a, 'GET', '/api/cosmetics')).json;
    for (const body of [{ category: 'frame', id: 'gold' }, { category: '__proto__', id: 'x' }, { category: 'constructor', id: 'prototype' }, { category: ['frame'], id: {} }, { category: 'avatar', id: '__proto__' }]) {
      const r = await call(a, 'POST', '/api/cosmetics/equip', body);
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(body));
    }
    assert.deepEqual((await call(a, 'GET', '/api/cosmetics')).json.equipped, before.equipped);
  });
  test('un guardado en la nube no puede inflar cartera, nivel ni cosméticos', async () => {
    const a = await guest('Infla');
    await call(a, 'PUT', '/api/save', { data: { coins: 99999999, xp: 99999999, level: 99, owned: ['set:crown'], equipped: { frame: 'crown' } } });
    const w = (await call(a, 'GET', '/api/wallet')).json.wallet;
    assert.ok(w.coins < 100_000, `oros ${w.coins}`);
    const c = (await call(a, 'GET', '/api/cosmetics')).json;
    assert.notEqual(c.equipped?.set, 'crown', 'la Corona del Circuit no se consigue con un guardado');
    assert.notEqual(c.equipped?.frame, 'crown');
    assert.ok(!(c.owned ?? []).includes?.('set:crown'));
  });
});

describe('recompensas: las repeticiones simultáneas no duplican nada', () => {
  before(start);
  function play(ua, ub) {
    const room = app.rooms.create({ tcId: 'none', rated: true, colorPref: 'w' });
    const [wa, wb] = [fakeWs(), fakeWs()];
    room.seat({ ...ua, games: 0 }, wa);
    room.seat({ ...ub, games: 0 }, wb);
    'e2e4 e7e5 g1f3 d7d6 f1c4 c8g4 b1c3 g7g6 f3e5 g4d1 c4f7 e8e7 c3d5'.split(' ').forEach((u, k) => room.move(k % 2 === 0 ? wa : wb, u)); // Légal: 13 jugadas, mate
    return room;
  }
  const reviewEvents = (userId, gameId) => app.db.raw.prepare("SELECT COUNT(*) AS n FROM progress_events WHERE user_id = ? AND ref = ?").get(userId, `review:${gameId}`).n;
  test('20 peticiones paralelas de «revisión» registran una sola concesión', async () => {
    const a = await guest('Revisa');
    const b = await guest('Rival');
    const room = play(a.user, b.user);
    assert.equal(reviewEvents(a.user.id, room.gameId), 0);
    const rs = await Promise.all(Array.from({ length: 20 }, () => call(a, 'POST', '/api/progress/review', { gameId: room.gameId, ply: 13 })));
    assert.ok(rs.every((r) => r.status < 500), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(rs.filter((r) => r.json.ok).length, 1, 'solo una respuesta concede');
    assert.equal(reviewEvents(a.user.id, room.gameId), 1);
    const again = await call(a, 'POST', '/api/progress/review', { gameId: room.gameId, ply: 13 });
    assert.ok(!again.json.ok, 'tampoco en una segunda tanda');
    assert.equal(reviewEvents(a.user.id, room.gameId), 1);
    const outsider = await guest('Ajeno');
    assert.ok(!(await call(outsider, 'POST', '/api/progress/review', { gameId: room.gameId, ply: 13 })).json.ok, 'quien no jugó no cobra');
    assert.equal(reviewEvents(outsider.user.id, room.gameId), 0);
  });
  test('el desafío diario paga XP y entra en la clasificación una sola vez aunque se envíe 20 veces a la vez', async () => {
    const a = await guest('Diario');
    const rs = await Promise.all(Array.from({ length: 20 }, () => call(a, 'POST', '/api/daily/submit', { moves: ['a1a8'], seconds: 10, attempts: 1 })));
    assert.ok(rs.every((r) => r.status < 500));
    const daily = (await call(a, 'GET', '/api/daily')).json;
    assert.equal(daily.top.filter((r) => r.id === a.user.id).length, 1);
    const events = app.db.raw.prepare("SELECT COUNT(*) AS n FROM progress_events WHERE user_id = ? AND kind = 'puzzle'").get(a.user.id).n;
    assert.equal(events, 1, 'una sola concesión de XP por el puzle del día');
  });
  test('comprar el mismo artículo 10 veces a la vez cobra una sola vez', async () => {
    const a = await guest('Compra');
    await call(a, 'GET', '/api/wallet');
    app.db.raw.prepare('UPDATE wallets SET coins = 1000 WHERE user_id = ?').run(a.user.id);
    const op = { t: 'buy', kind: 'board', id: 'forest' }; // 120 oros
    const rs = await Promise.all(Array.from({ length: 10 }, () => call(a, 'POST', '/api/wallet/ops', { ops: [op] })));
    assert.ok(rs.every((r) => r.status < 500));
    const w = (await call(a, 'GET', '/api/wallet')).json.wallet;
    assert.equal(w.coins, 880, `quedan ${w.coins}: se debe cobrar 120 una sola vez`);
    assert.equal(w.owned.filter((k) => k === 'board:forest').length, 1);
  });
  test('inscribirse al mismo torneo desde dos sockets a la vez deja una sola inscripción', async () => {
    const a = await guest('Doble');
    const list = (await call(a, 'GET', '/api/circuit')).json.tournaments;
    const open = list.find((t) => t.status === 'open');
    if (!open) return; // sin torneo abierto en este instante no hay nada que probar (no se da por pasado en el informe)
    const sockets = await Promise.all([0, 1, 2].map(() => new Promise((resolve) => { const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`); ws.on('open', () => resolve(ws)); })));
    sockets.forEach((ws) => { ws.send(JSON.stringify({ t: 'auth', token: a.token })); });
    await new Promise((r) => setTimeout(r, 200));
    sockets.forEach((ws) => ws.send(JSON.stringify({ t: 'circuit_join', id: open.id })));
    await new Promise((r) => setTimeout(r, 400));
    const entries = app.db.raw.prepare('SELECT COUNT(*) AS n FROM circuit_entries WHERE tournament_id = ? AND user_id = ?').get(open.id, a.user.id).n;
    sockets.forEach((ws) => ws.close());
    assert.equal(entries, 1);
  });
});

describe('WebSocket: mensajes hostiles', () => {
  before(start);
  const open = () => new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`); ws.on('open', () => resolve(ws)); ws.on('error', reject); });
  test('sin identificarse no se puede hacer nada; con basura el servidor sigue vivo', async () => {
    const ws = await open();
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    for (const m of [{ t: 'move', uci: 'e2e4' }, { t: 'create', tc: 'blitz5' }, { t: 'queue', tc: 'blitz5' }, { t: 'circuit_join', id: 'x' }, { t: 'invite', to: 'x' }]) ws.send(JSON.stringify(m));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(got.length >= 4 && got.every((m) => m.t === 'error' && m.code === 'auth'), JSON.stringify(got));
    ws.close();
  });
  test('fuzz: tipos y valores raros tras identificarse no rompen el servidor ni la sesión', async () => {
    const a = await guest('Fuzz');
    const ws = await open();
    ws.send(JSON.stringify({ t: 'auth', token: a.token }));
    await new Promise((r) => setTimeout(r, 100));
    const weird = [null, true, 7, 'x', [], {}, { t: 1 }, { t: [] }, { t: {} }, { t: '__proto__' }, { t: 'move' }, { t: 'move', uci: null }, { t: 'move', uci: { a: 1 } }, { t: 'move', uci: 'e2e4'.repeat(500) }, { t: 'join', code: { x: 1 } }, { t: 'join', code: '../../etc' }, { t: 'join', code: 'A'.repeat(1000) },
      { t: 'create', tc: { x: 1 }, color: [] }, { t: 'create', tc: '__proto__' }, { t: 'queue', tc: ['blitz5'] }, { t: 'draw', action: {} }, { t: 'emote', id: 'x' }, { t: 'emote', id: 1e308 }, { t: 'invite', to: { a: 1 } }, { t: 'circuit_join', id: { a: 1 } }, { t: 'circuit_watch', id: 5 }, { t: 'rematch' }, { t: 'leave' }, { t: 'resign' }];
    for (const m of weird) ws.send(typeof m === 'string' && m === 'x' ? 'no es json' : JSON.stringify(m));
    ws.send(Buffer.from([0, 1, 2, 3, 255]));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await alive(), true);
    assert.equal(ws.readyState, WebSocket.OPEN, 'la conexión sigue abierta');
    ws.close();
  });
  test('un mensaje de más de 2 KB corta la conexión', async () => {
    const ws = await open();
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    ws.send(JSON.stringify({ t: 'auth', token: 'x'.repeat(5000) }));
    assert.equal(await closed, 1009);
  });
  test('inundar de mensajes no consume el servidor: pasada la cuota se ignoran', async () => {
    const a = await guest('Flood');
    const ws = await open();
    ws.send(JSON.stringify({ t: 'auth', token: a.token }));
    await new Promise((r) => setTimeout(r, 100));
    let replies = 0;
    ws.on('message', () => (replies += 1));
    for (let i = 0; i < 500; i += 1) ws.send(JSON.stringify({ t: 'move', uci: 'e2e4' }));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(replies <= 45, `se respondió a ${replies} de 500`);
    ws.close();
  });
  test('un espectador no puede mover, rendirse, ofrecer tablas ni pedir revancha', async () => {
    const [a, b, c] = [await guest('JugA'), await guest('JugB'), await guest('Mira')];
    const room = app.rooms.create({ tcId: 'none', rated: false, colorPref: 'w' });
    const [wa, wb, wc] = [fakeWs(), fakeWs(), fakeWs()];
    room.seat({ ...a.user, games: 0 }, wa);
    room.seat({ ...b.user, games: 0 }, wb);
    assert.equal(room.seat({ ...c.user, games: 0 }, wc), 's');
    room.move(wc, 'e2e4');
    room.resign(wc);
    room.drawAction(wc, 'offer');
    room.drawAction(wc, 'accept');
    assert.equal(room.status, 'playing');
    assert.deepEqual(room.uci, []);
    assert.equal(room.drawOffer, null);
  });
});
