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
    // La copia puede venir de una versión anterior sin las tablas de la cartera (Fase 2).
    const oldTables = new Set(db.raw.prepare("SELECT name FROM old.sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const wallet = oldTables.has('wallets')
      ? `INSERT OR REPLACE INTO wallets (user_id, coins, xp, level, owned, equipped, rev, updated_at)
           SELECT o.user_id, o.coins, o.xp, o.level, o.owned, o.equipped, o.rev, o.updated_at FROM old.wallets o
           WHERE EXISTS (SELECT 1 FROM main.users u WHERE u.id = o.user_id)
             AND NOT EXISTS (SELECT 1 FROM main.wallets w WHERE w.user_id = o.user_id AND w.rev >= o.rev);
         INSERT OR IGNORE INTO ledger (user_id, ref, source, coins, xp, created_at)
           SELECT o.user_id, o.ref, o.source, o.coins, o.xp, o.created_at FROM old.ledger o
           WHERE EXISTS (SELECT 1 FROM main.users u WHERE u.id = o.user_id);`
      : '';
    const circuit = oldTables.has('tournaments')
      ? `INSERT OR IGNORE INTO tournaments SELECT * FROM old.tournaments;
         INSERT OR IGNORE INTO tournament_results (tournament_id, user_id, placement, coins, xp, item, created_at)
           SELECT o.tournament_id, o.user_id, o.placement, o.coins, o.xp, o.item, o.created_at FROM old.tournament_results o
           WHERE EXISTS (SELECT 1 FROM main.users u WHERE u.id = o.user_id);`
      : '';
    // Torneos del Circuit (cuadro persistido): gana la copia con la revisión más alta; se reemplazan también sus inscritos y partidos.
    const circuitState = ['circuit_tournaments', 'circuit_entries', 'circuit_matches'].every((x) => oldTables.has(x))
      ? `CREATE TEMP TABLE circuit_take AS SELECT o.id FROM old.circuit_tournaments o
           WHERE NOT EXISTS (SELECT 1 FROM main.circuit_tournaments m WHERE m.id = o.id AND m.rev >= o.rev);
         DELETE FROM circuit_matches WHERE tournament_id IN (SELECT id FROM circuit_take);
         DELETE FROM circuit_entries WHERE tournament_id IN (SELECT id FROM circuit_take);
         INSERT OR REPLACE INTO circuit_tournaments (id, format, name, tc, size, min_players, status, reg_opens_at, reg_closes_at, starts_at, created_at, started_at, finished_at, champion_id, cancel_reason, rounds, rev)
           SELECT id, format, name, tc, size, min_players, status, reg_opens_at, reg_closes_at, starts_at, created_at, started_at, finished_at, champion_id, cancel_reason, rounds, rev
           FROM old.circuit_tournaments WHERE id IN (SELECT id FROM circuit_take);
         INSERT INTO circuit_entries (tournament_id, user_id, name, rating, seed, status, placement, joined_at)
           SELECT tournament_id, user_id, name, rating, seed, status, placement, joined_at FROM old.circuit_entries WHERE tournament_id IN (SELECT id FROM circuit_take);
         INSERT INTO circuit_matches (tournament_id, round, slot, a_id, b_id, status, winner_id, reason, draws, code, updated_at)
           SELECT tournament_id, round, slot, a_id, b_id, status, winner_id, reason, draws, code, updated_at FROM old.circuit_matches WHERE tournament_id IN (SELECT id FROM circuit_take);
         DROP TABLE circuit_take;`
      : '';
    // Progresión: eventos, reclamaciones y logros solo se añaden (claves únicas); la clasificación de temporada gana quien tenga más partidas.
    const progress = ['progress_events', 'mission_claims', 'season_claims', 'achievements', 'season_stats'].every((x) => oldTables.has(x))
      ? `INSERT OR IGNORE INTO progress_events (user_id, ref, kind, xp, season_id, at, meta)
           SELECT user_id, ref, kind, xp, season_id, at, meta FROM old.progress_events WHERE user_id IN (SELECT id FROM main.users);
         INSERT OR IGNORE INTO mission_claims SELECT * FROM old.mission_claims WHERE user_id IN (SELECT id FROM main.users);
         INSERT OR IGNORE INTO season_claims SELECT * FROM old.season_claims WHERE user_id IN (SELECT id FROM main.users);
         INSERT OR IGNORE INTO achievements SELECT * FROM old.achievements WHERE user_id IN (SELECT id FROM main.users);
         INSERT OR REPLACE INTO season_stats SELECT o.* FROM old.season_stats o
           WHERE o.user_id IN (SELECT id FROM main.users)
             AND NOT EXISTS (SELECT 1 FROM main.season_stats m WHERE m.season_id = o.season_id AND m.user_id = o.user_id AND m.games >= o.games);`
      : '';
    // Comunidad: privacidad y moderación (gana lo más reciente), partidas públicas y eventos (solo se añaden).
    const community = ['user_privacy', 'moderation', 'public_games', 'community_events'].every((x) => oldTables.has(x))
      ? `INSERT OR REPLACE INTO user_privacy SELECT o.* FROM old.user_privacy o WHERE o.user_id IN (SELECT id FROM main.users)
           AND NOT EXISTS (SELECT 1 FROM main.user_privacy m WHERE m.user_id = o.user_id AND m.updated_at >= o.updated_at);
         INSERT OR REPLACE INTO moderation SELECT o.* FROM old.moderation o WHERE o.user_id IN (SELECT id FROM main.users)
           AND NOT EXISTS (SELECT 1 FROM main.moderation m WHERE m.user_id = o.user_id AND m.updated_at >= o.updated_at);
         INSERT OR IGNORE INTO public_games SELECT * FROM old.public_games;
         INSERT OR IGNORE INTO community_events SELECT * FROM old.community_events;`
      : '';
    const social = ['friend_codes', 'friendships', 'blocks', 'reports'].every((t) => oldTables.has(t))
      ? `INSERT OR IGNORE INTO friend_codes SELECT * FROM old.friend_codes WHERE user_id IN (SELECT id FROM main.users);
         INSERT OR IGNORE INTO friendships SELECT * FROM old.friendships
           WHERE low IN (SELECT id FROM main.users) AND high IN (SELECT id FROM main.users);
         UPDATE friendships SET status = 'accepted'
           WHERE status = 'pending' AND EXISTS (SELECT 1 FROM old.friendships o WHERE o.low = friendships.low AND o.high = friendships.high AND o.status = 'accepted');
         INSERT OR IGNORE INTO blocks SELECT * FROM old.blocks
           WHERE user_id IN (SELECT id FROM main.users) AND blocked_id IN (SELECT id FROM main.users);
         INSERT INTO reports (reporter_id, target_id, reason, ctx, created_at)
           SELECT o.reporter_id, o.target_id, o.reason, o.ctx, o.created_at FROM old.reports o
           WHERE o.reporter_id IN (SELECT id FROM main.users)
             AND NOT EXISTS (SELECT 1 FROM main.reports r WHERE r.reporter_id = o.reporter_id AND r.target_id = o.target_id AND r.created_at = o.created_at);`
      : '';
    const fair = oldTables.has('game_flags') ? 'INSERT OR IGNORE INTO game_flags SELECT * FROM old.game_flags;' : '';
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
      ${wallet}
      ${circuit}
      ${circuitState}
      ${progress}
      ${community}
      ${social}
      ${fair}
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
