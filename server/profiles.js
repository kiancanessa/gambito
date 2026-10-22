// Perfiles públicos con controles de privacidad y partidas públicas (PROMPT 07).
//
// Regla de oro: solo sale lo que la persona decidió mostrar. Nunca hay correos, hashes, tokens, códigos de amigo ni la hora
// de última conexión. Un bloqueo en cualquier sentido hace que el perfil «no exista» (404) sin revelar quién bloqueó.
//   public  → todo el mundo ve el perfil completo
//   friends → los amigos ven todo; el resto, nombre, rating y avatar
//   private → solo se ve el nombre
import { replayPayload, SHARE_TOKEN } from './replay.js';
import { ACHIEVEMENTS } from '../public/js/progression-data.js';
import { DEFAULT_EQUIPPED } from '../public/js/data.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const IDENTITY = ['avatar', 'frame', 'badge', 'title', 'decor'];

export function createProfiles({ db, social, presence = () => ({}) }) {
  const raw = db.raw;
  const q = {
    wallet: raw.prepare('SELECT level, equipped FROM wallets WHERE user_id = ?'),
    achievements: raw.prepare('SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?'),
    trophies: raw.prepare("SELECT placement, created_at FROM tournament_results WHERE user_id = ? AND placement IN ('final','champion','semi') ORDER BY created_at DESC LIMIT 5"),
    champions: raw.prepare("SELECT COUNT(*) AS n FROM tournament_results WHERE user_id = ? AND placement = 'champion'"),
    seasonStats: raw.prepare('SELECT season_id, rating, games FROM season_stats WHERE user_id = ? ORDER BY season_id DESC LIMIT 1'),
    recent: raw.prepare(
      `SELECT p.game_id, p.kind, g.winner, g.reason, g.tc, g.created_at, g.white_id, g.black_id, json_array_length(g.moves) AS plies, w.name AS wn, b.name AS bn
       FROM public_games p JOIN games g ON g.id = p.game_id LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
       WHERE (g.white_id = ?1 OR g.black_id = ?1)
         AND COALESCE((SELECT profile FROM user_privacy WHERE user_id = g.white_id), 'public') != 'private'
         AND COALESCE((SELECT profile FROM user_privacy WHERE user_id = g.black_id), 'public') != 'private'
       ORDER BY p.created_at DESC LIMIT 5`,
    ),
  };

  const identityOf = (id) => {
    const row = q.wallet.get(id);
    let eq = {};
    try {
      eq = row ? JSON.parse(row.equipped) : {};
    } catch {
      /* equipamiento ilegible: se usa el predeterminado */
    }
    return { level: row?.level ?? 1, identity: Object.fromEntries(IDENTITY.map((k) => [k, eq[k] ?? DEFAULT_EQUIPPED[k]])) };
  };

  const relationOf = (viewerId, id) => {
    if (!viewerId) return 'none';
    if (viewerId === id) return 'self';
    const rel = social.relation(viewerId, id);
    if (!rel) return 'none';
    return rel.status === 'accepted' ? 'friends' : rel.requested_by === viewerId ? 'pending_out' : 'pending_in';
  };

  /** Perfil de `id` tal como lo ve `viewerId` (null = visitante sin sesión). */
  function profile(viewerId, id) {
    const u = typeof id === 'string' && id.length <= 40 ? db.userById(id) : null;
    if (!u) throw fail(404, 'Jugador no encontrado');
    if (viewerId && viewerId !== id && social.isBlocked(viewerId, id)) throw fail(404, 'Jugador no encontrado');
    const rel = relationOf(viewerId, id);
    const priv = social.privacyOf(id);
    const restricted = social.isRestricted(id);
    const self = rel === 'self';
    const friends = rel === 'friends';
    const base = { id: u.id, name: u.name, relation: rel, visibility: priv.profile, link: `/u/${u.id}` };
    const canRequest = !!viewerId && !self && rel === 'none' && priv.acceptRequests && !restricted;
    const canInvite = friends && priv.acceptInvites !== 'nobody';
    const viewerCan = { request: canRequest, invite: canInvite, block: !!viewerId && !self, report: !!viewerId && !self };
    if (restricted && !self) return { ...base, visibility: 'private', limited: true, viewerCan: { ...viewerCan, request: false, invite: false } };
    const full = self || priv.profile === 'public' || (priv.profile === 'friends' && friends);
    if (priv.profile === 'private' && !self) return { ...base, limited: true, viewerCan };
    const { level, identity } = identityOf(id);
    if (!full) return { ...base, limited: true, rating: u.rating, level, identity, viewerCan };
    const season = q.seasonStats.get(id);
    const out = {
      ...base,
      limited: false,
      rating: u.rating,
      level,
      identity,
      stats: { games: u.games, wins: u.wins, losses: u.losses, draws: u.draws },
      rank: u.games > 0 ? db.ratingRank(u.rating) : null,
      achievements: { done: q.achievements.get(id).n, total: ACHIEVEMENTS.length },
      champion: q.champions.get(id).n,
      trophies: q.trophies.all(id).map((t) => ({ placement: t.placement, at: t.created_at })),
      season: season ? { id: season.season_id, rating: season.rating, games: season.games } : null,
      recent: q.recent.all(id).map((g) => ({ id: g.game_id, kind: g.kind, result: !g.winner ? 'draw' : g.winner === (g.white_id === id ? 'w' : 'b') ? 'win' : 'loss', reason: g.reason, tc: g.tc, plies: g.plies, at: g.created_at, white: g.wn, black: g.bn })),
      presence: friends && priv.showOnline ? (presence([id])[id] ?? 'offline') : null,
      viewerCan,
    };
    if (viewerId && !self) out.h2h = social.headToHead(viewerId, id, 5);
    return out;
  }

  // ----- Partidas públicas (clasificatorias y de torneo): lista y repetición para cualquiera -----
  const visibleGame = (g) => {
    for (const pid of [g.white_id, g.black_id]) {
      if (!pid || social.privacyOf(pid).profile === 'private' || social.isRestricted(pid)) return false;
    }
    return true;
  };

  function publicGames(limit = 12) {
    return db.community
      .publicGames(limit * 2)
      .filter((r) => [r.white_id, r.black_id].every((pid) => pid && social.privacyOf(pid).profile !== 'private' && !social.isRestricted(pid)))
      .slice(0, limit)
      .map((r) => ({ id: r.game_id, kind: r.kind, tournament: r.kind === 'circuit' ? r.ref : null, white: { id: r.white_id, name: r.white_name }, black: { id: r.black_id, name: r.black_name }, winner: r.winner, reason: r.reason, tc: r.tc, plies: r.plies, at: r.created_at }));
  }

  // Repetición abierta a cualquiera: una partida pública (si ninguno de los dos la tiene privada) o un enlace que creó uno de los jugadores.
  function publicGame(gameId) {
    if (typeof gameId === 'string' && SHARE_TOKEN.test(gameId)) {
      const share = db.community.shareByToken(gameId);
      const g = share && db.gameById(share.game_id);
      if (!g) throw fail(404, 'Partida no encontrada');
      return replayPayload(db, g, { id: gameId, extra: { shared: true } });
    }
    const pub = typeof gameId === 'string' && /^[\w-]{8,64}$/.test(gameId) ? db.community.publicGame(gameId) : null;
    const g = pub && db.gameById(gameId);
    if (!g || !visibleGame(g)) throw fail(404, 'Partida no encontrada');
    return replayPayload(db, g);
  }

  return { profile, publicGames, publicGame };
}
