// Persistencia en alojamientos GRATUITOS sin disco (p. ej. Render Free): el disco es efímero, así que la base de
// datos SQLite se copia a un Postgres gratuito (Neon) y se restaura al arrancar.
//
//   arranque:  restaurar la última copia → abrir SQLite
//   en marcha: cada `intervalMs`, si hubo cambios, VACUUM INTO → subir la copia (pocos minutos de datos en riesgo)
//   apagado:   copia final (SIGTERM) marcada como "final"
//
// Relevo entre instancias (despliegues solapados: la nueva arranca mientras la antigua aún atiende):
//   - La nueva restaura la última copia pero NO se hace propietaria todavía; la antigua sigue siendo la única que escribe.
//   - Al apagarse, la antigua sube su copia FINAL. La nueva la detecta (o espera un máximo), FUSIONA esa copia con lo que
//     ella misma ha guardado en ese rato (cuentas, guardados, partidas, resultados) y entonces toma la propiedad.
//   - Solo el propietario puede escribir la copia, así nadie pisa datos más recientes.
// Si no se puede leer la copia al arrancar, el servidor arranca SIN copias (modo degradado) en vez de caerse, y nunca
// escribe encima de la copia buena.
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
      is_final BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // La tabla de versiones anteriores no tenía esta columna.
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS is_final BOOLEAN NOT NULL DEFAULT FALSE`);
  }

  // Metadatos de la copia (sin descargar los datos): null si nunca hubo copia.
  async meta() {
    const res = await this.pool.query(`SELECT owner, is_final, (data IS NOT NULL) AS has_data, updated_at FROM ${this.table} WHERE id = 'main'`);
    const r = res.rows[0];
    return r ? { owner: r.owner, final: r.is_final, hasData: r.has_data, updatedAt: r.updated_at } : null;
  }

  async load() {
    const res = await this.pool.query(`SELECT data FROM ${this.table} WHERE id = 'main'`);
    return res.rows[0]?.data ?? null;
  }

  async claim(owner) {
    await this.pool.query(
      `INSERT INTO ${this.table} (id, owner) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, is_final = FALSE, updated_at = now()`,
      [owner],
    );
  }

  // Devuelve false si otra instancia es ahora la propietaria.
  async save(data, owner, { final = false } = {}) {
    const res = await this.pool.query(`UPDATE ${this.table} SET data = $1, is_final = $3, updated_at = now() WHERE id = 'main' AND owner = $2`, [data, owner, final]);
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
    this.final = false;
    this.saves = 0;
    this.failLoad = 0; // nº de lecturas que fallarán (pruebas de reintentos)
    this.hasRow = false;
  }

  async init() {}

  async meta() {
    if (this.failLoad > 0) {
      this.failLoad -= 1;
      throw new Error('almacén no disponible');
    }
    return this.hasRow ? { owner: this.owner, final: this.final, hasData: !!this.data, updatedAt: new Date() } : null;
  }

  async load() {
    return this.data;
  }

  async claim(owner) {
    this.hasRow = true;
    this.owner = owner;
    this.final = false;
  }

  async save(data, owner, { final = false } = {}) {
    if (!this.hasRow || owner !== this.owner) return false;
    this.data = Buffer.from(data);
    this.final = final;
    this.saves += 1;
    return true;
  }
}

// ----- Fusión de copias -----
// Incorpora a `db` lo que contiene otra copia de la misma base de datos (la "final" de la instancia anterior).
// Idempotente: filas nuevas se añaden; en conflicto gana la más reciente / con más partidas.
export function mergeSnapshot(db, buffer, tmpFile) {
  writeFileSync(tmpFile, buffer);
  const esc = tmpFile.replace(/'/g, "''");
  db.raw.exec(`ATTACH DATABASE '${esc}' AS old`);
  try {
    db.raw.exec(`
      BEGIN;
      INSERT OR IGNORE INTO users SELECT * FROM old.users;
      UPDATE users SET name = o.name, token_hash = o.token_hash, recovery_hash = o.recovery_hash, last_seen = o.last_seen
        FROM old.users o WHERE users.id = o.id AND o.last_seen > users.last_seen;
      UPDATE users SET rating = o.rating, games = o.games, wins = o.wins, losses = o.losses, draws = o.draws
        FROM old.users o WHERE users.id = o.id AND o.games > users.games;
      INSERT OR REPLACE INTO saves SELECT o.* FROM old.saves o
        WHERE NOT EXISTS (SELECT 1 FROM main.saves s WHERE s.user_id = o.user_id AND s.updated_at >= o.updated_at);
      INSERT OR IGNORE INTO games SELECT * FROM old.games;
      INSERT OR IGNORE INTO daily_results SELECT * FROM old.daily_results;
      COMMIT;
    `);
  } catch (err) {
    try {
      db.raw.exec('ROLLBACK');
    } catch {
      /* sin transacción abierta */
    }
    throw err;
  } finally {
    db.raw.exec('DETACH DATABASE old');
    rmSync(tmpFile, { force: true });
  }
}

// ----- Lógica -----
export function createPersistence({
  dbFile,
  store,
  intervalMs = 180_000,
  restoreRetries = 6,
  retryDelayMs = 4000,
  handoffPollMs = 15_000,
  handoffMaxMs = 300_000,
  log = console,
}) {
  const owner = randomUUID();
  const startedAt = Date.now();
  let db = null;
  let timer = null;
  let handoffTimer = null;
  let busy = false;
  let lost = false;
  let claimed = false;
  let degraded = false;
  let stopped = false;
  let lastChanges = -1;
  const status = { enabled: true, claimed: false, degraded: false, restoredBytes: 0, lastOkAt: null, lastError: null, lostOwnership: false };

  const changesNow = () => db.raw.prepare('SELECT total_changes() AS n').get().n;
  const markClaimed = () => {
    claimed = true;
    status.claimed = true;
  };

  async function restore() {
    let lastErr;
    for (let attempt = 1; attempt <= restoreRetries; attempt += 1) {
      try {
        await store.init();
        const meta = await store.meta();
        const data = meta?.hasData ? await store.load() : null;
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
        if (!meta) {
          await store.claim(owner); // primera vez: nadie más escribe la copia
          markClaimed();
        }
        return { restored: status.restoredBytes > 0, degraded: false };
      } catch (err) {
        lastErr = err;
        log.warn(`[persist] no se pudo restaurar (intento ${attempt}/${restoreRetries}): ${err.message}`);
        if (attempt < restoreRetries) await sleep(retryDelayMs);
      }
    }
    // Modo degradado: el servicio arranca igualmente, pero esta instancia NUNCA escribirá la copia.
    degraded = true;
    status.enabled = false;
    status.degraded = true;
    status.lastError = `restauración fallida: ${lastErr?.message}`;
    log.error(`[persist] MODO DEGRADADO: se arranca sin copia y no se guardará nada (${lastErr?.message})`);
    return { restored: false, degraded: true };
  }

  async function snapshot({ force = false, final = false } = {}) {
    if (!db || lost || degraded || !claimed || busy) return false;
    busy = true;
    const tmp = `${dbFile}.snap`;
    try {
      const changes = changesNow();
      if (!force && !final && changes === lastChanges) return true; // nada nuevo
      rmSync(tmp, { force: true });
      db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const buf = readFileSync(tmp);
      const ok = await store.save(buf, owner, { final });
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

  // Espera a que la instancia anterior suba su copia final (o a que pase el máximo), la fusiona y toma la propiedad.
  async function handoffTick() {
    if (claimed || lost || degraded || stopped) return;
    try {
      const meta = await store.meta();
      const waited = Date.now() - startedAt;
      if (!meta || meta.owner === owner || meta.final || waited >= handoffMaxMs) {
        if (meta?.hasData && meta.owner !== owner) {
          const data = await store.load();
          if (data?.length) {
            mergeSnapshot(db, data, `${dbFile}.merge`);
            log.log(`[persist] relevo: fusionada la copia de la instancia anterior (${data.length} bytes${meta.final ? ', final' : ', por tiempo'})`);
          }
        }
        await store.claim(owner);
        markClaimed();
        await snapshot({ force: true }); // publica el resultado de la fusión
        return;
      }
    } catch (err) {
      status.lastError = `relevo: ${err.message}`;
      log.warn(`[persist] relevo pendiente: ${err.message}`);
    }
    if (!stopped) {
      handoffTimer = setTimeout(handoffTick, handoffPollMs);
      handoffTimer.unref?.();
    }
  }

  return {
    owner,
    restore,
    snapshot,
    handoffTick,
    status: () => ({ ...status }),
    start(database) {
      db = database;
      lastChanges = changesNow();
      timer = setInterval(() => snapshot(), intervalMs);
      timer.unref?.();
      if (!claimed && !degraded) {
        handoffTimer = setTimeout(handoffTick, Math.min(handoffPollMs, 5000));
        handoffTimer.unref?.();
      }
    },
    // Copia final (SIGTERM) con tope de tiempo y cierre del almacén.
    async stop(timeoutMs = 10_000) {
      stopped = true;
      clearInterval(timer);
      clearTimeout(handoffTimer);
      const t0 = Date.now();
      while (busy && Date.now() - t0 < timeoutMs) await sleep(50);
      await Promise.race([snapshot({ final: true }), sleep(timeoutMs)]);
      await store.close?.();
    },
  };
}
