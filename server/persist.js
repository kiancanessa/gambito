// Persistencia en alojamientos GRATUITOS sin disco (p. ej. Render Free): el disco es efímero, así que la base de
// datos SQLite se copia periódicamente a un Postgres gratuito (Neon) y se restaura al arrancar.
//
//   arranque:  restaurar la última copia → abrir SQLite → reclamar la propiedad de la copia
//   en marcha: cada `intervalMs`, si hubo cambios, VACUUM INTO → subir la copia (como máximo ~1 min de datos en riesgo)
//   apagado:   copia final (SIGTERM) antes de cerrar
//
// Protección: una instancia solo puede escribir la copia mientras sea su "propietaria". Si arranca otra (despliegue
// solapado), la antigua detecta que perdió la propiedad y deja de escribir, así nunca pisa datos más recientes.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- Almacenes -----
export class PgStore {
  constructor(databaseUrl, { table = 'gambito_snapshots' } = {}) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Nombre de tabla no válido');
    this.url = databaseUrl;
    this.table = table;
    this.pool = null;
  }

  async init() {
    const { default: pg } = await import('pg'); // solo se carga si se usa
    this.pool = new pg.Pool({ connectionString: this.url, max: 2, connectionTimeoutMillis: 25_000, idleTimeoutMillis: 10_000 });
    this.pool.on('error', () => {}); // las desconexiones de Neon (suspensión) no deben tumbar el proceso
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY,
      data BYTEA,
      owner TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  }

  async load() {
    const res = await this.pool.query(`SELECT data FROM ${this.table} WHERE id = 'main'`);
    return res.rows[0]?.data ?? null;
  }

  async claim(owner) {
    await this.pool.query(
      `INSERT INTO ${this.table} (id, owner) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, updated_at = now()`,
      [owner],
    );
  }

  // Devuelve false si otra instancia es ahora la propietaria.
  async save(data, owner) {
    const res = await this.pool.query(`UPDATE ${this.table} SET data = $1, updated_at = now() WHERE id = 'main' AND owner = $2`, [data, owner]);
    return res.rowCount === 1;
  }

  // Solo para scripts/check-neon.js (tabla de prueba).
  async drop() {
    await this.pool.query(`DROP TABLE IF EXISTS ${this.table}`);
  }

  async close() {
    await this.pool?.end().catch(() => {});
  }
}

// Almacén en memoria (pruebas): misma interfaz que PgStore.
export class MemoryStore {
  constructor() {
    this.data = null;
    this.owner = null;
    this.saves = 0;
    this.failLoad = 0; // nº de cargas que fallarán (pruebas de reintentos)
  }

  async init() {}

  async load() {
    if (this.failLoad > 0) {
      this.failLoad -= 1;
      throw new Error('almacén no disponible');
    }
    return this.data;
  }

  async claim(owner) {
    this.owner = owner;
  }

  async save(data, owner) {
    if (owner !== this.owner) return false;
    this.data = Buffer.from(data);
    this.saves += 1;
    return true;
  }
}

// ----- Lógica -----
export function createPersistence({ dbFile, store, intervalMs = 60_000, restoreRetries = 6, retryDelayMs = 4000, log = console }) {
  const owner = randomUUID();
  let db = null;
  let timer = null;
  let busy = false;
  let lost = false;
  let lastChanges = -1;
  const status = { enabled: true, restoredBytes: 0, lastOkAt: null, lastError: null, lostOwnership: false };

  const changesNow = () => db.raw.prepare('SELECT total_changes() AS n').get().n;

  // Si no se puede leer la copia NO se arranca con una base vacía (luego se subiría encima de la buena).
  async function restore() {
    let lastErr;
    for (let attempt = 1; attempt <= restoreRetries; attempt += 1) {
      try {
        await store.init();
        const data = await store.load();
        if (data?.length) {
          mkdirSync(path.dirname(dbFile), { recursive: true });
          rmSync(`${dbFile}-wal`, { force: true });
          rmSync(`${dbFile}-shm`, { force: true });
          writeFileSync(dbFile, data);
          status.restoredBytes = data.length;
          log.log(`[persist] base de datos restaurada (${data.length} bytes)`);
        } else {
          log.log('[persist] sin copia previa: se empieza con una base nueva');
        }
        await store.claim(owner);
        return status.restoredBytes > 0;
      } catch (err) {
        lastErr = err;
        log.warn(`[persist] no se pudo restaurar (intento ${attempt}/${restoreRetries}): ${err.message}`);
        if (attempt < restoreRetries) await sleep(retryDelayMs);
      }
    }
    throw new Error(`No se pudo restaurar la copia de la base de datos: ${lastErr?.message}`);
  }

  async function snapshot({ force = false } = {}) {
    if (!db || lost || busy) return false;
    busy = true;
    const tmp = `${dbFile}.snap`;
    try {
      const changes = changesNow();
      if (!force && changes === lastChanges) return true; // nada nuevo
      rmSync(tmp, { force: true });
      db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const buf = readFileSync(tmp);
      const ok = await store.save(buf, owner);
      if (!ok) {
        lost = true;
        status.lostOwnership = true;
        log.warn('[persist] otra instancia tomó el control de la copia: se detienen las copias de esta');
        return false;
      }
      lastChanges = changes;
      status.lastOkAt = Date.now();
      status.lastError = null;
      return true;
    } catch (err) {
      status.lastError = String(err.message ?? err);
      log.error(`[persist] error al guardar la copia: ${status.lastError}`);
      return false;
    } finally {
      rmSync(tmp, { force: true });
      busy = false;
    }
  }

  return {
    owner,
    restore,
    snapshot,
    status: () => ({ ...status }),
    start(database) {
      db = database;
      lastChanges = changesNow();
      timer = setInterval(() => snapshot(), intervalMs);
      timer.unref?.();
    },
    // Copia final (SIGTERM) con tope de tiempo y cierre del almacén.
    async stop(timeoutMs = 10_000) {
      clearInterval(timer);
      const t0 = Date.now();
      while (busy && Date.now() - t0 < timeoutMs) await sleep(50);
      await Promise.race([snapshot(), sleep(timeoutMs)]);
      await store.close?.();
    },
  };
}
