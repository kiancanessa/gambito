// API HTTP/JSON: cuentas de invitado, guardado en la nube, desafío diario, clasificación y estadísticas.
import { bearer, cleanName, defaultName, newId, newRecoveryCode, newToken, normalizeCode, sha256 } from './auth.js';
import { timingSafeEqual } from 'node:crypto';
import { LIMITS, SAVE_LIMIT_BYTES, allowedOrigins } from './config.js';
import { dayId, nextResetAt, puzzleFor, verifySolution } from './daily.js';
import { createWallets } from './wallet.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));

export function createApi({ db, rooms, matchmaker, circuit, social, metrics = null, presence = () => ({}), notify = () => 0, onlineCount, puzzles, persistStatus = () => null }) {
  const buckets = new Map();
  const wallets = createWallets(db);

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
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
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
          persist: p && { claimed: p.claimed, degraded: p.degraded, restoredBytes: p.restoredBytes, lastOkAt: p.lastOkAt, lastError: p.lastError, lostOwnership: p.lostOwnership },
        });
      }

      // Lista de torneos (con tu inscripción si hay sesión) y detalle de uno: público, solo lectura. El cuadro lo mueve únicamente el servidor.
      if (pathname === '/api/circuit' && method === 'GET') return send(res, 200, circuit.listView(authUser(req)?.id ?? null));
      const circuitOne = pathname.match(/^\/api\/circuit\/t\/([\w-]{1,64})$/);
      if (circuitOne && method === 'GET') {
        const detail = circuit.detail(circuitOne[1], authUser(req)?.id ?? null);
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'Torneo no encontrado' });
      }

      if (pathname === '/api/live' && method === 'GET') return send(res, 200, { games: rooms.liveGames(6) });

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

      const replay = pathname.match(/^\/api\/games\/([\w-]{8,64})$/);
      if (replay && method === 'GET') {
        const g = db.gameById(replay[1]);
        if (!g || (g.white_id !== user.id && g.black_id !== user.id)) return send(res, 404, { error: 'Partida no encontrada' });
        return send(res, 200, {
          game: {
            id: g.id,
            code: g.code,
            you: g.white_id === user.id ? 'w' : 'b',
            winner: g.winner,
            reason: g.reason,
            rated: !!g.rated,
            tc: g.tc,
            createdAt: g.created_at,
            moves: JSON.parse(g.moves),
            white: { name: g.white_name ?? 'Jugador', rating: g.white_rating },
            black: { name: g.black_name ?? 'Jugador', rating: g.black_rating },
          },
        });
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
          } else if (id && canInteract(id)) targetId = id;
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
          if (!id || !canInteract(id)) return send(res, 404, { error: 'No encontrado' });
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
        return send(res, 200, dailyPayload(day, user));
      }

      return send(res, 404, { error: 'No encontrado' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[api]', err);
      return send(res, status, { error: status === 500 ? 'Error interno' : err.message });
    }
  };
}
