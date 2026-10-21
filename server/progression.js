// Progresión verificada por el servidor: XP de cuenta, misiones, logros y temporadas.
//
// Todo lo que da XP o premios sale de hechos que el servidor presenció o puede comprobar:
//   · partidas online que él arbitró (`games`), no las que el cliente dice haber jugado;
//   · el desafío diario resuelto (`daily_results`), los torneos terminados (`tournament_results`);
//   · repeticiones de partidas propias (ownership + una vez por partida).
// Cada concesión es idempotente (clave `ref` única por jugador), así que recargar, repetir una petición o reenviar un
// evento no da XP dos veces. Los premios manuales (misiones, pase de temporada) se reclaman una sola vez por una
// restricción de la base de datos, dentro de la misma transacción que paga.
//
// No hay rachas: nada se reinicia ni caduca por faltar un día. Las misiones del periodo anterior se pueden reclamar
// un periodo más y las recompensas de una temporada, 14 días tras terminar.
import { XP_PER_LEVEL } from '../public/js/data.js';
import {
  ACHIEVEMENTS,
  SEASONS,
  SEASON_MIN_RANKED_GAMES,
  SEASON_RATING_CARRY,
  XP_RULES as R,
  dayIdOf,
  dayWindow,
  missionDef,
  missionProgress,
  missionsFor,
  seasonAt,
  seasonById,
  seasonClaimable,
  seasonLevelOf,
  seasonRewardFor,
  seasonStatus,
  weekIdOf,
  weekWindow,
} from '../public/js/progression-data.js';
import { levelUnlocks } from '../public/js/cosmetics-data.js';
import { START_RATING } from './elo.js';

const LEVEL_UNLOCKS = levelUnlocks();
import { analyzeGame, gameXp } from './xp-rules.js';

