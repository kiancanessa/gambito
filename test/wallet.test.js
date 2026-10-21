// Fase 2: cartera verificada en el servidor (oros, XP, inventario) y su migración desde el guardado antiguo.
import { DEFAULT_EQUIPPED, DEFAULT_OWNED } from '../public/js/data.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { sha256 } from '../server/auth.js';
import { openDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { mergeSnapshot } from '../server/persist.js';
import { walletFromSave } from '../server/wallet.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
let app;
let base;
const tmp = mkdtempSync(path.join(tmpdir(), 'gambito-wallet-'));

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

const json = { 'Content-Type': 'application/json' };
const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
const authed = (g) => ({ ...json, Authorization: `Bearer ${g.token}` });
const getWallet = async (g) => (await (await fetch(`${base}/api/wallet`, { headers: authed(g) })).json()).wallet;
const ops = async (g, list) => {
  const res = await fetch(`${base}/api/wallet/ops`, { method: 'POST', headers: authed(g), body: JSON.stringify({ ops: list }) });
  assert.equal(res.status, 200);
  return res.json();
};
const putSave = (g, data) => fetch(`${base}/api/save`, { method: 'PUT', headers: authed(g), body: JSON.stringify({ data, updatedAt: 1 }) });

describe('migración desde el guardado antiguo', () => {
  test('cuenta nueva: cartera inicial', async () => {
    const g = await guest('Nuevo');
    const w = await getWallet(g);
    assert.equal(w.coins, 100);
    assert.deepEqual(w.owned.sort(), [...DEFAULT_OWNED].sort());
    assert.deepEqual(w.equipped, DEFAULT_EQUIPPED);
  });

  test('un guardado inflado se recorta: oros con tope y solo objetos del catálogo', async () => {
    const g = await guest('Tramposo');
    await putSave(g, { coins: 9_999_999, level: 3, xp: 50, owned: ['set:dragon', 'set:inventado', 'board:lava'], equipped: { set: 'dragon', board: 'inventado', fx: 'sparks' } });
    const w = await getWallet(g);
    assert.equal(w.coins, 20_000);
    assert.equal(w.level, 3);
    assert.ok(w.owned.includes('set:dragon') && w.owned.includes('board:lava'));
    assert.ok(!w.owned.includes('set:inventado'));
    assert.deepEqual(w.equipped, { ...DEFAULT_EQUIPPED, set: 'dragon' });
  });

  test('es idempotente: volver a leer o guardar no cambia la cartera', async () => {
    const g = await guest('Estable');
    await putSave(g, { coins: 500 });
    const a = await getWallet(g);
    await putSave(g, { coins: 99_999 }); // el guardado ya no manda
    const b = await getWallet(g);
    assert.equal(a.coins, 500);
    assert.deepEqual(b, a);
  });

  test('walletFromSave tolera basura', () => {
    const w = walletFromSave({ coins: 'mucho', level: -5, xp: 1e9, owned: 'x', equipped: 5 });
    assert.equal(w.coins, 0);
    assert.equal(w.level, 1);
    assert.ok(w.xp < 100);
    assert.equal(w.owned.length, DEFAULT_OWNED.length);
  });
});

describe('compras y equipado', () => {
  test('comprar valida precio, saldo y duplicados; el precio lo fija el servidor', async () => {
    const g = await guest('Comprador');
    let r = await ops(g, [{ oid: 'a', t: 'buy', kind: 'set' }]);
    assert.equal(r.results[0].ok, false);
    r = await ops(g, [{ oid: 'b', t: 'buy', kind: 'board', id: 'lava' }]); // 800 > 100
    assert.deepEqual(r.results[0], { oid: 'b', ok: false, reason: 'coins' });
    assert.equal(r.wallet.coins, 100);
    r = await ops(g, [{ oid: 'c', t: 'buy', kind: 'board', id: 'forest' }]); // 120 > 100
    assert.equal(r.results[0].reason, 'coins');
    r = await ops(g, [
      { oid: 'd', t: 'earn', source: 'game', coins: 100, xp: 0 },
      { oid: 'e', t: 'buy', kind: 'board', id: 'forest' },
      { oid: 'f', t: 'buy', kind: 'board', id: 'forest' },
      { oid: 'g', t: 'equip', kind: 'board', id: 'forest' },
      { oid: 'h', t: 'equip', kind: 'set', id: 'dragon' },
    ]);
    assert.deepEqual(r.results.map((x) => x.reason ?? 'ok'), ['ok', 'ok', 'owned', 'ok', 'owned']);
    assert.equal(r.wallet.coins, 80);
    assert.equal(r.wallet.equipped.board, 'forest');
    assert.ok(!r.wallet.owned.includes('set:dragon'));
  });
});

describe('recompensas', () => {
  test('fuentes con tope: por evento, por día, repetidas y desconocidas', async () => {
    const g = await guest('Jugador');
    let r = await ops(g, [{ oid: 'x1', t: 'earn', source: 'game', coins: 99_999, xp: 80 }]);
    assert.equal(r.wallet.coins, 100 + 500, 'se recorta al tope por evento');
    r = await ops(g, [{ oid: 'x1', t: 'earn', source: 'game', coins: 500, xp: 0 }]);
    assert.equal(r.results[0].ok, true, 'un reintento es idempotente');
    assert.equal(r.results[0].reason, 'dup');
    assert.equal(r.wallet.coins, 600);
    r = await ops(g, [{ oid: 'x2', t: 'earn', source: 'inventada', coins: 10 }, { oid: 'x3', t: 'earn', source: 'login', coins: 77, key: 'login:1' }]);
    assert.deepEqual(r.results.map((x) => x.reason), ['unknown', 'invalid']);
    for (let i = 0; i < 6; i += 1) await ops(g, [{ oid: `c${i}`, t: 'earn', source: 'game', coins: 500 }]);
    r = await ops(g, [{ oid: 'cap', t: 'earn', source: 'game', coins: 500 }]);
    assert.equal(r.results[0].reason, 'cap', 'tope diario');
    assert.equal(r.wallet.coins, 100 + 3000);
  });

  test('el XP sube de nivel y el gasto de pistas no deja saldo negativo', async () => {
    const g = await guest('Nivelador');
    // La práctica local (IA, Academia) no se puede verificar: da poca XP por evento (60) y con tope diario (300).
    let r = await ops(g, [{ oid: 'xp', t: 'earn', source: 'game', coins: 0, xp: 250 }]);
    assert.equal(r.wallet.xp, 60, 'el servidor recorta la XP de práctica a 60 por evento');
    r = await ops(g, Array.from({ length: 6 }, (_, i) => ({ oid: `xp${i}`, t: 'earn', source: 'game', coins: 0, xp: 60 })));
    assert.deepEqual(r.results.map((x) => x.reason ?? 'ok'), ['ok', 'ok', 'ok', 'ok', 'cap', 'cap'], 'a partir de 300 XP al día, nada más');
    assert.equal(r.wallet.level, 3); // 60 + 240 = 300 XP: 100 para el nivel 2, 160 para el 3 → nivel 3
    r = await ops(g, [{ oid: 's1', t: 'spend', source: 'hint', amount: 10 }, { oid: 's2', t: 'spend', source: 'hint', amount: 500 }, { oid: 's3', t: 'spend', source: 'otro', amount: 1 }]);
    assert.deepEqual(r.results.map((x) => x.reason ?? 'ok'), ['ok', 'ok', 'invalid']);
    assert.ok(r.wallet.coins >= 0);
  });

  test('el antiguo cobro de temporada por el monedero ya no existe (se reclama en /api/progress/claim)', async () => {
    const g = await guest('Temporada');
    const r = await ops(g, [{ oid: 'a', t: 'earn', source: 'season', key: 'season:1:5', coins: 99_999 }]);
    assert.equal(r.results[0].reason, 'moved');
    assert.ok(!r.wallet.owned.includes('board:forest'));
    assert.equal(r.wallet.coins, 100);
  });

  test('desafío diario: solo se paga si el servidor tiene la solución', async () => {
    const g = await guest('Puzzle');
    const day = (await (await fetch(`${base}/api/daily`)).json()).day;
    let r = await ops(g, [{ oid: 'p1', t: 'earn', source: 'puzzle', key: `daily:${day}`, coins: 70 }]);
    assert.equal(r.results[0].reason, 'unverified');
    await fetch(`${base}/api/daily/submit`, { method: 'POST', headers: authed(g), body: JSON.stringify({ moves: ['a1a8'], seconds: 12, attempts: 1 }) });
    r = await ops(g, [{ oid: 'p2', t: 'earn', source: 'puzzle', key: `daily:${day}`, coins: 70 }, { oid: 'p3', t: 'earn', source: 'puzzle', key: `daily:${day}`, coins: 70 }]);
    assert.deepEqual(r.results.map((x) => x.reason ?? 'ok'), ['ok', 'dup']);
    assert.equal(r.wallet.coins, 190, '100 + 70 del desafío + 20 del logro «Táctico», concedido por el servidor');
  });

  test('reiniciar progreso devuelve la cartera inicial y permite volver a ganar', async () => {
    const g = await guest('Reinicio');
    await ops(g, [{ oid: 'a', t: 'earn', source: 'tutorial', key: 'tutorial', coins: 100 }]);
    let r = await ops(g, [{ oid: 'r', t: 'reset' }]);
    assert.equal(r.wallet.coins, 100);
    r = await ops(g, [{ oid: 'b', t: 'earn', source: 'tutorial', key: 'tutorial', coins: 100 }]);
    assert.equal(r.wallet.coins, 200);
  });

  test('operaciones mal formadas no rompen nada', async () => {
    const g = await guest('Basura');
    const r = await ops(g, [null, 5, {}, { t: 'earn' }, { t: 'buy' }]);
    assert.ok(r.results.every((x) => x.ok === false));
    assert.equal(r.wallet.coins, 100);
    const bad = await fetch(`${base}/api/wallet/ops`, { method: 'POST', headers: authed(g), body: JSON.stringify({ ops: 'x' }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/wallet`)).status, 401);
  });
});

describe('partidas online', () => {
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

  test('la recompensa la calcula el servidor con la partida real, solo para quien jugó', async () => {
    const [a, b, outsider] = [await guest('Blancas'), await guest('Negras'), await guest('Ajeno')];
    const [ca, cb] = [await connect(a.token), await connect(b.token)];
    ca.send({ t: 'create', tc: 'blitz5', color: 'w' });
    const { code } = await ca.waitFor((m) => m.t === 'created');
    cb.send({ t: 'join', code });
    await cb.waitFor((m) => m.t === 'state' && m.status === 'playing');
    for (const [c, uci] of [[ca, 'e2e4'], [cb, 'e7e5'], [ca, 'f1c4'], [cb, 'b8c6'], [ca, 'd1h5'], [cb, 'g8f6'], [ca, 'h5f7']]) {
      c.send({ t: 'move', uci });
      await pause(80);
    }
    await ca.waitFor((m) => m.t === 'state' && m.status === 'over');
    await pause(100);

    // 7 jugadas con mate del pastor: gana A con 1 jaque (Qxf7#)
    const win = await ops(a, [{ oid: 'o1', t: 'earn', source: 'online', key: `game:${code}`, coins: 99_999 }]);
    assert.equal(win.results[0].ok, true);
    assert.equal(win.wallet.coins, 100 + 60 + 5, 'victoria (60) + 1 jaque (5), ignorando lo que diga el cliente');
    assert.equal((await ops(a, [{ oid: 'o2', t: 'earn', source: 'online', key: `game:${code}` }])).results[0].reason, 'dup');

    const loss = await ops(b, [{ oid: 'o3', t: 'earn', source: 'online', key: `game:${code}` }]);
    assert.equal(loss.wallet.coins, 110, 'consuelo');
    assert.equal((await ops(outsider, [{ oid: 'o4', t: 'earn', source: 'online', key: `game:${code}` }])).results[0].reason, 'unverified');
    assert.equal((await ops(a, [{ oid: 'o5', t: 'earn', source: 'online', key: 'game:NOEXISTE' }])).results[0].reason, 'unverified');
    ca.close();
    cb.close();
  });
});

describe('copias de la base de datos', () => {
  test('fusionar una copia anterior sin tablas de cartera no falla y conserva las cuentas', () => {
    const oldFile = path.join(tmp, 'vieja.db');
    const old = openDb(oldFile);
    old.raw.exec('DROP TABLE wallets; DROP TABLE ledger; DROP TABLE tournaments; DROP TABLE tournament_results; DROP TABLE friend_codes; DROP TABLE friendships; DROP TABLE blocks; DROP TABLE reports; DROP TABLE game_flags;');
    old.createUser({ id: 'u-viejo', name: 'Viejo', tokenHash: sha256('t1'), recoveryHash: sha256('r1') });
    old.close();

    const cur = openDb(path.join(tmp, 'actual.db'));
    mergeSnapshot(cur, readFileSync(oldFile), path.join(tmp, 'tmp1.db'));
    assert.equal(cur.userById('u-viejo').name, 'Viejo');
    cur.close();
  });

  test('fusionar una copia con cartera conserva la más reciente y no duplica el libro', () => {
    const mk = (file, coins, rev) => {
      const db = openDb(file);
      db.createUser({ id: 'u1', name: 'Uno', tokenHash: sha256('t'), recoveryHash: sha256('r') });
      db.raw.prepare('INSERT INTO wallets VALUES (?,?,?,?,?,?,?,?)').run('u1', coins, 0, 1, '[]', '{}', rev, Date.now());
      db.raw.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?)').run('u1', 'r1', 'game', 10, 0, Date.now());
      return db;
    };
    const oldFile = path.join(tmp, 'o2.db');
    mk(oldFile, 900, 5).close();
    const cur = mk(path.join(tmp, 'c2.db'), 300, 2);
    mergeSnapshot(cur, readFileSync(oldFile), path.join(tmp, 'tmp2.db'));
    assert.equal(cur.raw.prepare('SELECT coins FROM wallets WHERE user_id = ?').get('u1').coins, 900);
    assert.equal(cur.raw.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);
    mergeSnapshot(cur, readFileSync(oldFile), path.join(tmp, 'tmp3.db')); // idempotente
    assert.equal(cur.raw.prepare('SELECT coins FROM wallets WHERE user_id = ?').get('u1').coins, 900);
    cur.close();
  });
});
