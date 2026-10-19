// Persistencia en SQLite (módulo integrado de Node, sin dependencias nativas).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIN_RATING, START_RATING } from './elo.js';

const publicUser = (u) =>
  u && { id: u.id, name: u.name, rating: u.rating, games: u.games, wins: u.wins, losses: u.losses, draws: u.draws };

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      recovery_hash TEXT UNIQUE,
      rating INTEGER NOT NULL DEFAULT ${START_RATING},
      games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saves (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      white_id TEXT NOT NULL,
      black_id TEXT NOT NULL,
      winner TEXT,
      reason TEXT,
      moves TEXT NOT NULL,
      rated INTEGER NOT NULL,
      tc TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_results (
      day INTEGER NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seconds REAL NOT NULL,
      attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (day, user_id)
    );
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      coins INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      level INTEGER NOT NULL,
      owned TEXT NOT NULL,
      equipped TEXT NOT NULL,
      rev INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      source TEXT NOT NULL,
      coins INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, ref)
    );
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      tc TEXT NOT NULL,
      size INTEGER NOT NULL,
      champion TEXT NOT NULL,
      bracket TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tournament_results (
      tournament_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      placement TEXT NOT NULL,
      coins INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      item TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tournament_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS friend_codes (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS friendships (
      low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (low, high)
    );
    CREATE TABLE IF NOT EXISTS blocks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, blocked_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      ctx TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_results(day, seconds);
  `);

  const q = {
    insertUser: db.prepare('INSERT INTO users (id,name,token_hash,recovery_hash,created_at,last_seen) VALUES (?,?,?,?,?,?)'),
    byToken: db.prepare('SELECT * FROM users WHERE token_hash = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byRecovery: db.prepare('SELECT * FROM users WHERE recovery_hash = ?'),
    touch: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    setToken: db.prepare('UPDATE users SET token_hash = ? WHERE id = ?'),
    setRecovery: db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    getSave: db.prepare('SELECT data, updated_at FROM saves WHERE user_id = ?'),
    putSave: db.prepare(
      'INSERT INTO saves (user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at',
    ),
    insertGame: db.prepare('INSERT INTO games (id,code,white_id,black_id,winner,reason,moves,rated,tc,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    applyRating: db.prepare(
      'UPDATE users SET rating = MAX(?, ?), games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?',
    ),
    leaderboard: db.prepare('SELECT id,name,rating,games,wins FROM users WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT ?'),
    rankOf: db.prepare('SELECT COUNT(*) + 1 AS rank FROM users WHERE games > 0 AND rating > ?'),
    dailyInsert: db.prepare('INSERT OR IGNORE INTO daily_results (day,user_id,seconds,attempts,created_at) VALUES (?,?,?,?,?)'),
    dailyTop: db.prepare(
      'SELECT d.seconds, d.attempts, u.id, u.name FROM daily_results d JOIN users u ON u.id = d.user_id WHERE d.day = ? ORDER BY d.seconds ASC, d.created_at ASC LIMIT ?',
    ),
    dailyMine: db.prepare('SELECT seconds, attempts FROM daily_results WHERE day = ? AND user_id = ?'),
    dailyRank: db.prepare('SELECT COUNT(*) + 1 AS rank FROM daily_results WHERE day = ? AND seconds < ?'),
    gamesOf: db.prepare(
      `SELECT g.id, g.code, g.winner, g.reason, g.rated, g.tc, g.created_at, g.white_id, g.black_id, json_array_length(g.moves) AS plies,
              w.name AS white_name, b.name AS black_name
       FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
       WHERE g.white_id = ? OR g.black_id = ? ORDER BY g.created_at DESC LIMIT ?`,
    ),
    gameById: db.prepare(
      `SELECT g.*, w.name AS white_name, w.rating AS white_rating, b.name AS black_name, b.rating AS black_rating
       FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id WHERE g.id = ?`,
    ),
    insertTournament: db.prepare('INSERT OR IGNORE INTO tournaments (id,tc,size,champion,bracket,created_at,finished_at) VALUES (?,?,?,?,?,?,?)'),
    insertResult: db.prepare('INSERT OR IGNORE INTO tournament_results (tournament_id,user_id,placement,coins,xp,item,created_at) VALUES (?,?,?,?,?,?,?)'),
    resultOf: db.prepare('SELECT placement, coins, xp, item FROM tournament_results WHERE tournament_id = ? AND user_id = ?'),
    resultsOf: db.prepare('SELECT tournament_id AS id, placement, coins, xp, item, created_at AS at FROM tournament_results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
    champions: db.prepare('SELECT champion AS name, finished_at AS at FROM tournaments ORDER BY finished_at DESC LIMIT ?'),
    gameByCode: db.prepare('SELECT * FROM games WHERE code = ? AND (white_id = ? OR black_id = ?) ORDER BY created_at DESC LIMIT 1'),
    dailyCount: db.prepare('SELECT COUNT(*) AS n FROM daily_results WHERE day = ?'),
    counts: db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM games WHERE created_at > ?) AS gamesToday'),
  };

  return {
    raw: db,
    close: () => db.close(),
    createUser({ id, name, tokenHash, recoveryHash }) {
      const now = Date.now();
      q.insertUser.run(id, name, tokenHash, recoveryHash, now, now);
      return publicUser(q.byId.get(id));
    },
    userByToken(hash) {
      const u = q.byToken.get(hash);
      if (u) q.touch.run(Date.now(), u.id);
      return publicUser(u);
    },
    userById: (id) => publicUser(q.byId.get(id)),
    userByRecovery: (hash) => publicUser(q.byRecovery.get(hash)),
    rotateToken: (id, hash) => q.setToken.run(hash, id),
    setRecovery: (id, hash) => q.setRecovery.run(hash, id),
    setName: (id, name) => q.setName.run(name, id),
    getSave(id) {
      const row = q.getSave.get(id);
      return row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
    },
    putSave: (id, json, updatedAt) => q.putSave.run(id, json, updatedAt),
    insertGame: (g) => q.insertGame.run(g.id, g.code, g.whiteId, g.blackId, g.winner, g.reason, g.moves, g.rated ? 1 : 0, g.tc, g.createdAt),
    // outcome: 1 victoria, 0.5 tablas, 0 derrota
    applyRating(id, newRating, outcome) {
      q.applyRating.run(MIN_RATING, newRating, outcome === 1 ? 1 : 0, outcome === 0 ? 1 : 0, outcome === 0.5 ? 1 : 0, id);
    },
    leaderboard: (limit = 20) => q.leaderboard.all(limit),
    ratingRank: (rating) => q.rankOf.get(rating).rank,
    dailySubmit: (day, userId, seconds, attempts) => q.dailyInsert.run(day, userId, seconds, attempts, Date.now()),
    dailyTop: (day, limit = 20) => q.dailyTop.all(day, limit),
    saveTournament(t) {
      db.exec('BEGIN');
      try {
        q.insertTournament.run(t.id, t.tc, t.size, t.champion, t.bracket, t.createdAt, t.finishedAt);
        for (const r of t.results) q.insertResult.run(t.id, r.userId, r.placement, r.coins ?? 0, r.xp ?? 0, r.item ?? null, t.finishedAt);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    tournamentResult: (id, userId) => q.resultOf.get(id, userId) ?? null,
    circuitResultsOf: (userId, limit = 20) => q.resultsOf.all(userId, limit),
    recentChampions: (limit = 5) => q.champions.all(limit),
    gamesOf: (userId, limit = 20) => q.gamesOf.all(userId, userId, limit),
    gameById: (id) => q.gameById.get(id) ?? null,
    gameByCode: (code, userId) => q.gameByCode.get(code, userId, userId) ?? null,
    dailyMine: (day, userId) => q.dailyMine.get(day, userId) ?? null,
    dailyRank: (day, seconds) => q.dailyRank.get(day, seconds).rank,
    dailyCount: (day) => q.dailyCount.get(day).n,
    stats() {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      return q.counts.get(startOfDay.getTime());
    },
  };
}