export const PROGRESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS progress_events (
    user_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    xp INTEGER NOT NULL,
    season_id INTEGER,
    at INTEGER NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, ref)
  );
  CREATE TABLE IF NOT EXISTS mission_claims (
    user_id TEXT NOT NULL,
    period TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, period, mission_id)
  );
  CREATE TABLE IF NOT EXISTS season_claims (
    user_id TEXT NOT NULL,
    season_id INTEGER NOT NULL,
    level INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, season_id, level)
  );
  CREATE TABLE IF NOT EXISTS achievements (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS season_stats (
    season_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    start_rating INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    peak INTEGER NOT NULL,
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (season_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_progress_user_at ON progress_events(user_id, at);
  CREATE INDEX IF NOT EXISTS idx_progress_season ON progress_events(user_id, season_id);
  CREATE INDEX IF NOT EXISTS idx_season_rank ON season_stats(season_id, rating DESC);
`;

const ABANDON_REASONS = new Set(['rendición', 'desconexión']);
const REASON_ERR = {
  unknown: 'No existe',
  incomplete: 'Aún no has cumplido el objetivo',
  claimed: 'Ya reclamaste esta recompensa',
  expired: 'Este periodo ya no admite reclamaciones',
  locked: 'Todavía no has alcanzado ese nivel',
  invalid: 'Petición no válida',
  notplayed: 'Solo puedes revisar partidas que jugaste y terminaste',
  dup: 'Ya estaba registrado',
};
export const progressMessage = (reason) => REASON_ERR[reason] ?? 'No se pudo completar la acción';

const parseMeta = (s) => {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
};
const periodNum = (period, prefix) => (typeof period === 'string' && period.startsWith(prefix) && /^\d{1,6}$/.test(period.slice(prefix.length)) ? Number(period.slice(prefix.length)) : null);

/**
 * @param {object} o
 * @param {ReturnType<import('./db.js').openDb>} o.db
 * @param {ReturnType<import('./wallet.js').createWallets>} o.wallets
 * @param {(userId: string, msg: object) => unknown} [o.notify]
 * @param {() => number} [o.now]   reloj (pruebas)
 */
export function createProgression({ db, wallets, notify = () => {}, now = Date.now, after = () => {} }) {
  const raw = db.raw;
  const q = {
    event: raw.prepare('SELECT 1 FROM progress_events WHERE user_id = ? AND ref = ?'),
    insertEvent: raw.prepare('INSERT OR IGNORE INTO progress_events (user_id,ref,kind,xp,season_id,at,meta) VALUES (?,?,?,?,?,?,?)'),
    between: raw.prepare('SELECT kind, xp, at, meta FROM progress_events WHERE user_id = ? AND at >= ? AND at < ? ORDER BY at'),
    recent: raw.prepare('SELECT kind, xp, at, meta FROM progress_events WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?'),
    gameXpSince: raw.prepare("SELECT COALESCE(SUM(xp),0) AS xp FROM progress_events WHERE user_id = ? AND kind = 'game' AND at >= ?"),
    reviewXpSince: raw.prepare("SELECT COALESCE(SUM(xp),0) AS xp FROM progress_events WHERE user_id = ? AND kind = 'review' AND at >= ?"),
    pairSince: raw.prepare("SELECT COUNT(*) AS n FROM progress_events WHERE user_id = ? AND kind = 'game' AND at >= ? AND json_extract(meta, '$.opp') = ?"),
    seasonXp: raw.prepare('SELECT COALESCE(SUM(xp),0) AS xp FROM progress_events WHERE user_id = ? AND season_id = ?'),
    seasonXps: raw.prepare('SELECT season_id, COALESCE(SUM(xp),0) AS xp FROM progress_events WHERE user_id = ? AND season_id IS NOT NULL GROUP BY season_id'),
    countKind: raw.prepare('SELECT COUNT(*) AS n FROM progress_events WHERE user_id = ? AND kind = ?'),
    missionClaim: raw.prepare('INSERT OR IGNORE INTO mission_claims (user_id,period,mission_id,at) VALUES (?,?,?,?)'),
    missionClaimed: raw.prepare('SELECT period, mission_id FROM mission_claims WHERE user_id = ? AND period IN (?, ?, ?, ?)'),
    missionCount: raw.prepare('SELECT COUNT(*) AS n FROM mission_claims WHERE user_id = ?'),
    seasonClaim: raw.prepare('INSERT OR IGNORE INTO season_claims (user_id,season_id,level,at) VALUES (?,?,?,?)'),
    seasonClaimed: raw.prepare('SELECT level FROM season_claims WHERE user_id = ? AND season_id = ?'),
    legacySeason: raw.prepare("SELECT ref FROM ledger WHERE user_id = ? AND source = 'season' AND ref LIKE ?"),
    achievements: raw.prepare('SELECT id, at FROM achievements WHERE user_id = ?'),
    insertAchievement: raw.prepare('INSERT OR IGNORE INTO achievements (user_id,id,at) VALUES (?,?,?)'),
    stats: raw.prepare(
      `SELECT COUNT(*) AS games,
              COALESCE(SUM(CASE WHEN winner = CASE WHEN white_id = ?1 THEN 'w' ELSE 'b' END THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(CASE WHEN rated = 1 THEN 1 ELSE 0 END), 0) AS rated,
              COALESCE(SUM(CASE WHEN reason = 'jaque mate' AND winner = CASE WHEN white_id = ?1 THEN 'w' ELSE 'b' END THEN 1 ELSE 0 END), 0) AS mates
       FROM games WHERE (white_id = ?1 OR black_id = ?1) AND reason != 'abortada' AND json_array_length(moves) >= ?2`,
    ),
    puzzles: raw.prepare('SELECT COUNT(*) AS n FROM daily_results WHERE user_id = ?'),
    circuitResults: raw.prepare(
      "SELECT COUNT(*) AS played, COALESCE(SUM(placement IN ('final','champion')),0) AS finals, COALESCE(SUM(placement = 'champion'),0) AS champions FROM tournament_results WHERE user_id = ?",
    ),
    getSeasonStats: raw.prepare('SELECT * FROM season_stats WHERE season_id = ? AND user_id = ?'),
    insertSeasonStats: raw.prepare('INSERT INTO season_stats (season_id,user_id,start_rating,rating,peak,games,wins,losses,draws,updated_at) VALUES (?,?,?,?,?,0,0,0,0,?)'),
    updateSeasonStats: raw.prepare('UPDATE season_stats SET rating = ?, peak = ?, games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?, updated_at = ? WHERE season_id = ? AND user_id = ?'),
    board: raw.prepare(
      `SELECT s.user_id AS id, u.name, s.rating, s.games, s.wins, s.peak FROM season_stats s JOIN users u ON u.id = s.user_id
       WHERE s.season_id = ? AND s.games >= ? ORDER BY s.rating DESC, s.games DESC, s.updated_at ASC LIMIT ?`,
    ),
    rankOf: raw.prepare('SELECT COUNT(*) + 1 AS rank FROM season_stats WHERE season_id = ? AND games >= ? AND rating > ?'),
    gamePlayers: raw.prepare('SELECT name FROM users WHERE id = ?'),
  };

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

  // Nombre público de otro jugador (para el historial propio); nunca se envía nada de otros usuarios más que su nombre.
  const nameOf = (id) => q.gamePlayers.get(id)?.name ?? 'Jugador';
  const itemId = (item) => (item ? `${item[0]}:${item[1]}` : null);

  // ----- Concesión de XP (idempotente por `ref`) -----
  // Dentro de la transacción en curso: registra el evento y paga monedas/XP/objeto por el libro de cuentas.
  function awardInTx(userId, { ref, kind, xp = 0, coins = 0, item = null, ledgerRef = `ev:${ref}`, source = 'xp', meta = {}, at = now(), fallbackCoins = 0 }) {
    if (q.event.get(userId, ref)) return { ok: false, reason: 'dup' };
    const season = seasonAt(at);
    q.insertEvent.run(userId, ref, kind, xp, season?.id ?? null, at, JSON.stringify(meta));
    const g = wallets.grantInTx(userId, { ref: ledgerRef, source, coins, xp, item, fallbackCoins });
    if (!g.ok) return { ok: false, reason: g.reason };
    return { ok: true, xp, coins: g.coins, item: g.item, level: g.level, leveledUp: g.level > g.levelBefore, levelBefore: g.levelBefore };
  }

  function push(userId, res, extra = {}) {
    if (!res?.ok) return;
    const unlocked = res.leveledUp ? LEVEL_UNLOCKS.filter((u) => u.level > res.levelBefore && u.level <= res.level) : [];
    try {
      after(userId, res); // p. ej. conceder los cosméticos que se desbloquean por nivel o por logro
    } catch (err) {
      console.error('[progression] after', err);
    }
    notify(userId, { t: 'progress', xp: res.xp, coins: res.coins, level: res.level, leveledUp: res.leveledUp, unlocked, ...extra });
  }

  // ----- Estadísticas verificadas (para los logros) -----
  function statsOf(userId) {
    const g = q.stats.get(userId, R.minPlies);
    const c = q.circuitResults.get(userId);
    const circuitJoins = q.countKind.get(userId, 'circuit_join').n;
    let seasonLevel = 0;
    for (const row of q.seasonXps.all(userId)) {
      const s = seasonById(row.season_id);
      if (s) seasonLevel = Math.max(seasonLevel, seasonLevelOf(s, row.xp));
    }
    return {
      games: g.games,
      wins: g.wins,
      rated: g.rated,
      mates: g.mates,
      puzzles: q.puzzles.get(userId).n,
      circuits: Math.max(c.played, circuitJoins),
      circuitFinals: c.finals,
      champions: c.champions,
      reviews: q.countKind.get(userId, 'review').n,
      missions: q.missionCount.get(userId).n,
      level: wallets.ensure(userId).level,
      seasonLevel,
    };
  }

  // Desbloquea y paga los logros cuyo hito ya se cumple. Es idempotente y recupera también los hitos del historial anterior.
  function checkAchievements(userId) {
    const newly = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const stats = statsOf(userId);
      const have = new Set(q.achievements.all(userId).map((r) => r.id));
      const todo = ACHIEVEMENTS.filter((a) => !have.has(a.id) && (stats[a.stat] ?? 0) >= a.target);
      if (!todo.length) break;
      for (const a of todo) {
        const res = tx(() => {
          if (q.insertAchievement.run(userId, a.id, now()).changes !== 1) return null;
          return awardInTx(userId, { ref: `ach:${a.id}`, kind: 'achievement', xp: a.xp, coins: a.coins, ledgerRef: `ach:${a.id}`, source: 'achievement', meta: { id: a.id } });
        });
        if (res?.ok) {
          newly.push(a.id);
          push(userId, res, { achievement: a.id });
        }
      }
    }
    return newly;
  }

  // ----- Partidas -----
  /**
   * Gancho al terminar una sala (rooms.js). Solo cuenta lo que el servidor guardó como partida completa:
   * sin abortadas, con un mínimo de jugadas, un máximo de partidas por pareja y día y un tope suave diario de XP.
   */
  function recordGame(room) {
    const g = room.gameId ? db.gameById(room.gameId) : null;
    if (!g || g.reason === 'abortada') return;
    const moves = JSON.parse(g.moves);
    if (moves.length < R.minPlies) return;
    const at = now();
    const delta = room.ratingDelta; // { w, b, ratings: { w, b } } si hubo cambio de rating
    const pre = (c) => (delta ? delta.ratings[c] - delta[c] : room.players[c]?.rating);
    for (const color of ['w', 'b']) {
      const userId = color === 'w' ? g.white_id : g.black_id;
      const oppId = color === 'w' ? g.black_id : g.white_id;
      if (!userId || !oppId || userId === oppId) continue;
      const result = !g.winner ? 'draw' : g.winner === color ? 'win' : 'loss';
      const abandon = result === 'loss' && ABANDON_REASONS.has(g.reason);
      const underdog = !!g.rated && result === 'win' && Number.isFinite(pre(color)) && Number.isFinite(pre(color === 'w' ? 'b' : 'w')) && pre(color === 'w' ? 'b' : 'w') - pre(color) >= 100;
      const facts = analyzeGame(moves, color);
      let { xp } = gameXp({ facts, result, abandon, rated: !!g.rated, underdog });
      const dayStart = dayWindow(dayIdOf(at))[0];
      // Misma pareja: solo las primeras partidas del día cuentan (evita granjear con una cuenta amiga).
      if (q.pairSince.get(userId, dayStart, oppId).n >= R.pairPerDay) continue;
      // Tope suave diario: pasado el tope, la XP baja al 25 % (no se castiga: se amortigua).
      if (q.gameXpSince.get(userId, dayStart).xp >= R.dailySoftCap) xp = Math.round(xp * R.softFactor);
      const meta = { gameId: g.id, opp: oppId, oppName: nameOf(oppId), result, abandon, rated: !!g.rated, color, circuit: !!room.circuit, checks: facts.checks, mate: facts.mate, promotions: facts.promotions, lostQueen: facts.lostQueen, underdog, plies: moves.length };
      const res = tx(() => awardInTx(userId, { ref: `game:${g.id}`, kind: 'game', xp, meta, at }));
      push(userId, res, { source: 'game' });
      if (res.ok) checkAchievements(userId);
    }
    if (g.rated && delta && !room.unrated) recordRated(g, delta, at);
  }

  // Clasificación de temporada: rating propio de cada temporada que arranca a medio camino de 1000 y suma los cambios Elo.
  function recordRated(g, delta, at) {
    const s = seasonAt(at);
    if (!s) return;
    for (const color of ['w', 'b']) {
      const userId = color === 'w' ? g.white_id : g.black_id;
      const change = delta[color];
      const result = !g.winner ? 0.5 : g.winner === color ? 1 : 0;
      tx(() => {
        let row = q.getSeasonStats.get(s.id, userId);
        if (!row) {
          const before = delta.ratings[color] - change;
          const start = Math.max(100, Math.round(START_RATING + (before - START_RATING) * SEASON_RATING_CARRY));
          q.insertSeasonStats.run(s.id, userId, start, start, start, at);
          row = q.getSeasonStats.get(s.id, userId);
        }
        const rating = Math.max(100, row.rating + change);
        q.updateSeasonStats.run(rating, Math.max(row.peak, rating), result === 1 ? 1 : 0, result === 0 ? 1 : 0, result === 0.5 ? 1 : 0, at, s.id, userId);
      });
    }
  }

  // ----- Otros eventos verificados -----
  function recordPuzzle(userId, day) {
    const res = tx(() => awardInTx(userId, { ref: `puzzle:${day}`, kind: 'puzzle', xp: R.puzzle, meta: { day } }));
    push(userId, res, { source: 'puzzle' });
    if (res.ok) checkAchievements(userId);
    return res;
  }

  function recordCircuitJoin(userIds, tid) {
    for (const userId of userIds) {
      const res = tx(() => awardInTx(userId, { ref: `circuitjoin:${tid}`, kind: 'circuit_join', xp: 0, meta: { tid } }));
      if (res.ok) checkAchievements(userId);
    }
  }

  function recordCircuitResults(results, tid) {
    for (const r of results) {
      const res = tx(() => awardInTx(r.userId, { ref: `circuit:${tid}`, kind: 'circuit', xp: r.xp ?? 0, meta: { tid, placement: r.placement } }));
      push(r.userId, res, { source: 'circuit' });
      checkAchievements(r.userId);
    }
  }

  /** Revisar una partida propia en la repetición: una vez por partida, solo de partidas terminadas del jugador. */
  function recordReview(userId, gameId, ply) {
    const g = typeof gameId === 'string' && /^[\w-]{8,64}$/.test(gameId) ? db.gameById(gameId) : null;
    if (!g || (g.white_id !== userId && g.black_id !== userId) || g.reason === 'abortada') return { ok: false, reason: 'notplayed' };
    const plies = JSON.parse(g.moves).length;
    if (plies < R.minPlies || !Number.isInteger(ply) || ply < plies) return { ok: false, reason: 'notplayed' }; // hay que llegar a la última jugada
    const at = now();
    const dayStart = dayWindow(dayIdOf(at))[0];
    const res = tx(() => {
      const capped = q.reviewXpSince.get(userId, dayStart).xp >= R.reviewDailyCap;
      return awardInTx(userId, { ref: `review:${gameId}`, kind: 'review', xp: capped ? 0 : R.review, meta: { gameId }, at });
    });
    push(userId, res, { source: 'review' });
    if (res.ok) checkAchievements(userId);
    return res.ok ? { ok: true, xp: res.xp } : { ok: false, reason: 'dup' };
  }

  // ----- Misiones -----
  const eventsIn = (userId, [from, to]) => q.between.all(userId, from, to).map((e) => ({ ...e, meta: parseMeta(e.meta) }));

  function missionBlock(userId, kind, periodId, claimed) {
    const prefix = kind === 'daily' ? 'd' : 'w';
    const window = kind === 'daily' ? dayWindow(periodId) : weekWindow(periodId);
    const events = eventsIn(userId, window);
    const period = `${prefix}${periodId}`;
    return {
      period,
      startsAt: window[0],
      endsAt: window[1],
      items: missionsFor(kind, periodId).map((def) => {
        const progress = missionProgress(def, events);
        const isClaimed = claimed.has(`${period}|${def.id}`);
        const state = isClaimed ? 'claimed' : progress >= def.target ? 'completed' : progress > 0 ? 'inprogress' : 'pending';
        return { id: def.id, text: def.text, target: def.target, progress, coins: def.coins, xp: def.xp, state };
      }),
    };
  }

  function claimMission(userId, { kind, id, period }) {
    if (kind !== 'daily' && kind !== 'weekly') return { ok: false, reason: 'invalid' };
    const periodId = periodNum(period, kind === 'daily' ? 'd' : 'w');
    const def = missionDef(kind, id);
    if (periodId === null || !def) return { ok: false, reason: 'unknown' };
    const t = now();
    const cur = kind === 'daily' ? dayIdOf(t) : weekIdOf(t);
    if (periodId > cur || periodId < cur - 1) return { ok: false, reason: 'expired' }; // el periodo actual y el anterior
    if (!missionsFor(kind, periodId).some((m) => m.id === def.id)) return { ok: false, reason: 'unknown' };
    const window = kind === 'daily' ? dayWindow(periodId) : weekWindow(periodId);
    const res = tx(() => {
      // El progreso se recalcula aquí, con los eventos verificados: lo que diga el cliente no cuenta.
      if (missionProgress(def, eventsIn(userId, window)) < def.target) return { ok: false, reason: 'incomplete' };
      if (q.missionClaim.run(userId, period, def.id, t).changes !== 1) return { ok: false, reason: 'claimed' };
      return awardInTx(userId, { ref: `mission:${period}:${def.id}`, kind: 'mission', xp: def.xp, coins: def.coins, ledgerRef: `mission:${period}:${def.id}`, source: 'mission', meta: { id: def.id, period }, at: t });
    });
    if (res.ok) {
      push(userId, res, { source: 'mission' });
      checkAchievements(userId);
    }
    return res;
  }

  // ----- Temporadas -----
  const seasonXpOf = (userId, seasonId) => q.seasonXp.get(userId, seasonId).xp;

  function claimedLevels(userId, s) {
    const set = new Set(q.seasonClaimed.all(userId, s.id).map((r) => r.level));
    // Compatibilidad: lo reclamado con el sistema anterior queda en el libro de cuentas como `season:<id>:<nivel>`.
    for (const r of q.legacySeason.all(userId, `season:${s.id}:%`)) set.add(Number(r.ref.split(':')[2]));
    return set;
  }

  function claimSeason(userId, { season, level }) {
    const s = seasonById(season);
    const lvl = Number(level);
    if (!s || !Number.isInteger(lvl) || lvl < 1 || lvl > s.levels) return { ok: false, reason: 'unknown' };
    const t = now();
    if (!seasonClaimable(s, t)) return { ok: false, reason: 'expired' };
    const res = tx(() => {
      if (lvl > seasonLevelOf(s, seasonXpOf(userId, s.id))) return { ok: false, reason: 'locked' };
      if (claimedLevels(userId, s).has(lvl)) return { ok: false, reason: 'claimed' };
      const r = seasonRewardFor(s, lvl);
      if (q.seasonClaim.run(userId, s.id, lvl, t).changes !== 1) return { ok: false, reason: 'claimed' };
      const out = awardInTx(userId, { ref: `seasonclaim:${s.id}:${lvl}`, kind: 'season_reward', xp: 0, coins: r.coins ?? 0, item: itemId(r.item), fallbackCoins: 60, ledgerRef: `season:${s.id}:${lvl}`, source: 'season', meta: { season: s.id, level: lvl }, at: t });
      if (!out.ok) throw new Error('premio de temporada ya registrado'); // deshace el reclamo: nada queda a medias
      return out;
    });
    if (res.ok) push(userId, res, { source: 'season' });
    return res;
  }

  function seasonView(userId, s, t) {
    const xp = seasonXpOf(userId, s.id);
    const level = seasonLevelOf(s, xp);
    const claimed = claimedLevels(userId, s);
    const canClaim = seasonClaimable(s, t);
    const track = Array.from({ length: s.levels }, (_, i) => {
      const l = i + 1;
      const r = seasonRewardFor(s, l);
      return { level: l, coins: r.coins ?? 0, item: itemId(r.item), label: r.label ?? null, state: claimed.has(l) ? 'claimed' : l <= level ? (canClaim ? 'open' : 'expired') : 'locked' };
    });
    const mine = q.getSeasonStats.get(s.id, userId);
    return {
      id: s.id,
      name: s.name,
      short: s.short,
      theme: s.theme,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      status: seasonStatus(s, t),
      levels: s.levels,
      xpPerLevel: s.xpPerLevel,
      xp,
      level,
      into: level >= s.levels ? 0 : xp - level * s.xpPerLevel,
      claimable: track.filter((x) => x.state === 'open').length,
      claimableUntil: s.endsAt,
      track,
      ranking: mine
        ? { rating: mine.rating, peak: mine.peak, games: mine.games, wins: mine.wins, losses: mine.losses, draws: mine.draws, rank: mine.games >= SEASON_MIN_RANKED_GAMES ? q.rankOf.get(s.id, SEASON_MIN_RANKED_GAMES, mine.rating).rank : null }
        : { rating: null, games: 0, rank: null },
    };
  }

  function leaderboard(seasonId, userId = null, limit = 20) {
    const s = seasonById(seasonId);
    if (!s) return null;
    const top = q.board.all(s.id, SEASON_MIN_RANKED_GAMES, Math.min(100, Math.max(1, limit))).map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, rating: r.rating, games: r.games, wins: r.wins }));
    const mine = userId ? q.getSeasonStats.get(s.id, userId) : null;
    return {
      season: { id: s.id, name: s.name, status: seasonStatus(s, now()) },
      minGames: SEASON_MIN_RANKED_GAMES,
      top,
      me: mine ? { rating: mine.rating, games: mine.games, rank: mine.games >= SEASON_MIN_RANKED_GAMES ? q.rankOf.get(s.id, SEASON_MIN_RANKED_GAMES, mine.rating).rank : null } : null,
    };
  }

  // ----- Vista completa para la página de progresión -----
  function summary(userId) {
    checkAchievements(userId); // también recupera los hitos del historial anterior
    const t = now();
    const w = wallets.ensure(userId);
    const stats = statsOf(userId);
    const day = dayIdOf(t);
    const week = weekIdOf(t);
    const claimed = new Set();
    for (const r of q.missionClaimed.all(userId, `d${day}`, `d${day - 1}`, `w${week}`, `w${week - 1}`)) claimed.add(`${r.period}|${r.mission_id}`);
    const unlockedAch = new Map(q.achievements.all(userId).map((r) => [r.id, r.at]));
    const current = seasonAt(t);
    const upcoming = SEASONS.find((s) => seasonStatus(s, t) === 'upcoming') ?? null;
    const past = SEASONS.filter((s) => seasonStatus(s, t) === 'past').map((s) => {
      const v = seasonView(userId, s, t);
      return { id: s.id, name: s.name, theme: s.theme, endsAt: s.endsAt, level: v.level, levels: v.levels, claimable: v.claimable, openLevels: v.track.filter((x) => x.state === 'open').map((x) => x.level), ranking: v.ranking };
    });
    return {
      now: t,
      userId,
      account: { level: w.level, xp: w.xp, next: XP_PER_LEVEL(w.level), coins: w.coins },
      season: current ? seasonView(userId, current, t) : null,
      upcoming: upcoming && { id: upcoming.id, name: upcoming.name, startsAt: upcoming.startsAt, theme: upcoming.theme },
      pastSeasons: past,
      missions: {
        daily: missionBlock(userId, 'daily', day, claimed),
        weekly: missionBlock(userId, 'weekly', week, claimed),
        // Lo completado y sin reclamar del periodo anterior sigue reclamable un periodo más.
        carryover: [
          ...missionBlock(userId, 'daily', day - 1, claimed).items.filter((m) => m.state === 'completed').map((m) => ({ ...m, kind: 'daily', period: `d${day - 1}` })),
          ...missionBlock(userId, 'weekly', week - 1, claimed).items.filter((m) => m.state === 'completed').map((m) => ({ ...m, kind: 'weekly', period: `w${week - 1}` })),
        ],
      },
      achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, text: a.text, target: a.target, progress: Math.min(a.target, stats[a.stat] ?? 0), coins: a.coins, xp: a.xp, unlockedAt: unlockedAch.get(a.id) ?? null })),
      unlocks: LEVEL_UNLOCKS.map((u) => ({ ...u, unlocked: u.level <= w.level })),
      history: q.recent.all(userId, 30).map((e) => {
        const m = parseMeta(e.meta);
        return { kind: e.kind, xp: e.xp, at: e.at, label: m.oppName ?? m.id ?? m.tid ?? null, result: m.result ?? null };
      }),
      rules: R,
    };
  }

  return { summary, recordGame, recordPuzzle, recordCircuitJoin, recordCircuitResults, recordReview, claimMission, claimSeason, leaderboard, checkAchievements, statsOf };
}
