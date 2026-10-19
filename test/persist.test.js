// Copia de la base de datos a un almacén externo (Neon) para alojamientos gratuitos sin disco.
// Se prueba con un almacén en memoria que implementa la misma interfaz que PgStore.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sha256 } from '../server/auth.js';
import { openDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { MemoryStore, createPersistence } from '../server/persist.js';

const quiet = { log() {}, warn() {}, error() {} };
const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
const FAST = { handoffPollMs: 5, retryDelayMs: 1 };
let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gambito-persist-'));
});
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* en Windows puede quedar algún archivo bloqueado un instante: es una carpeta temporal */
  }
});

const wipe = (file) => ['', '-wal', '-shm', '.snap', '.merge'].forEach((s) => rmSync(file + s, { force: true }));
const addUser = (db, id, name = id) => db.createUser({ id, name, tokenHash: sha256(`t-${id}`), recoveryHash: sha256(`r-${id}`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arranca una "instancia": restaura, abre la base de datos y empieza a copiar.
async function boot(name, store, opts = {}) {
  const file = path.join(dir, `${name}.db`);
  const p = createPersistence({ dbFile: file, store, log: quiet, ...FAST, ...opts });
  await p.restore();
  const db = openDb(file);
  p.start(db);
  return { p, db, file };
}

describe('persistencia', () => {
  test('la base de datos sobrevive a la pérdida del disco', async () => {
    const store = new MemoryStore();
    const a = await boot('a', store);
    assert.equal(a.p.status().claimed, true, 'primer arranque: se hace propietaria sin esperar');
    addUser(a.db, 'u1', 'Ana');
    assert.equal(await a.p.snapshot(), true);
    await a.p.stop();
    a.db.close();

    wipe(a.file); // el disco efímero desaparece (reinicio de Render Free)
    const b = await boot('a', store);
    assert.equal(b.p.status().restoredBytes > 0, true);
    assert.equal(b.db.userById('u1').name, 'Ana');
    await b.p.stop();
    b.db.close();
  });

  test('solo se sube la copia cuando hubo cambios', async () => {
    const store = new MemoryStore();
    const a = await boot('b', store);
    await a.p.snapshot();
    await a.p.snapshot();
    assert.equal(store.saves, 0);
    addUser(a.db, 'u2');
    await a.p.snapshot();
    await a.p.snapshot();
    assert.equal(store.saves, 1);
    await a.p.stop();
    a.db.close();
  });

  test('despliegue solapado: la nueva instancia fusiona la copia final de la antigua y no se pierde nada', async () => {
    const store = new MemoryStore();
    const old = await boot('old', store);
    addUser(old.db, 'A');
    await old.p.snapshot(); // copia periódica con A

    const fresh = await boot('new', store); // arranca la nueva mientras la antigua sigue sirviendo
    assert.equal(fresh.p.status().claimed, false, 'no es propietaria hasta el relevo');
    assert.equal(fresh.db.userById('A').id, 'A');
    addUser(fresh.db, 'B'); // cuenta creada en la nueva
    assert.equal(await fresh.p.snapshot(), false, 'sin ser propietaria no escribe');

    addUser(old.db, 'C'); // cuenta creada en la antigua después de que arrancara la nueva
    await old.p.stop(); // SIGTERM: copia final (A, C)
    assert.equal(store.final, true);

    await fresh.p.handoffTick(); // detecta la copia final, fusiona y toma la propiedad
    assert.equal(fresh.p.status().claimed, true);
    for (const id of ['A', 'B', 'C']) assert.ok(fresh.db.userById(id), `falta ${id} tras la fusión`);

    // La copia publicada contiene todo: una tercera instancia arranca desde cero con A, B y C.
    await fresh.p.stop();
    fresh.db.close();
    old.db.close();
    wipe(fresh.file);
    const third = await boot('third', store);
    for (const id of ['A', 'B', 'C']) assert.ok(third.db.userById(id), `falta ${id} en la copia final`);
    await third.p.stop();
    third.db.close();
  });

  test('si la antigua no llega a subir su copia final, la nueva toma el control pasado el máximo de espera', async () => {
    const store = new MemoryStore();
    const old = await boot('crash-old', store);
    addUser(old.db, 'X');
    await old.p.snapshot();
    const fresh = await boot('crash-new', store, { handoffMaxMs: 20 });
    addUser(fresh.db, 'Y');
    await sleep(40);
    await fresh.p.handoffTick();
    assert.equal(fresh.p.status().claimed, true);
    addUser(old.db, 'W'); // un cambio nuevo en la antigua obliga a intentar escribir
    assert.equal(await old.p.snapshot(), false, 'la antigua ya no es propietaria');
    assert.equal(old.p.status().lostOwnership, true);
    await Promise.all([old.p.stop(), fresh.p.stop()]);
    old.db.close();
    fresh.db.close();
  });

  test('si no se puede leer la copia: modo degradado, el servicio arranca pero NUNCA escribe la copia', async () => {
    const store = new MemoryStore();
    store.hasRow = true;
    store.owner = 'otro';
    store.data = Buffer.from('copia-buena');
    store.failLoad = 99;
    const file = path.join(dir, 'deg.db');
    const p = createPersistence({ dbFile: file, store, restoreRetries: 3, retryDelayMs: 1, log: quiet });
    const res = await p.restore();
    assert.deepEqual(res, { restored: false, degraded: true });
    const db = openDb(file);
    p.start(db);
    addUser(db, 'Z');
    assert.equal(await p.snapshot({ force: true }), false);
    await p.stop();
    db.close();
    assert.equal(store.data.toString(), 'copia-buena', 'la copia buena sigue intacta');
    assert.equal(p.status().degraded, true);
  });

  test('se recupera de fallos temporales del almacén (Neon despertando)', async () => {
    const store = new MemoryStore();
    store.failLoad = 2;
    const p = createPersistence({ dbFile: path.join(dir, 'tmp.db'), store, restoreRetries: 4, retryDelayMs: 1, log: quiet });
    const res = await p.restore();
    assert.equal(res.degraded, false);
  });
});

describe('servidor con persistencia', () => {
  test('las cuentas sobreviven a un reinicio completo con disco nuevo', async () => {
    const file = path.join(dir, 'srv.db');
    const store = new MemoryStore();
    const opts = { port: 0, host: '127.0.0.1', dbFile: file, puzzles: PUZZLES, persistStore: store, persistOptions: FAST };

    let app = await startServer(opts);
    let base = `http://127.0.0.1:${app.port}`;
    const guest = await (await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Persistente' }) })).json();
    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.ok(stats.persist, '/api/stats informa del estado de la copia');
    assert.equal(typeof stats.uptimeSeconds, 'number');
    await app.close(); // copia final

    wipe(file);

    app = await startServer(opts);
    base = `http://127.0.0.1:${app.port}`;
    const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${guest.token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.name, 'Persistente');
    await app.close();
  });

  test('el apagado no se bloquea con conexiones keep-alive abiertas (SIGTERM en Render)', async () => {
    const app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES });
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: app.port, path: '/healthz', agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
    const t0 = Date.now();
    await app.close(); // antes se quedaba esperando a que el proxy cerrara la conexión
    assert.ok(Date.now() - t0 < 3000, `el cierre tardó ${Date.now() - t0} ms`);
    agent.destroy();
  });
});
