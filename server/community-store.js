// Persistencia de la capa comunitaria: privacidad, moderación, partidas públicas y eventos de creadores (PROMPT 07).
// Ninguna tabla guarda correos ni datos personales: solo identificadores de cuenta, nombres públicos y decisiones de privacidad.

export const COMMUNITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_privacy (
    user_id TEXT PRIMARY KEY,
    profile TEXT NOT NULL DEFAULT 'public',
    searchable INTEGER NOT NULL DEFAULT 1,
    show_online INTEGER NOT NULL DEFAULT 1,
    accept_requests INTEGER NOT NULL DEFAULT 1,
    accept_invites TEXT NOT NULL DEFAULT 'friends',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS moderation (
    user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'ok',
    note TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS public_games (
    game_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS community_events (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_public_games_at ON public_games(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_creator ON community_events(creator_id, created_at);
`;

export const PRIVACY_DEFAULTS = { profile: 'public', searchable: true, showOnline: true, acceptRequests: true, acceptInvites: 'friends' };
export const PROFILE_VISIBILITY = ['public', 'friends', 'private'];
export const INVITE_POLICY = ['friends', 'nobody'];

export function createCommunityStore(raw) {
  const q = {
    getPrivacy: raw.prepare('SELECT profile, searchable, show_online, accept_requests, accept_invites FROM user_privacy WHERE user_id = ?'),
    putPrivacy: raw.prepare(
      `INSERT INTO user_privacy (user_id, profile, searchable, show_online, accept_requests, accept_invites, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET profile=excluded.profile, searchable=excluded.searchable, show_online=excluded.show_online,
         accept_requests=excluded.accept_requests, accept_invites=excluded.accept_invites, updated_at=excluded.updated_at`,
    ),
    getMod: raw.prepare('SELECT status, note, updated_at FROM moderation WHERE user_id = ?'),
    putMod: raw.prepare(
      'INSERT INTO moderation (user_id, status, note, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, note=excluded.note, updated_at=excluded.updated_at',
    ),
    addPublic: raw.prepare('INSERT OR IGNORE INTO public_games (game_id, kind, ref, created_at) VALUES (?,?,?,?)'),
    publicOne: raw.prepare('SELECT game_id, kind, ref, created_at FROM public_games WHERE game_id = ?'),
    publicList: raw.prepare(
      `SELECT p.game_id, p.kind, p.ref, p.created_at, g.winner, g.reason, g.tc, json_array_length(g.moves) AS plies,
              w.id AS white_id, w.name AS white_name, b.id AS black_id, b.name AS black_name
       FROM public_games p JOIN games g ON g.id = p.game_id
       LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
       ORDER BY p.created_at DESC LIMIT ?`,
    ),
    insertEvent: raw.prepare('INSERT INTO community_events (id, tournament_id, kind, creator_id, title, description, status, starts_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    eventByTournament: raw.prepare(
      'SELECT e.*, u.name AS creator_name FROM community_events e LEFT JOIN users u ON u.id = e.creator_id WHERE e.tournament_id = ?',
    ),
    eventsAll: raw.prepare('SELECT tournament_id FROM community_events'),
    activeOf: raw.prepare(
      `SELECT COUNT(*) AS n FROM community_events e JOIN circuit_tournaments t ON t.id = e.tournament_id
       WHERE e.creator_id = ? AND t.status IN ('scheduled','open','closed','running')`,
    ),
    createdSince: raw.prepare('SELECT COUNT(*) AS n FROM community_events WHERE creator_id = ? AND created_at > ?'),
    setEventStatus: raw.prepare('UPDATE community_events SET status = ? WHERE tournament_id = ?'),
  };

  const toPrivacy = (r) =>
    r && { profile: r.profile, searchable: !!r.searchable, showOnline: !!r.show_online, acceptRequests: !!r.accept_requests, acceptInvites: r.accept_invites };

  return {
    privacy: (userId) => toPrivacy(q.getPrivacy.get(userId)) ?? { ...PRIVACY_DEFAULTS },
    setPrivacy(userId, p, now = Date.now()) {
      q.putPrivacy.run(userId, p.profile, p.searchable ? 1 : 0, p.showOnline ? 1 : 0, p.acceptRequests ? 1 : 0, p.acceptInvites, now);
    },
    moderation: (userId) => q.getMod.get(userId) ?? { status: 'ok', note: null, updated_at: 0 },
    setModeration: (userId, status, note = null, now = Date.now()) => q.putMod.run(userId, status, note, now),
    addPublicGame: (gameId, kind, ref, now = Date.now()) => q.addPublic.run(gameId, kind, ref ?? null, now),
    publicGame: (gameId) => q.publicOne.get(gameId) ?? null,
    publicGames: (limit = 12) => q.publicList.all(Math.min(50, Math.max(1, limit))),
    createEvent(e) {
      q.insertEvent.run(e.id, e.tournamentId, e.kind, e.creatorId, e.title, e.description, e.status, e.startsAt, e.createdAt);
    },
    eventOf: (tournamentId) => q.eventByTournament.get(tournamentId) ?? null,
    eventTournamentIds: () => q.eventsAll.all().map((r) => r.tournament_id),
    activeEventsOf: (creatorId) => q.activeOf.get(creatorId).n,
    eventsCreatedSince: (creatorId, since) => q.createdSince.get(creatorId, since).n,
    setEventStatus: (tournamentId, status) => q.setEventStatus.run(status, tournamentId),
  };
}
