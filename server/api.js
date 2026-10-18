// API HTTP/JSON: cuentas de invitado, guardado en la nube, desafío diario, clasificación y estadísticas.
import { bearer, cleanName, defaultName, newId, newRecoveryCode, newToken, normalizeCode, sha256 } from './auth.js';
import { SAVE_LIMIT_BYTES } from './config.js';
import { dayId, nextResetAt, puzzleFor, verifySolution } from './daily.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));

export function createApi({ db, rooms, matchmaker, onlineCount, puzzles }) {
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
    try {
      if (pathname === '/healthz') return send(res, 200, { ok: true });
      if (limited(`all:${ip}`, 240, 60_000)) return send(res, 429, { error: 'Demasiadas peticiones' });

      if (pathname === '/api/guest' && method === 'POST') {
        if (limited(`guest:${ip}`, 20, 3600_000)) return send(res, 429, { error: 'Demasiadas cuentas nuevas desde esta red' });
        const body = await readJson(req);
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

      if (pathname === '/api/stats' && method === 'GET') {
        const s = db.stats();
        return send(res, 200, { online: onlineCount(), queue: matchmaker.size(), rooms: rooms.rooms.size, users: s.users, gamesToday: s.gamesToday });
      }

      if (pathname === '/api/leaderboard' && method === 'GET') {
        const user = authUser(req);
        const top = db.leaderboard(20).map((r, i) => ({ rank: i + 1, ...r }));
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
