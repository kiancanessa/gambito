// Social (Fase 5): amigos por código, bloqueos y reportes. Sin chat libre ni datos personales.
//
// - Cada jugador tiene un código de amigo (8 caracteres) que comparte fuera del juego; con él se envían solicitudes.
// - También se puede pedir amistad, bloquear o reportar a alguien con quien se ha jugado (`hasPlayed`).
// - Bloquear borra la amistad, impide solicitudes e invitaciones en ambos sentidos y evita emparejamientos.
// - Los reportes se guardan para revisarlos (`npm run reports`); no hay sanciones automáticas, para que no se puedan
//   usar en un linchamiento coordinado.
import crypto from 'node:crypto';
import { normalizeCode } from './auth.js';
import { INVITE_POLICY, PROFILE_VISIBILITY } from './community-store.js';

export const SOCIAL_LIMITS = { friends: 100, pendingOut: 20, blocks: 200, reportsPerDay: 5, searchResults: 10, reviewReporters: 3 };
export const REPORT_REASONS = ['abuso', 'trampas', 'nombre', 'otro'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY_MS = 24 * 3600 * 1000;

const fail = (status, message) => Object.assign(new Error(message), { status });
const pair = (a, b) => (a < b ? [a, b] : [b, a]);
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
export const prettyCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

export function createSocial(db) {
  const raw = db.raw;
  const q = {
    codeOf: raw.prepare('SELECT code FROM friend_codes WHERE user_id = ?'),
    byCode: raw.prepare('SELECT user_id FROM friend_codes WHERE code = ?'),
    putCode: raw.prepare('INSERT INTO friend_codes (user_id, code) VALUES (?, ?)'),
    rel: raw.prepare('SELECT status, requested_by FROM friendships WHERE low = ? AND high = ?'),
    addRel: raw.prepare('INSERT INTO friendships (low, high, status, requested_by, created_at) VALUES (?,?,?,?,?)'),
    accept: raw.prepare("UPDATE friendships SET status = 'accepted' WHERE low = ? AND high = ?"),
    delRel: raw.prepare('DELETE FROM friendships WHERE low = ? AND high = ?'),
    countFriends: raw.prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (low = ?1 OR high = ?1)"),
    countOut: raw.prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'pending' AND requested_by = ?"),
    rels: raw.prepare(
      `SELECT f.status, f.requested_by, f.created_at, u.id, u.name, u.rating
       FROM friendships f JOIN users u ON u.id = CASE WHEN f.low = ?1 THEN f.high ELSE f.low END
       WHERE f.low = ?1 OR f.high = ?1 ORDER BY u.name COLLATE NOCASE`,
    ),
    isBlocked: raw.prepare('SELECT 1 FROM blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1)'),
    block: raw.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?,?,?)'),
    unblock: raw.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?'),
    countBlocks: raw.prepare('SELECT COUNT(*) AS n FROM blocks WHERE user_id = ?'),
    blocked: raw.prepare('SELECT u.id, u.name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC'),
    user: raw.prepare('SELECT id, name, rating FROM users WHERE id = ?'),
    reportsToday: raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?'),
    dupReport: raw.prepare('SELECT 1 FROM reports WHERE reporter_id = ? AND target_id = ? AND created_at > ?'),
    addReport: raw.prepare('INSERT INTO reports (reporter_id, target_id, reason, ctx, created_at) VALUES (?,?,?,?,?)'),
    search: raw.prepare(
      `SELECT u.id, u.name, u.rating, u.games FROM users u
       LEFT JOIN user_privacy p ON p.user_id = u.id LEFT JOIN moderation m ON m.user_id = u.id
       WHERE u.id != ?1 AND lower(u.name) LIKE ?2 ESCAPE '\\' AND COALESCE(p.searchable, 1) = 1 AND COALESCE(m.status, 'ok') != 'restricted'
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_id = u.id) OR (b.user_id = u.id AND b.blocked_id = ?1))
       ORDER BY (lower(u.name) = ?3) DESC, (lower(u.name) LIKE ?4 ESCAPE '\\') DESC, u.games DESC, u.name COLLATE NOCASE LIMIT ?5`,
    ),
    h2hTotals: raw.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN winner = CASE WHEN white_id = ?1 THEN 'w' ELSE 'b' END THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(CASE WHEN winner IS NOT NULL AND winner != CASE WHEN white_id = ?1 THEN 'w' ELSE 'b' END THEN 1 ELSE 0 END), 0) AS losses,
              COALESCE(SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END), 0) AS draws
       FROM games WHERE ((white_id = ?1 AND black_id = ?2) OR (white_id = ?2 AND black_id = ?1)) AND reason != 'abortada'`,
    ),
    h2hGames: raw.prepare(
      `SELECT id, winner, reason, rated, tc, created_at, white_id, json_array_length(moves) AS plies FROM games
       WHERE ((white_id = ?1 AND black_id = ?2) OR (white_id = ?2 AND black_id = ?1)) AND reason != 'abortada' ORDER BY created_at DESC LIMIT ?3`,
    ),
    rivals: raw.prepare(
      `SELECT opp AS id, u.name, u.rating, COUNT(*) AS n, SUM(w) AS wins, SUM(l) AS losses, SUM(d) AS draws, MAX(at) AS last
       FROM (SELECT CASE WHEN white_id = ?1 THEN black_id ELSE white_id END AS opp,
                    CASE WHEN winner = CASE WHEN white_id = ?1 THEN 'w' ELSE 'b' END THEN 1 ELSE 0 END AS w,
                    CASE WHEN winner IS NOT NULL AND winner != CASE WHEN white_id = ?1 THEN 'w' ELSE 'b' END THEN 1 ELSE 0 END AS l,
                    CASE WHEN winner IS NULL THEN 1 ELSE 0 END AS d, created_at AS at
             FROM games WHERE (white_id = ?1 OR black_id = ?1) AND reason != 'abortada')
       JOIN users u ON u.id = opp GROUP BY opp HAVING n >= 2 ORDER BY n DESC, last DESC LIMIT ?2`,
    ),
    reportersWeek: raw.prepare('SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND created_at > ?'),
    played: raw.prepare('SELECT 1 FROM games WHERE (white_id = ?1 AND black_id = ?2) OR (white_id = ?2 AND black_id = ?1) LIMIT 1'),
  };

  const userOrFail = (id) => {
    const u = q.user.get(id);
    if (!u) throw fail(404, 'No encontrado');
    return u;
  };

  function codeFor(userId) {
    const row = q.codeOf.get(userId);
    if (row) return row.code;
    for (let i = 0; i < 8; i += 1) {
      const code = newCode();
      try {
        q.putCode.run(userId, code);
        return code;
      } catch {
        // colisión de código o carrera con otra petición: se reintenta
        const again = q.codeOf.get(userId);
        if (again) return again.code;
      }
    }
    throw fail(500, 'No se pudo crear tu código de amigo');
  }

  const userByCode = (code) => {
    const row = q.byCode.get(normalizeCode(code));
    return row ? q.user.get(row.user_id) : null;
  };

  const privacyOf = (id) => db.community.privacy(id);
  const isRestricted = (id) => db.community.moderation(id).status === 'restricted';
  const isBlocked = (a, b) => !!q.isBlocked.get(a, b);
  const relation = (a, b) => {
    const [low, high] = pair(a, b);
    return q.rel.get(low, high) ?? null;
  };
  const areFriends = (a, b) => relation(a, b)?.status === 'accepted';

  // Solicitud de amistad. Si el otro ya te había pedido amistad, se acepta. Devuelve { status, user }.
  function request(fromId, targetId) {
    if (fromId === targetId) throw fail(400, 'No puedes añadirte a ti mismo');
    const target = userOrFail(targetId);
    if (isBlocked(fromId, targetId) || isRestricted(targetId)) throw fail(404, 'No encontrado'); // no se revela quién bloqueó a quién
    const [low, high] = pair(fromId, targetId);
    const rel = q.rel.get(low, high);
    if (rel?.status === 'accepted') return { status: 'friends', user: target };
    if (rel?.status === 'pending') {
      if (rel.requested_by === fromId) return { status: 'pending', user: target };
      q.accept.run(low, high);
      return { status: 'friends', user: target };
    }
    if (!privacyOf(targetId).acceptRequests) throw fail(403, 'Esta persona no acepta solicitudes de amistad');
    if (q.countFriends.get(fromId).n >= SOCIAL_LIMITS.friends) throw fail(400, 'Has llegado al límite de amigos');
    if (q.countFriends.get(targetId).n >= SOCIAL_LIMITS.friends) throw fail(400, 'Esa persona ha llegado al límite de amigos');
    if (q.countOut.get(fromId).n >= SOCIAL_LIMITS.pendingOut) throw fail(400, 'Tienes demasiadas solicitudes pendientes');
    q.addRel.run(low, high, 'pending', fromId, Date.now());
    return { status: 'pending', user: target };
  }

  function respond(userId, otherId, accept) {
    const [low, high] = pair(userId, otherId);
    const rel = q.rel.get(low, high);
    if (!rel || rel.status !== 'pending' || rel.requested_by === userId) throw fail(404, 'No hay solicitud');
    if (accept) q.accept.run(low, high);
    else q.delRel.run(low, high);
    return { status: accept ? 'friends' : 'none' };
  }

  // Quitar un amigo, rechazar o cancelar una solicitud.
  function remove(userId, otherId) {
    const [low, high] = pair(userId, otherId);
    q.delRel.run(low, high);
  }

  function block(userId, targetId) {
    if (userId === targetId) throw fail(400, 'No puedes bloquearte a ti mismo');
    userOrFail(targetId);
    if (!isBlocked(userId, targetId) && q.countBlocks.get(userId).n >= SOCIAL_LIMITS.blocks) throw fail(400, 'Has llegado al límite de bloqueos');
    q.block.run(userId, targetId, Date.now());
    remove(userId, targetId);
  }

  const unblock = (userId, targetId) => q.unblock.run(userId, targetId);

  // Relaciones del jugador, separadas por tipo. `presence` (opcional) añade el estado en línea de los amigos.
  function list(userId, presence = () => ({})) {
    const rows = q.rels.all(userId);
    const friends = rows.filter((r) => r.status === 'accepted');
    const pres = presence(friends.map((f) => f.id));
    return {
      code: prettyCode(codeFor(userId)),
      // El estado en línea solo se muestra si el amigo lo permite (y solo cuando hay conexión real: si no, «offline»).
      friends: friends.map((f) => ({ id: f.id, name: f.name, rating: f.rating, presence: privacyOf(f.id).showOnline ? (pres[f.id] ?? 'offline') : 'offline', since: f.created_at })),
      incoming: rows.filter((r) => r.status === 'pending' && r.requested_by !== userId).map((r) => ({ id: r.id, name: r.name, rating: r.rating, at: r.created_at })),
      outgoing: rows.filter((r) => r.status === 'pending' && r.requested_by === userId).map((r) => ({ id: r.id, name: r.name, at: r.created_at })),
      blocked: q.blocked.all(userId),
    };
  }

  // ¿Han jugado estos dos jugadores? Es lo que permite pedir amistad, reportar o bloquear desde una partida ya terminada.
  const hasPlayed = (a, b) => !!q.played.get(a, b);

  function report(reporterId, targetId, reason, ctx = null) {
    if (reporterId === targetId) throw fail(400, 'No puedes reportarte a ti mismo');
    if (!REPORT_REASONS.includes(reason)) throw fail(400, 'Motivo no válido');
    userOrFail(targetId);
    const since = Date.now() - DAY_MS;
    if (q.dupReport.get(reporterId, targetId, since)) return { ok: true, duplicate: true };
    if (q.reportsToday.get(reporterId, since).n >= SOCIAL_LIMITS.reportsPerDay) throw fail(429, 'Has enviado demasiados reportes hoy');
    q.addReport.run(reporterId, targetId, reason, typeof ctx === 'string' ? ctx.slice(0, 64) : null, Date.now());
    flagForReview(targetId);
    return { ok: true };
  }

  // Moderación sin sanciones automáticas: con 3 personas distintas en 7 días la cuenta pasa a «revisión» (solo informa a quien modera).
  // «restricted» solo lo pone una persona con acceso al servidor (scripts/moderate.js): oculta la cuenta de la búsqueda y de los eventos.
  function flagForReview(targetId) {
    const n = q.reportersWeek.get(targetId, Date.now() - 7 * DAY_MS).n;
    if (n >= SOCIAL_LIMITS.reviewReporters && db.community.moderation(targetId).status === 'ok') db.community.setModeration(targetId, 'review', `automático: ${n} personas distintas en 7 días`);
  }

  // Búsqueda por nombre: mínimo 2 letras, pocos resultados, sin cuentas ocultas, restringidas ni bloqueadas (en ningún sentido).
  function search(viewerId, term, limit = SOCIAL_LIMITS.searchResults) {
    const t = String(term ?? '').trim().toLowerCase().slice(0, 16);
    if (t.length < 2) throw fail(400, 'Escribe al menos 2 letras');
    const esc = t.replace(/[\%_]/g, (c) => `\${c}`);
    const rows = q.search.all(viewerId, `%${esc}%`, t, `${esc}%`, Math.min(SOCIAL_LIMITS.searchResults, Math.max(1, limit)));
    return rows.map((r) => {
      const rel = relation(viewerId, r.id);
      const status = !rel ? 'none' : rel.status === 'accepted' ? 'friends' : rel.requested_by === viewerId ? 'pending_out' : 'pending_in';
      return { id: r.id, name: r.name, rating: r.rating, relation: status };
    });
  }

  function setPrivacy(userId, patch) {
    const cur = privacyOf(userId);
    const next = { ...cur };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail(400, 'Ajustes no válidos');
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'profile' && PROFILE_VISIBILITY.includes(v)) next.profile = v;
      else if (k === 'acceptInvites' && INVITE_POLICY.includes(v)) next.acceptInvites = v;
      else if (['searchable', 'showOnline', 'acceptRequests'].includes(k) && typeof v === 'boolean') next[k] = v;
      else throw fail(400, `Ajuste no válido: ${String(k).slice(0, 20)}`);
    }
    db.community.setPrivacy(userId, next);
    return next;
  }

  // Historial de enfrentamientos entre dos jugadores (solo partidas de las que ambos fueron parte).
  function headToHead(viewerId, otherId, limit = 10) {
    const t = q.h2hTotals.get(viewerId, otherId);
    const games = q.h2hGames.all(viewerId, otherId, Math.min(25, limit)).map((g) => ({
      id: g.id,
      result: !g.winner ? 'draw' : g.winner === (g.white_id === viewerId ? 'w' : 'b') ? 'win' : 'loss',
      reason: g.reason,
      rated: !!g.rated,
      tc: g.tc,
      plies: g.plies,
      at: g.created_at,
    }));
    return { games: t.n, wins: t.wins, losses: t.losses, draws: t.draws, recent: games };
  }

  // Rivalidades: con quién más has jugado (al menos 2 partidas), sin cuentas bloqueadas.
  const rivals = (userId, limit = 8) =>
    q.rivals
      .all(userId, Math.min(20, limit))
      .filter((r) => !isBlocked(userId, r.id) && !isRestricted(r.id))
      .map((r) => ({ id: r.id, name: r.name, rating: r.rating, games: r.n, wins: r.wins, losses: r.losses, draws: r.draws, last: r.last }));

  return { codeFor, userByCode, isBlocked, areFriends, relation, request, respond, remove, block, unblock, list, hasPlayed, report, search, privacyOf, setPrivacy, isRestricted, headToHead, rivals };
}
