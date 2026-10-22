// API HTTP/JSON: cuentas de invitado, guardado en la nube, desafío diario, clasificación y estadísticas.
import { newShareToken, replayPayload } from './replay.js';
import { bearer, cleanName, defaultName, newId, newRecoveryCode, newToken, normalizeCode, sha256 } from './auth.js';
import { timingSafeEqual } from 'node:crypto';
import { LIMITS, SAVE_LIMIT_BYTES, allowedOrigins } from './config.js';
import { dayId, nextResetAt, puzzleFor, verifySolution } from './daily.js';
import { createWallets } from './wallet.js';
import { progressMessage } from './progression.js';
import { cosmeticMessage } from './cosmetics.js';
import { seasonAt, SEASONS } from '../public/js/progression-data.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));

export function createApi({ db, rooms, matchmaker, circuit, social, wallets = createWallets(db), progression, cosmetics, profiles, community, metrics = null, presence = () => ({}), notify = () => 0, onlineCount, puzzles, persistStatus = () => null }) {
  const buckets = new Map();

  // Limitador sencillo en memoria: `max` peticiones por `windowMs` y clave.
  function limited(key, max, windowMs) {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.reset) {
      buckets.set(key, { n: 1, reset: now + windowMs });
      return false;
    }
    b.n += 1;
    return b.n > max;
  }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  }, 60_000);
  sweep.unref?.();

  const send = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };

  function readJson(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let tooBig = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (tooBig) return; // se sigue leyendo (y descartando) para poder responder 413 limpiamente
        if (size > limit) {
          tooBig = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }));
        try {
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          // Todas las rutas esperan un objeto: `null`, un array o un número no son un cuerpo válido (antes acababan en un 500).
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('forma');
          resolve(body);
        } catch {
          reject(Object.assign(new Error('JSON no válido'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  const authUser = (req) => {
    const token = bearer(req);
    return token ? db.userByToken(sha256(token)) : null;
  };

  function dailyPayload(day, user) {
    const p = puzzleFor(day, puzzles);
    const top = db.dailyTop(day, 20).map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, seconds: r.seconds, attempts: r.attempts }));
    let mine = null;
    if (user) {
      const row = db.dailyMine(day, user.id);
      if (row) mine = { seconds: row.seconds, attempts: row.attempts, rank: db.dailyRank(day, row.seconds) };
    }
    return { day, number: day + 1, fen: p.fen, mateIn: p.mateIn, nextResetAt: nextResetAt(), solvedCount: db.dailyCount(day), mine, top };
  }

  return async function handle(req, res, url, ip) {
    const { pathname } = url;
    const method = req.method;
    // CORS: solo para los orígenes de ALLOWED_ORIGINS (p. ej. el cliente en Vercel). La sesión va en
    // `Authorization: Bearer`, sin cookies, así que no hace falta `Allow-Credentials`.
    const origin = req.headers.origin;
    const corsOk = !!origin && allowedOrigins().includes(origin.replace(/\/$/, ''));
    if (corsOk) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (method === 'OPTIONS') {
      res.writeHead(corsOk ? 204 : 403).end();
      return true;
    }
    try {
      if (pathname === '/healthz') return send(res, 200, { ok: true });
      if (limited(`all:${ip}`, 240, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });

      if (pathname === '/api/guest' && method === 'POST') {
        if (limited(`guest:${ip}`, LIMITS.guestsPerHour, 3600_000)) return send(res, 429, { error: 'Demasiadas cuentas nuevas desde esta red' });
        const body = await readJson(req);
        metrics?.inc('guests_created_total');
        const token = newToken();
        const recovery = newRecoveryCode();
        const user = db.createUser({
          id: newId(),
          name: cleanName(body.name, null) ?? defaultName(),
          tokenHash: sha256(token),
          recoveryHash: sha256(normalizeCode(recovery)),
        });
        return send(res, 201, { user, token, recovery });
      }

      if (pathname === '/api/recover' && method === 'POST') {
        if (limited(`recover:${ip}`, 10, 600_000)) return send(res, 429, { error: 'Demasiados intentos, espera unos minutos' });
        const body = await readJson(req);
        const code = normalizeCode(body.code);
        const user = code.length === 12 ? db.userByRecovery(sha256(code)) : null;
        if (!user) return send(res, 404, { error: 'Código no válido' });
        const token = newToken();
        db.rotateToken(user.id, sha256(token));
        return send(res, 200, { user, token });
      }

      // Métricas internas: solo si el operador define METRICS_TOKEN; si no, el endpoint ni existe.
      if (pathname === '/api/metrics' && method === 'GET') {
        const token = process.env.METRICS_TOKEN;
        if (!token || !metrics) return send(res, 404, { error: 'No encontrado' });
        const given = bearer(req) ?? '';
        const ok = given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
        if (!ok) return send(res, 401, { error: 'No autorizado' });
        if (url.searchParams.get('format') === 'prom') {
          const text = metrics.prometheus();
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(text);
        }
        return send(res, 200, metrics.snapshot());
      }

      // Moderación: solo con ADMIN_TOKEN (si no, estas rutas ni existen). Ver scripts/moderate.js.
      // No hay sanciones automáticas: aquí se revisan los reportes y se marca una cuenta como «restricted» a mano.
      if (pathname.startsWith('/api/admin/')) {
        const token = process.env.ADMIN_TOKEN;
        if (!token) return send(res, 404, { error: 'No encontrado' });
        if (limited(`admin:${ip}`, 30, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });
        const given = bearer(req) ?? '';
        if (!(given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token)))) return send(res, 401, { error: 'No autorizado' });
        if (pathname === '/api/admin/reports' && method === 'GET') {
          const rows = db.raw
            .prepare(
              `SELECT r.target_id AS id, COALESCE(u.name, '(cuenta borrada)') AS name, COUNT(DISTINCT r.reporter_id) AS people, COUNT(*) AS total,
                      GROUP_CONCAT(DISTINCT r.reason) AS reasons, MAX(r.created_at) AS last, COALESCE(m.status, 'ok') AS status
               FROM reports r LEFT JOIN users u ON u.id = r.target_id LEFT JOIN moderation m ON m.user_id = r.target_id
               GROUP BY r.target_id ORDER BY people DESC, last DESC LIMIT 50`,
            )
            .all();
          return send(res, 200, { reports: rows });
        }
        if (pathname === '/api/admin/moderate' && method === 'POST') {
          const body = await readJson(req, 1024);
          if (!['ok', 'review', 'restricted'].includes(body.status) || typeof body.userId !== 'string' || !db.userById(body.userId)) return send(res, 400, { error: 'Petición no válida' });
          db.community.setModeration(body.userId, body.status, typeof body.note === 'string' ? body.note.slice(0, 200) : null);
          return send(res, 200, { ok: true, status: body.status });
        }
        return send(res, 404, { error: 'No encontrado' });
      }

      if (pathname === '/api/stats' && method === 'GET') {
        const s = db.stats();
        const p = persistStatus();
        return send(res, 200, {
          online: onlineCount(),
          queue: matchmaker.size(),
          rooms: rooms.rooms.size,
          users: s.users,
          gamesToday: s.gamesToday,
          uptimeSeconds: Math.round(process.uptime()),
          // Copia de la base de datos (solo con DATABASE_URL): cuándo fue la última y si hay error.
          // Solo el estado: el texto del error puede nombrar el servidor de la base de datos, y eso no es público (está en los registros).
          persist: p && { claimed: p.claimed, degraded: p.degraded, restoredBytes: p.restoredBytes, lastOkAt: p.lastOkAt, failing: !!p.lastError, lostOwnership: p.lostOwnership },
        });
      }

      // Lista de torneos (con tu inscripción si hay sesión) y detalle de uno: público, solo lectura. El cuadro lo mueve únicamente el servidor.
      if (pathname === '/api/circuit' && method === 'GET') return send(res, 200, circuit.listView(authUser(req)?.id ?? null));
      const circuitOne = pathname.match(/^\/api\/circuit\/t\/([\w-]{1,64})$/);
      if (circuitOne && method === 'GET') {
        const detail = circuit.detail(circuitOne[1], authUser(req)?.id ?? null);
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'Torneo no encontrado' });
      }

      // Clasificación de una temporada (pública, solo lectura). Sin `season`, la actual (o la última que terminó).
      if (pathname === '/api/season/leaderboard' && method === 'GET') {
        const wanted = Number(url.searchParams.get('season'));
        const season = SEASONS.find((x) => x.id === wanted) ?? seasonAt(Date.now()) ?? SEASONS.filter((x) => Date.parse(`${x.endsAt}T23:59:59Z`) < Date.now()).at(-1) ?? SEASONS[0];
        return send(res, 200, progression.leaderboard(season.id, authUser(req)?.id ?? null));
      }

      // ----- Capa comunitaria pública (solo lectura): perfiles, partidas públicas y partidas en directo -----
      // El perfil respeta la privacidad de cada persona; un visitante sin sesión se trata como un desconocido.
      const profileMatch = pathname.match(/^\/api\/users\/([\w-]{1,40})$/);
      if (profileMatch && profileMatch[1] !== 'search' && method === 'GET') {
        if (limited(`pub:${ip}`, 120, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });
        return send(res, 200, { profile: profiles.profile(authUser(req)?.id ?? null, profileMatch[1]) });
      }
      if (pathname === '/api/public/games' && method === 'GET') {
        if (limited(`pub:${ip}`, 120, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });
        return send(res, 200, { games: profiles.publicGames(clamp(url.searchParams.get('limit') ?? 12, 1, 30)) });
      }
      const publicGameMatch = pathname.match(/^\/api\/public\/games\/([\w-]{8,64})$/);
      if (publicGameMatch && method === 'GET') {
        if (limited(`pub:${ip}`, 120, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });
        return send(res, 200, { game: profiles.publicGame(publicGameMatch[1]) });
      }

      if (pathname === '/api/live' && method === 'GET') {
        // Partidas clasificatorias y de torneo en curso; se omiten las de quien tiene el perfil privado.
        const open = (room) => ['w', 'b'].every((c) => room.players[c] && social.privacyOf(room.players[c].id).profile !== 'private');
        return send(res, 200, { games: rooms.liveGames(8, open) });
      }

      if (pathname === '/api/leaderboard' && method === 'GET') {
        const user = authUser(req);
        const top = db.leaderboard(clamp(url.searchParams.get('limit') ?? 20, 1, 100)).map((r, i) => ({ rank: i + 1, ...r }));
        return send(res, 200, { top, me: user ? { rank: db.ratingRank(user.rating), rating: user.rating } : null });
      }

      if (pathname === '/api/daily' && method === 'GET') return send(res, 200, dailyPayload(dayId(), authUser(req)));

      // ----- Rutas con sesión -----
      const user = authUser(req);
      if (!pathname.startsWith('/api/')) return false;
      if (!user) return send(res, 401, { error: 'Sesión no válida' });
      if (limited(`user:${user.id}`, 120, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });

      if (pathname === '/api/me' && method === 'GET') return send(res, 200, { user, rank: db.ratingRank(user.rating) });

      if (pathname === '/api/me' && method === 'PATCH') {
        const body = await readJson(req);
        const name = cleanName(body.name, null);
        if (!name) return send(res, 400, { error: 'Nombre no válido (3-16 letras o números)' });
        db.setName(user.id, name);
        return send(res, 200, { user: db.userById(user.id) });
      }

      if (pathname === '/api/me/recovery' && method === 'POST') {
        const recovery = newRecoveryCode();
        db.setRecovery(user.id, sha256(normalizeCode(recovery)));
        return send(res, 200, { recovery });
      }

      if (pathname === '/api/save' && method === 'GET') {
        const row = db.getSave(user.id);
        return send(res, 200, row ?? { data: null, updatedAt: 0 });
      }

      if (pathname === '/api/save' && method === 'PUT') {
        const body = await readJson(req, SAVE_LIMIT_BYTES + 1024);
        if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return send(res, 400, { error: 'Guardado no válido' });
        const json = JSON.stringify(body.data);
        if (Buffer.byteLength(json) > SAVE_LIMIT_BYTES) return send(res, 413, { error: 'Guardado demasiado grande' });
        const updatedAt = Date.now();
        db.putSave(user.id, json, updatedAt);
        return send(res, 200, { updatedAt });
      }

      // ----- Progresión: la ve y la concede el servidor; el cliente solo pide ver, reclamar o registrar una revisión -----
      // ----- Social: búsqueda, privacidad, enfrentamientos y rivalidades -----
      if (pathname === '/api/users/search' && method === 'GET') {
        if (limited(`search:${user.id}`, 30, 60_000)) return send(res, 429, { error: 'Demasiadas búsquedas seguidas' });
        return send(res, 200, { users: social.search(user.id, url.searchParams.get('q')) });
      }
      const h2hMatch = pathname.match(/^\/api\/users\/([\w-]{1,40})\/h2h$/);
      if (h2hMatch && method === 'GET') {
        const other = h2hMatch[1];
        if (!db.userById(other) || social.isBlocked(user.id, other)) return send(res, 404, { error: 'Jugador no encontrado' });
        return send(res, 200, { h2h: social.headToHead(user.id, other, clamp(url.searchParams.get('limit') ?? 10, 1, 25)) });
      }
      if (pathname === '/api/me/privacy' && method === 'GET') return send(res, 200, { privacy: social.privacyOf(user.id) });
      if (pathname === '/api/me/privacy' && method === 'PATCH') {
        if (limited(`privacy:${user.id}`, 20, 60_000)) return send(res, 429, { error: 'Demasiados cambios seguidos' });
        return send(res, 200, { privacy: social.setPrivacy(user.id, await readJson(req, 1024)) });
      }
      if (pathname === '/api/me/rivals' && method === 'GET') return send(res, 200, { rivals: social.rivals(user.id) });

      // ----- Eventos de comunidad: torneos de creadores -----
      if (pathname === '/api/events' && method === 'POST') {
        if (limited(`event:${user.id}`, 10, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });
        const t = community.create(user.id, await readJson(req, 4096));
        return send(res, 200, { id: t.id, tournament: circuit.detail(t.id, user.id) });
      }
      const eventCancel = pathname.match(/^\/api\/events\/([\w-]{1,64})\/cancel$/);
      if (eventCancel && method === 'POST') {
        community.cancel(user.id, eventCancel[1]);
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/events/rules' && method === 'GET') return send(res, 200, { rules: community.rules });

      // ----- Cosméticos: inventario y equipamiento. El cliente nunca se otorga un artículo; el servidor valida la propiedad -----
      if (pathname === '/api/cosmetics' && method === 'GET') return send(res, 200, cosmetics.view(user.id));

      if (pathname === '/api/cosmetics/equip' && method === 'POST') {
        if (limited(`equip:${user.id}`, 60, 60_000)) return send(res, 429, { error: 'Demasiados cambios seguidos' });
        const body = await readJson(req, 1024);
        const out = cosmetics.equip(user.id, { category: body.category, id: body.id });
        metrics?.inc('cosmetic_equips_total', { result: out.ok ? 'ok' : out.reason });
        if (!out.ok) return send(res, out.reason === 'owned' ? 403 : 400, { ok: false, reason: out.reason, error: cosmeticMessage(out.reason) });
        return send(res, 200, { ok: true, equipped: out.equipped });
      }

      if (pathname === '/api/progress' && method === 'GET') return send(res, 200, progression.summary(user.id));

      if (pathname === '/api/progress/claim' && method === 'POST') {
        if (limited(`claim:${user.id}`, 40, 60_000)) return send(res, 429, { error: 'Demasiadas reclamaciones seguidas' });
        const body = await readJson(req, 2048);
        const out = body.kind === 'mission' ? progression.claimMission(user.id, { kind: body.slot, id: body.id, period: body.period }) : body.kind === 'season' ? progression.claimSeason(user.id, body) : { ok: false, reason: 'invalid' };
        metrics?.inc('progress_claims_total', { kind: String(body.kind).slice(0, 12), result: out.ok ? 'ok' : out.reason });
        if (!out.ok) return send(res, out.reason === 'invalid' || out.reason === 'unknown' ? 400 : 409, { ok: false, reason: out.reason, error: progressMessage(out.reason) });
        return send(res, 200, { ok: true, reward: { coins: out.coins, xp: out.xp, item: out.item }, summary: progression.summary(user.id) });
      }

      if (pathname === '/api/progress/review' && method === 'POST') {
        if (limited(`review:${user.id}`, 30, 60_000)) return send(res, 429, { error: 'Demasiadas revisiones seguidas' });
        const body = await readJson(req, 1024);
        const out = progression.recordReview(user.id, body.gameId, body.ply);
        return send(res, out.ok || out.reason === 'dup' ? 200 : 400, out.ok ? { ok: true, xp: out.xp } : { ok: false, reason: out.reason, error: progressMessage(out.reason) });
      }

      if (pathname === '/api/circuit/me' && method === 'GET') return send(res, 200, { results: db.circuitResultsOf(user.id, 20) });

      // ----- Repeticiones: solo las ven quienes jugaron la partida -----
      if (pathname === '/api/me/games' && method === 'GET') {
        const limit = clamp(url.searchParams.get('limit') ?? 20, 1, 50);
        const games = db.gamesOf(user.id, limit).map((g) => {
          const mine = g.white_id === user.id ? 'w' : 'b';
          return {
            id: g.id,
            code: g.code,
            you: mine,
            result: !g.winner ? 'draw' : g.winner === mine ? 'win' : 'loss',
            reason: g.reason,
            rated: !!g.rated,
            tc: g.tc,
            plies: g.plies,
            createdAt: g.created_at,
            opponent: (mine === 'w' ? g.black_name : g.white_name) ?? 'Jugador',
          };
        });
        return send(res, 200, { games });
      }

      const replay = pathname.match(/^\/api\/games\/([\w-]{8,64})(\/share)?$/);
      if (replay) {
        const g = db.gameById(replay[1]);
        if (!g || (g.white_id !== user.id && g.black_id !== user.id)) return send(res, 404, { error: 'Partida no encontrada' });
        // Enlace de repetición: solo quien jugó la partida lo crea o lo revoca; es un token aleatorio y revocable.
        if (replay[2]) {
          if (method !== 'POST' && method !== 'DELETE') return send(res, 405, { error: 'Método no permitido' });
          if (limited(`share:${user.id}`, 20, 60_000)) return send(res, 429, { error: 'Demasiadas acciones seguidas' });
          if (method === 'DELETE') return send(res, 200, { ok: true, removed: db.community.removeShare(g.id) });
          const share = db.community.shareOf(g.id) ?? db.community.addShare(g.id, user.id, newShareToken());
          return send(res, 201, { token: share.token, link: `/r/${share.token}` });
        }
        if (method !== 'GET') return send(res, 405, { error: 'Método no permitido' });
        const share = db.community.shareOf(g.id);
        let isPublic = false;
        try {
          isPublic = !!profiles.publicGame(g.id);
        } catch {
          isPublic = false;
        }
        return send(res, 200, { game: replayPayload(db, g, { you: g.white_id === user.id ? 'w' : 'b', extra: { share: share ? { token: share.token, link: `/r/${share.token}` } : null, public: isPublic } }) });
      }

      // ----- Social: amigos, bloqueos y reportes -----
      if (pathname.startsWith('/api/social') || pathname === '/api/report') {
        if (pathname === '/api/social' && method === 'GET') return send(res, 200, social.list(user.id, presence));
        if (method !== 'POST') return send(res, 404, { error: 'No encontrado' });
        if (limited(`social:${user.id}`, 30, 60_000)) return send(res, 429, { error: 'Demasiadas acciones sociales seguidas' });
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.slice(0, 40) : '';
        // Con quien se puede interactuar por id: quien ha compartido partida contigo (nunca bots).
        const canInteract = (other) => !other.startsWith('bot-') && (rooms.shareRoom(user.id, other) || social.hasPlayed(user.id, other));

        if (pathname === '/api/social/request') {
          let targetId;
          if (typeof body.code === 'string') {
            const target = social.userByCode(body.code);
            if (!target) return send(res, 404, { error: 'Código no válido' });
            targetId = target.id;
          } else if (id) targetId = id; // desde la búsqueda o un perfil; la privacidad y los límites los aplica social.request
          else return send(res, 404, { error: 'No encontrado' });
          const r = social.request(user.id, targetId);
          if (r.status === 'pending') notify(targetId, { t: 'friend_request', from: { id: user.id, name: user.name } });
          else notify(targetId, { t: 'friends_changed' });
          return send(res, 200, { status: r.status, user: r.user });
        }
        if (pathname === '/api/social/respond') {
          const r = social.respond(user.id, id, body.accept === true);
          notify(id, { t: 'friends_changed' });
          return send(res, 200, r);
        }
        if (pathname === '/api/social/remove') {
          social.remove(user.id, id);
          notify(id, { t: 'friends_changed' });
          return send(res, 200, { ok: true });
        }
        if (pathname === '/api/social/block') {
          social.block(user.id, id);
          notify(id, { t: 'friends_changed' });
          return send(res, 200, { ok: true });
        }
        if (pathname === '/api/social/unblock') {
          social.unblock(user.id, id);
          return send(res, 200, { ok: true });
        }
        if (pathname === '/api/report') {
          // Se puede reportar a quien ha compartido partida contigo o, desde su perfil o la búsqueda, por un nombre abusivo u otro motivo.
          const fromProfile = typeof body.ctx === 'string' && /^(profile|search)/.test(body.ctx);
          if (!id || !(canInteract(id) || (fromProfile && !social.isBlocked(user.id, id)))) return send(res, 404, { error: 'No encontrado' });
          return send(res, 200, social.report(user.id, id, body.reason, body.ctx));
        }
        return send(res, 404, { error: 'No encontrado' });
      }

      if (pathname === '/api/wallet' && method === 'GET') return send(res, 200, { wallet: wallets.ensure(user.id) });

      if (pathname === '/api/wallet/ops' && method === 'POST') {
        const body = await readJson(req, 16 * 1024);
        if (!Array.isArray(body.ops)) return send(res, 400, { error: 'Operaciones no válidas' });
        const applied = wallets.apply(user.id, body.ops);
        for (const r of applied.results) metrics?.inc('wallet_ops_total', { result: r.ok ? (r.reason ?? 'ok') : r.reason });
        return send(res, 200, applied);
      }

      if (pathname === '/api/daily/submit' && method === 'POST') {
        const body = await readJson(req);
        const day = dayId();
        const puzzle = puzzleFor(day, puzzles);
        if (!verifySolution(puzzle, body.moves)) return send(res, 400, { error: 'La solución no es un mate válido' });
        db.dailySubmit(day, user.id, clamp(body.seconds, 2, 3600), clamp(body.attempts, 1, 99));
        progression.recordPuzzle(user.id, day); // XP verificada: el servidor comprobó el mate (una vez por día)
        return send(res, 200, dailyPayload(day, user));
      }

      return send(res, 404, { error: 'No encontrado' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[api]', err);
      return send(res, status, { error: status === 500 ? 'Error interno' : err.message, ...(err.reason ? { reason: err.reason } : {}) });
    }
  };
}
