// Copia de la base de datos a un almacén externo (Neon) para alojamientos gratuitos sin disco.
// Se prueba con un almacén en memoria que implementa la misma interfaz que PgStore.
import assert from 'node:assert/strict';
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
let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gambito-persist-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const wipe = (file) => ['', '-wal', '-shm', '.snap'].forEach((s) => rmSync(file + s, { force: true }));

describe('persistencia', () => {
  test('la base de datos sobrevive a la pérdida del disco: copia y restauración', async () => {
    const file = path.join(dir, 'a.db');
    const store = new MemoryStore();
    const p1 = createPersistence({ dbFile: file, store, log: quiet });
    assert.equal(await p1.restore(), false, 'primer arranque: sin copia previa');
    const db1 = openDb(file);
    p1.start(db1);
    db1.createUser({ id: 'u1', name: 'Ana', tokenHash: sha256('t'), recoveryHash: sha256('r') });
    assert.equal(await p1.snapshot(), true);
    assert.equal(store.saves, 1);
    await p1.stop();
    db1.close();

    wipe(file); // el disco efímero desaparece (reinicio de Render Free)

    const p2 = createPersistence({ dbFile: file, store, log: quiet });
    assert.equal(await p2.restore(), true);
    const db2 = openDb(file);
    assert.equal(db2.userById('u1').name, 'Ana');
    p2.start(db2);
    await p2.stop();
    db2.close();
  });

  test('solo se sube la copia cuando hubo cambios', async () => {
    const file = path.join(dir, 'b.db');
    const store = new MemoryStore();
    const p = createPersistence({ dbFile: file, store, log: quiet });
    await p.restore();
    const db = openDb(file);
    p.start(db);
    await p.snapshot();
    await p.snapshot();
    assert.equal(store.saves, 0, 'sin cambios no se guarda nada');
    db.createUser({ id: 'u2', name: 'Luis', tokenHash: sha256('x'), recoveryHash: sha256('y') });
    await p.snapshot();
    await p.snapshot();
    assert.equal(store.saves, 1, 'un cambio = una copia');
    await p.stop();
    db.close();
  });

  test('una instancia antigua no puede pisar la copia de la nueva', async () => {
    const store = new MemoryStore();
    const fileA = path.join(dir, 'old.db');
    const fileB = path.join(dir, 'new.db');
    const old = createPersistence({ dbFile: fileA, store, log: quiet });
    await old.restore();
    const dbOld = openDb(fileA);
    old.start(dbOld);

    const fresh = createPersistence({ dbFile: fileB, store, log: quiet }); // despliegue solapado
    await fresh.restore();
    const dbNew = openDb(fileB);
    fresh.start(dbNew);

    dbOld.createUser({ id: 'viejo', name: 'Viejo', tokenHash: sha256('1'), recoveryHash: sha256('2') });
    assert.equal(await old.snapshot(), false);
    assert.equal(old.status().lostOwnership, true);
    dbNew.createUser({ id: 'nuevo', name: 'Nuevo', tokenHash: sha256('3'), recoveryHash: sha256('4') });
    assert.equal(await fresh.snapshot(), true);
    await old.stop();
    await fresh.stop();
    dbOld.close();
    dbNew.close();
  });

  test('si no se puede leer la copia NO se arranca con una base vacía', async () => {
    const store = new MemoryStore();
    store.failLoad = 99;
    const p = createPersistence({ dbFile: path.join(dir, 'c.db'), store, restoreRetries: 3, retryDelayMs: 1, log: quiet });
    await assert.rejects(p.restore(), /No se pudo restaurar/);
  });

  test('se recupera de fallos temporales del almacén (Neon despertando)', async () => {
    const store = new MemoryStore();
    store.failLoad = 2;
    const p = createPersistence({ dbFile: path.join(dir, 'd.db'), store, restoreRetries: 4, retryDelayMs: 1, log: quiet });
    await p.restore();
  });
});

describe('servidor con persistencia', () => {
  test('las cuentas sobreviven a un reinicio completo con disco nuevo', async () => {
    const file = path.join(dir, 'srv.db');
    const store = new MemoryStore();
    const opts = { port: 0, host: '127.0.0.1', dbFile: file, puzzles: PUZZLES, persistStore: store };

    let app = await startServer(opts);
    let base = `http://127.0.0.1:${app.port}`;
    const guest = await (await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Persistente' }) })).json();
    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.ok(stats.persist, '/api/stats informa del estado de la copia');
    await app.close(); // copia final

    wipe(file);

    app = await startServer(opts);
    base = `http://127.0.0.1:${app.port}`;
    const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${guest.token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.name, 'Persistente');
    await app.close();
  });
});
