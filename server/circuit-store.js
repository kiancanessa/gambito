// Persistencia del Royale Circuit. Cada paso que cambia el cuadro es una transacción con comprobación de estado
// (compare-and-set): si dos llamadas intentan cerrar el mismo partido o colocar a dos jugadores en la misma plaza,
// solo una prospera y la otra recibe `{ ok: false }`. Así un jugador no puede avanzar dos veces ni ocupar dos plazas.
//
// Las tablas guardan el torneo, los inscritos y cada partido de cada ronda; al reiniciar el servidor se reconstruye todo
// desde aquí (ver `CircuitManager.recover`). La tabla heredada `tournaments`/`tournament_results` sigue siendo el historial
// y la fuente de los premios que cobra la cartera.

export const CIRCUIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS circuit_tournaments (
    id TEXT PRIMARY KEY,
    format TEXT NOT NULL,
    name TEXT NOT NULL,
    tc TEXT NOT NULL,
    size INTEGER NOT NULL,
    min_players INTEGER NOT NULL,
    status TEXT NOT NULL,
    reg_opens_at INTEGER NOT NULL,
    reg_closes_at INTEGER NOT NULL,
    starts_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    champion_id TEXT,
    cancel_reason TEXT,
    rounds INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS circuit_entries (
    tournament_id TEXT NOT NULL REFERENCES circuit_tournaments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL,
    seed INTEGER,
    status TEXT NOT NULL,
    placement TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (tournament_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS circuit_matches (
    tournament_id TEXT NOT NULL REFERENCES circuit_tournaments(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    a_id TEXT,
    b_id TEXT,
    status TEXT NOT NULL,
    winner_id TEXT,
    reason TEXT,
    draws INTEGER NOT NULL DEFAULT 0,
    code TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tournament_id, round, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_circuit_status ON circuit_tournaments(status, starts_at);
  CREATE INDEX IF NOT EXISTS idx_circuit_entries_user ON circuit_entries(user_id);
`;

export const LIVE_STATUSES = ['scheduled', 'open', 'closed', 'running'];
const TOURNAMENT_FIELDS = new Set(['status', 'starts_at', 'reg_opens_at', 'reg_closes_at', 'started_at', 'finished_at', 'champion_id', 'cancel_reason', 'rounds']);

export function createCircuitStore(raw) {
  const q = {
    insertT: raw.prepare(
      `INSERT INTO circuit_tournaments (id,format,name,tc,size,min_players,status,reg_opens_at,reg_closes_at,starts_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    getT: raw.prepare('SELECT * FROM circuit_tournaments WHERE id = ?'),
    entriesOf: raw.prepare('SELECT * FROM circuit_entries WHERE tournament_id = ? ORDER BY joined_at, user_id'),
    matchesOf: raw.prepare('SELECT * FROM circuit_matches WHERE tournament_id = ? ORDER BY round, slot'),
    liveTs: raw.prepare(`SELECT * FROM circuit_tournaments WHERE status IN (${LIVE_STATUSES.map(() => '?').join(',')}) ORDER BY starts_at`),
    countEntries: raw.prepare("SELECT COUNT(*) AS n FROM circuit_entries WHERE tournament_id = ? AND status = 'registered'"),
    entryOf: raw.prepare('SELECT status FROM circuit_entries WHERE tournament_id = ? AND user_id = ?'),
    busy: raw.prepare(
      `SELECT e.tournament_id FROM circuit_entries e JOIN circuit_tournaments t ON t.id = e.tournament_id
       WHERE e.user_id = ? AND e.tournament_id != ? AND e.status IN ('registered','active') AND t.status IN ('scheduled','open','closed','running') LIMIT 1`,
    ),
    insertEntry: raw.prepare("INSERT INTO circuit_entries (tournament_id,user_id,name,rating,status,joined_at) VALUES (?,?,?,?,'registered',?)"),
    deleteEntry: raw.prepare("DELETE FROM circuit_entries WHERE tournament_id = ? AND user_id = ? AND status = 'registered'"),
    startT: raw.prepare("UPDATE circuit_tournaments SET status = 'running', started_at = ?, rounds = ?, rev = rev + 1 WHERE id = ? AND status = 'closed'"),
    entryAbsent: raw.prepare("UPDATE circuit_entries SET status = 'absent' WHERE tournament_id = ? AND user_id = ? AND status = 'registered'"),
    entrySeed: raw.prepare("UPDATE circuit_entries SET status = 'active', seed = ? WHERE tournament_id = ? AND user_id = ? AND status = 'registered'"),
    insertMatch: raw.prepare('INSERT INTO circuit_matches (tournament_id,round,slot,a_id,b_id,status,winner_id,reason,draws,code,updated_at) VALUES (?,?,?,?,?,?,?,?,0,NULL,?)'),
    matchState: raw.prepare("UPDATE circuit_matches SET status = ?, code = ?, draws = ?, updated_at = ? WHERE tournament_id = ? AND round = ? AND slot = ? AND status != 'done'"),
    doneMatch: raw.prepare(
      `UPDATE circuit_matches SET status = 'done', winner_id = ?, reason = ?, updated_at = ?
       WHERE tournament_id = ? AND round = ? AND slot = ? AND status != 'done' AND a_id IS NOT NULL AND b_id IS NOT NULL
         AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))`,
    ),
    loserOut: raw.prepare("UPDATE circuit_entries SET status = 'out', placement = ? WHERE tournament_id = ? AND user_id = ? AND status = 'active'"),
    fillA: raw.prepare("UPDATE circuit_matches SET a_id = ?, updated_at = ? WHERE tournament_id = ? AND round = ? AND slot = ? AND a_id IS NULL AND status = 'pending'"),
    fillB: raw.prepare("UPDATE circuit_matches SET b_id = ?, updated_at = ? WHERE tournament_id = ? AND round = ? AND slot = ? AND b_id IS NULL AND status = 'pending'"),
    readyMatch: raw.prepare("UPDATE circuit_matches SET status = 'ready', updated_at = ? WHERE tournament_id = ? AND round = ? AND slot = ? AND status = 'pending' AND a_id IS NOT NULL AND b_id IS NOT NULL"),
    finishT: raw.prepare("UPDATE circuit_tournaments SET status = 'finished', finished_at = ?, champion_id = ?, rev = rev + 1 WHERE id = ? AND status = 'running'"),
    champEntry: raw.prepare("UPDATE circuit_entries SET status = 'champion', placement = 'champion' WHERE tournament_id = ? AND user_id = ? AND status = 'active'"),
    cancelT: raw.prepare(
      "UPDATE circuit_tournaments SET status = 'cancelled', finished_at = ?, cancel_reason = ?, rev = rev + 1 WHERE id = ? AND status IN ('scheduled','open','closed')",
    ),
    legacyT: raw.prepare('INSERT OR IGNORE INTO tournaments (id,tc,size,champion,bracket,created_at,finished_at) VALUES (?,?,?,?,?,?,?)'),
    legacyR: raw.prepare('INSERT OR IGNORE INTO tournament_results (tournament_id,user_id,placement,coins,xp,item,created_at) VALUES (?,?,?,?,?,?,?)'),
    recent: raw.prepare(
      `SELECT t.id, t.format, t.name, t.tc, t.size, t.status, t.starts_at, t.finished_at, t.cancel_reason, t.champion_id, t.rounds,
              (SELECT name FROM circuit_entries c WHERE c.tournament_id = t.id AND c.user_id = t.champion_id) AS champion_name,
              (SELECT COUNT(*) FROM circuit_entries c WHERE c.tournament_id = t.id AND c.status IN ('active','out','champion')) AS players
       FROM circuit_tournaments t WHERE t.status IN ('finished','cancelled') ORDER BY t.finished_at DESC LIMIT ?`,
    ),
    mineRecent: raw.prepare(
      `SELECT t.id, t.name, t.status, t.finished_at, e.placement FROM circuit_entries e JOIN circuit_tournaments t ON t.id = e.tournament_id
       WHERE e.user_id = ? AND t.status IN ('finished','cancelled') AND e.status IN ('out','champion','active') ORDER BY t.finished_at DESC LIMIT ?`,
    ),
  };

  // BEGIN IMMEDIATE: toma el bloqueo de escritura desde el principio, así dos operaciones nunca se intercalan.
  function tx(fn) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        raw.exec('ROLLBACK');
      } catch {
        /* sin transacción abierta */
      }
      throw err;
    }
  }

  const load = (row) => row && { ...row, entries: q.entriesOf.all(row.id), matches: q.matchesOf.all(row.id) };

  return {
    tx,
    create(t) {
      q.insertT.run(t.id, t.format, t.name, t.tc, t.size, t.minPlayers, t.status, t.regOpensAt, t.regClosesAt, t.startsAt, t.createdAt);
    },
    get: (id) => q.getT.get(id) ?? null,
    load: (id) => load(q.getT.get(id)),
    loadLive: () => q.liveTs.all(...LIVE_STATUSES).map(load),

    /** Cambia campos del torneo (lista blanca) y sube la revisión. `from`: estados desde los que se permite (compare-and-set). */
    update(id, fields, from = null) {
      const keys = Object.keys(fields);
      if (!keys.length || keys.some((k) => !TOURNAMENT_FIELDS.has(k))) throw new Error('campo de torneo no permitido');
      const where = from ? ` AND status IN (${from.map(() => '?').join(',')})` : '';
      const r = raw
        .prepare(`UPDATE circuit_tournaments SET ${keys.map((k) => `${k} = ?`).join(', ')}, rev = rev + 1 WHERE id = ?${where}`)
        .run(...keys.map((k) => fields[k]), id, ...(from ?? []));
      return r.changes === 1;
    },

    /** Inscripción: una plaza por usuario y torneo, un solo torneo vivo por usuario, dentro de plazo y con cupo. */
    register(tid, user, now) {
      return tx(() => {
        const t = q.getT.get(tid);
        if (!t) return { ok: false, reason: 'unknown' };
        if (t.status !== 'open' || now >= t.reg_closes_at) return { ok: false, reason: 'closed' };
        if (q.entryOf.get(tid, user.id)) return { ok: false, reason: 'already' };
        if (q.busy.get(user.id, tid)) return { ok: false, reason: 'busy' };
        if (q.countEntries.get(tid).n >= t.size) return { ok: false, reason: 'full' };
        q.insertEntry.run(tid, user.id, user.name, user.rating ?? 1000, now);
        return { ok: true, count: q.countEntries.get(tid).n };
      });
    },

    withdraw(tid, userId, now) {
      return tx(() => {
        const t = q.getT.get(tid);
        if (!t) return { ok: false, reason: 'unknown' };
        if (t.status !== 'open' || now >= t.reg_closes_at) return { ok: false, reason: 'closed' };
        return q.deleteEntry.run(tid, userId).changes === 1 ? { ok: true } : { ok: false, reason: 'notin' };
      });
    },

    /** Arranca el torneo de una vez: ausentes fuera, cabezas de serie, todos los partidos del cuadro (byes ya resueltos). */
    start({ tid, absent, seeds, matches, rounds, now }) {
      return tx(() => {
        if (q.startT.run(now, rounds, tid).changes !== 1) return { ok: false, reason: 'state' };
        for (const id of absent) q.entryAbsent.run(tid, id);
        for (const { id, seed } of seeds) if (q.entrySeed.run(seed, tid, id).changes !== 1) throw new Error('inscrito no válido');
        for (const m of matches) q.insertMatch.run(tid, m.round, m.slot, m.aId, m.bId, m.status, m.winnerId ?? null, m.reason ?? null, now);
        return { ok: true };
      });
    },

    setMatch(tid, round, slot, { status, code = null, draws = 0 }, now) {
      return q.matchState.run(status, code, draws, now, tid, round, slot).changes === 1;
    },

    /**
     * Cierra un partido y hace avanzar al ganador, todo en una transacción. Solo prospera una vez por partido
     * (`status != 'done'`), solo con los dos jugadores reales del partido, y la plaza siguiente solo se rellena si estaba vacía.
     */
    completeMatch({ tid, round, slot, winnerId, loserId, reason, placement, next, now }) {
      return tx(() => {
        if (q.doneMatch.run(winnerId, reason, now, tid, round, slot, winnerId, loserId, loserId, winnerId).changes !== 1) return { ok: false, reason: 'dup' };
        if (q.loserOut.run(placement, tid, loserId).changes !== 1) throw new Error('el perdedor ya estaba eliminado');
        let ready = false;
        if (next) {
          const fill = next.side === 'a' ? q.fillA : q.fillB;
          if (fill.run(winnerId, now, tid, next.round, next.slot).changes !== 1) throw new Error('la plaza siguiente ya estaba ocupada');
          ready = q.readyMatch.run(now, tid, next.round, next.slot).changes === 1;
        }
        return { ok: true, ready };
      });
    },

    /** Final del torneo: campeón, historial heredado y premios (idempotente: INSERT OR IGNORE por torneo y jugador). */
    finish({ tid, championId, now, legacy, results }) {
      return tx(() => {
        if (q.finishT.run(now, championId, tid).changes !== 1) return { ok: false, reason: 'state' };
        if (q.champEntry.run(tid, championId).changes !== 1) throw new Error('el campeón no estaba en competición');
        q.legacyT.run(tid, legacy.tc, legacy.size, legacy.champion, legacy.bracket, legacy.createdAt, now);
        for (const r of results) q.legacyR.run(tid, r.userId, r.placement, r.coins ?? 0, r.xp ?? 0, r.item ?? null, now);
        return { ok: true };
      });
    },

    cancel: (tid, reason, now) => q.cancelT.run(now, reason, tid).changes === 1,
    recent: (limit = 10) => q.recent.all(limit),
    recentOf: (userId, limit = 10) => q.mineRecent.all(userId, limit),
  };
}
