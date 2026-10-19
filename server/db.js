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
