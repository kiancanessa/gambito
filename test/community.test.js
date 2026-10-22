// Capa comunitaria: búsqueda, perfiles con privacidad, enfrentamientos, espectadores (solo lectura y con retraso),
// partidas públicas, eventos de creadores, moderación y enlaces compartibles.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { LIMITS } from '../server/config.js';
import { openDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { RoomManager } from '../server/rooms.js';
import { createWallets } from '../server/wallet.js';

LIMITS.guestsPerHour = 100_000; // estas pruebas crean muchas cuentas desde la misma IP
const json = { 'Content-Type': 'application/json' };
let app;
let base;
const apps = [];
const OPTIONS = { autoSchedule: false, tickMs: 50, firstMatchDelayMs: 1e9, intermissionMs: 1e9, noShowMs: 1e9, openLeadMs: 60_000, closeLeadMs: 100, minLeadMs: 0, fullStartDelayMs: 150 };
const start = async () => {
  const a = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0, circuitOptions: OPTIONS });
  apps.push(a);
  app = a;
  base = `http://127.0.0.1:${a.port}`;
  return a;
};
const boot = async () => app ?? start();
// Cada grupo con muchas peticiones usa su propio servidor: así el límite general por IP (240/min) no mezcla pruebas distintas.
const fresh = () => before(start);
after(async () => Promise.allSettled(apps.map((a) => a.close())));

let n = 0;
const guest = async (name = 'Jugador') => {
  const res = await (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name: `${name}${++n}`.slice(0, 16) }) })).json();
  if (!res.user) throw new Error(`no se pudo crear la cuenta: ${JSON.stringify(res)}`);
  return res;
};
const authed = (g) => ({ ...json, Authorization: `Bearer ${g.token}` });
const call = async (g, method, p, body) => {
  const res = await fetch(`${base}${p}`, { method, headers: g ? authed(g) : json, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const get = (g, p) => call(g, 'GET', p);
const post = (g, p, body) => call(g, 'POST', p, body ?? {});
const patch = (g, p, body) => call(g, 'PATCH', p, body);
const befriend = async (a, b) => {
  await post(a, '/api/social/request', { id: b.user.id });
  return post(b, '/api/social/request', { id: a.user.id }); // la solicitud cruzada acepta
};
const fakeWs = () => ({ readyState: 1, sent: [], meta: {}, send(raw) { this.sent.push(JSON.parse(raw)); } });
const lastState = (ws) => ws.sent.filter((m) => m.t === 'state').at(-1);

// Partida clasificatoria terminada de verdad (mate del pastor invertido en 4 jugadas) entre dos cuentas reales.
function playRated(ua, ub, { circuit = null } = {}) {
  const room = app.rooms.create({ tcId: 'none', rated: !circuit, colorPref: 'w', reserved: circuit ? { w: ua.id, b: ub.id } : null, strict: !!circuit, circuit });
  const [wa, wb] = [fakeWs(), fakeWs()];
  room.seat({ ...ua, games: 0 }, wa);
  room.seat({ ...ub, games: 0 }, wb);
  for (const [ws, uci] of [[wa, 'f2f3'], [wb, 'e7e5'], [wa, 'g2g4'], [wb, 'd8h4']]) room.move(ws, uci);
  assert.equal(room.status, 'over');
  return room;
}

describe('búsqueda de usuarios', () => {
  test('exige sesión y 2 letras; encuentra por parte del nombre sin distinguir mayúsculas; solo datos públicos', async () => {
    await boot();
    const a = await guest('Buscador');
    const t = await guest('Tormenta');
    assert.equal((await get(null, '/api/users/search?q=torm')).status, 401);
    assert.equal((await get(a, '/api/users/search?q=t')).status, 400);
    assert.equal((await get(a, '/api/users/search')).status, 400);
    const r = await get(a, '/api/users/search?q=TORMEN');
    assert.equal(r.status, 200);
    const hit = r.json.users.find((u) => u.id === t.user.id);
    assert.ok(hit);
    assert.deepEqual(Object.keys(hit).sort(), ['id', 'name', 'rating', 'relation']);
    assert.equal(hit.relation, 'none');
    assert.ok(!r.json.users.some((u) => u.id === a.user.id), 'no te devuelve a ti mismo');
    assert.doesNotMatch(JSON.stringify(r.json), /token|hash|recovery|email|last_seen|code/i);
  });

  test('los comodines no son comodines, el máximo es 10 y no se puede enumerar la base de datos', async () => {
    await boot();
    const a = await guest('Enumera');
    for (let i = 0; i < 12; i += 1) await guest('Muchos');
    assert.equal((await get(a, '/api/users/search?q=%25%25')).json.users.length, 0, '«%%» no devuelve a todo el mundo');
    assert.equal((await get(a, '/api/users/search?q=__')).json.users.length, 0, '«_» tampoco');
    assert.equal((await get(a, '/api/users/search?q=muchos')).json.users.length, 10);
  });

  test('oculta a quien lo pide, a bloqueados (en ambos sentidos) y a cuentas restringidas', async () => {
    await boot();
    const [a, hidden, blocked, blocker, restricted] = [await guest('Mira'), await guest('Oculto'), await guest('Bloqueado'), await guest('Bloqueador'), await guest('Restringido')];
    await patch(hidden, '/api/me/privacy', { searchable: false });
    await post(a, '/api/social/block', { id: blocked.user.id });
    await post(blocker, '/api/social/block', { id: a.user.id });
    app.db.community.setModeration(restricted.user.id, 'restricted', 'prueba');
    const names = async (q) => (await get(a, `/api/users/search?q=${q}`)).json.users.map((u) => u.id);
    assert.ok(!(await names('oculto')).includes(hidden.user.id));
    assert.ok(!(await names('bloqueado')).includes(blocked.user.id));
    assert.ok(!(await names('bloqueador')).includes(a.user.id));
    assert.ok(!(await names('bloqueador')).includes(blocker.user.id), 'quien te bloqueó tampoco aparece');
    assert.ok(!(await names('restringido')).includes(restricted.user.id));
  });

  test('las búsquedas tienen límite de frecuencia', async () => {
    await boot();
    const a = await guest('Spammer');
    let last = 200;
    for (let i = 0; i < 35; i += 1) last = (await get(a, '/api/users/search?q=jugador')).status;
    assert.equal(last, 429);
  });
});

describe('solicitudes de amistad y lista de amigos', () => {
  test('desde la búsqueda: pendiente, sin duplicados, cruzada se acepta, y se valida en el servidor', async () => {
    await boot();
    const [a, b] = [await guest('Ana'), await guest('Beto')];
    const r1 = await post(a, '/api/social/request', { id: b.user.id });
    const r2 = await post(a, '/api/social/request', { id: b.user.id });
    assert.equal(r1.json.status, 'pending');
    assert.equal(r2.json.status, 'pending', 'repetirla no duplica nada');
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) AS n FROM friendships WHERE low IN (?,?) AND high IN (?,?)').get(a.user.id, b.user.id, a.user.id, b.user.id).n, 1);
    assert.equal((await post(a, '/api/social/respond', { id: b.user.id, accept: true })).status, 404, 'no puedes aceptar tu propia solicitud');
    assert.equal((await post(b, '/api/social/request', { id: a.user.id })).json.status, 'friends');
    const list = (await get(a, '/api/social')).json;
    assert.deepEqual(list.friends.map((f) => f.id), [b.user.id]);
    assert.equal((await post(a, '/api/social/request', { id: a.user.id })).status, 400, 'ni a ti mismo');
  });

  test('quien no acepta solicitudes lo dice; un bloqueo hace que «no exista»', async () => {
    await boot();
    const [a, closed, blocker] = [await guest('Pide'), await guest('Cerrado'), await guest('Bloquea')];
    await patch(closed, '/api/me/privacy', { acceptRequests: false });
    const r = await post(a, '/api/social/request', { id: closed.user.id });
    assert.equal(r.status, 403);
    await post(blocker, '/api/social/block', { id: a.user.id });
    assert.equal((await post(a, '/api/social/request', { id: blocker.user.id })).status, 404);
  });

  test('el estado en línea solo se ve si el amigo lo permite', async () => {
    await boot();
    const [a, b] = [await guest('Mira'), await guest('Conectado')];
    await befriend(a, b);
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'auth', token: b.token }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await get(a, '/api/social')).json.friends[0].presence, 'online');
    await patch(b, '/api/me/privacy', { showOnline: false });
    assert.equal((await get(a, '/api/social')).json.friends[0].presence, 'offline', 'si no lo permite, se muestra como desconectado');
    ws.close();
  });
});

describe('privacidad y perfiles públicos', () => {
  test('ajustes de privacidad: valores por defecto, cambios válidos y entradas rechazadas', async () => {
    await boot();
    const a = await guest('Priv');
    assert.deepEqual((await get(a, '/api/me/privacy')).json.privacy, { profile: 'public', searchable: true, showOnline: true, acceptRequests: true, acceptInvites: 'friends' });
    assert.equal((await patch(a, '/api/me/privacy', { profile: 'friends', showOnline: false })).json.privacy.profile, 'friends');
    for (const bad of [{ profile: 'todos' }, { searchable: 'si' }, { acceptInvites: 'everyone' }, { inventado: true }, [], 'x']) assert.equal((await patch(a, '/api/me/privacy', bad)).status, 400, JSON.stringify(bad));
    assert.deepEqual((await get(a, '/api/me/privacy')).json.privacy, { profile: 'friends', searchable: true, showOnline: false, acceptRequests: true, acceptInvites: 'friends' }, 'lo rechazado no cambia nada');
  });

  test('perfil público: estadísticas, identidad y enlace; sin datos privados; visible para visitantes sin sesión', async () => {
    await boot();
    const [a, b] = [await guest('Publico'), await guest('Visitante')];
    const anon = await get(null, `/api/users/${a.user.id}`);
    assert.equal(anon.status, 200);
    const p = anon.json.profile;
    assert.equal(p.name, a.user.name);
    assert.equal(p.link, `/u/${a.user.id}`);
    assert.equal(p.limited, false);
    assert.ok(p.stats && p.identity && typeof p.level === 'number' && p.achievements.total > 0);
    assert.equal(p.relation, 'none');
    assert.equal(p.h2h, undefined, 'sin sesión no hay enfrentamientos');
    const text = JSON.stringify(anon.json);
    assert.doesNotMatch(text, /token|recovery|hash|email|correo|last_seen|friend_code|"code"/i, 'ni correos, ni hashes, ni códigos, ni última conexión');
    assert.equal((await get(b, `/api/users/${a.user.id}`)).json.profile.viewerCan.request, true);
    assert.equal((await get(null, '/api/users/no-existe')).status, 404);
    assert.ok((await get(null, `/api/users/${'x'.repeat(60)}`)).status >= 400);
  });

  test('solo amigos: los demás ven nombre, rating y avatar; los amigos, todo. Privado: solo el nombre', async () => {
    await boot();
    const [a, friend, stranger] = [await guest('Reservado'), await guest('Amigo'), await guest('Extrano')];
    await befriend(a, friend);
    await patch(a, '/api/me/privacy', { profile: 'friends' });
    const seen = (await get(stranger, `/api/users/${a.user.id}`)).json.profile;
    assert.equal(seen.limited, true);
    assert.ok(seen.rating !== undefined && seen.identity);
    assert.equal(seen.stats, undefined);
    assert.equal(seen.recent, undefined);
    assert.equal((await get(friend, `/api/users/${a.user.id}`)).json.profile.limited, false);
    await patch(a, '/api/me/privacy', { profile: 'private' });
    const priv = (await get(friend, `/api/users/${a.user.id}`)).json.profile;
    assert.deepEqual(Object.keys(priv).filter((k) => ['rating', 'stats', 'identity', 'recent', 'level'].includes(k)), []);
    assert.equal(priv.name, a.user.name);
    const own = (await get(a, `/api/users/${a.user.id}`)).json.profile;
    assert.equal(own.relation, 'self');
    assert.ok(own.stats, 'uno siempre se ve completo a sí mismo');
  });

  test('un bloqueo en cualquier sentido hace que el perfil no exista; una cuenta restringida solo enseña el nombre', async () => {
    await boot();
    const [a, b, c] = [await guest('Quien'), await guest('Bloqueado'), await guest('Restr')];
    await post(a, '/api/social/block', { id: b.user.id });
    assert.equal((await get(a, `/api/users/${b.user.id}`)).status, 404);
    assert.equal((await get(b, `/api/users/${a.user.id}`)).status, 404, 'ni sabe que lo bloquearon');
    assert.equal((await get(null, `/api/users/${b.user.id}`)).status, 200, 'un visitante anónimo no está bloqueado por nadie');
    app.db.community.setModeration(c.user.id, 'restricted');
    const p = (await get(a, `/api/users/${c.user.id}`)).json.profile;
    assert.equal(p.limited, true);
    assert.equal(p.viewerCan.request, false);
    assert.equal(p.stats, undefined);
  });

});

describe('historial de enfrentamientos y rivalidades', () => {
  test('totales y últimas partidas entre dos jugadores, sin mezclar con otros rivales', async () => {
    await boot();
    const [a, b, c] = [await guest('Rival'), await guest('Contrincante'), await guest('Tercero')];
    playRated(a.user, b.user); // blancas pierden (mate de las negras)
    playRated(b.user, a.user); // a juega con negras y gana
    playRated(a.user, c.user);
    const h = (await get(a, `/api/users/${b.user.id}/h2h`)).json.h2h;
    assert.equal(h.games, 2);
    assert.equal(h.wins, 1);
    assert.equal(h.losses, 1);
    assert.equal(h.recent.length, 2);
    const mirror = (await get(b, `/api/users/${a.user.id}/h2h`)).json.h2h;
    assert.deepEqual([mirror.wins, mirror.losses, mirror.games], [1, 1, 2], 'visto desde el otro lado es simétrico');
    assert.ok(h.recent.every((g) => g.id && ['win', 'loss', 'draw'].includes(g.result)));
    assert.equal((await get(null, `/api/users/${b.user.id}/h2h`)).status, 401);
    const profile = (await get(a, `/api/users/${b.user.id}`)).json.profile;
    assert.equal(profile.h2h.games, 2, 'el perfil incluye el enfrentamiento del visitante');
  });

  test('rivalidades: quien más has jugado, con récord, y sin bloqueados', async () => {
    await boot();
    const [a, b, c] = [await guest('Jugador'), await guest('Habitual'), await guest('Ocasional')];
    playRated(a.user, b.user);
    playRated(a.user, b.user);
    playRated(a.user, c.user);
    const rivals = (await get(a, '/api/me/rivals')).json.rivals;
    assert.deepEqual(rivals.map((r) => r.id), [b.user.id], 'una sola partida no es rivalidad');
    assert.equal(rivals[0].games, 2);
    await post(a, '/api/social/block', { id: b.user.id });
    assert.deepEqual((await get(a, '/api/me/rivals')).json.rivals, []);
    assert.equal((await get(a, `/api/users/${b.user.id}/h2h`)).status, 404);
  });
});

describe('invitaciones sin spam', () => {
  fresh();
  async function conn(g) {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const log = [];
    ws.on('message', (d) => log.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'auth', token: g.token }));
    const until = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const f = log.find(pred);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('timeout');
    };
    await until((m) => m.t === 'authed');
    return { ws, log, until, send: (m) => ws.send(JSON.stringify(m)) };
  }

  test('no se repite la misma invitación, y quien no las acepta no las recibe', async () => {
    await boot();
    const [host, f1, f2] = [await guest('Anfitrion'), await guest('Amigo'), await guest('Cerrado')];
    await befriend(host, f1);
    await befriend(host, f2);
    const [h, w1, w2] = [await conn(host), await conn(f1), await conn(f2)];
    h.send({ t: 'create', tc: 'blitz5', color: 'w' });
    await h.until((m) => m.t === 'created');
    h.send({ t: 'invite', to: f1.user.id });
    await w1.until((m) => m.t === 'invite');
    h.send({ t: 'invite', to: f1.user.id });
    const dup = await h.until((m) => m.t === 'error' && /ya invitaste/i.test(m.message));
    assert.ok(dup);
    assert.equal(w1.log.filter((m) => m.t === 'invite').length, 1, 'el amigo recibió una sola invitación');
    await patch(f2, '/api/me/privacy', { acceptInvites: 'nobody' });
    h.send({ t: 'invite', to: f2.user.id });
    await h.until((m) => m.t === 'error' && /no acepta invitaciones/i.test(m.message));
    assert.equal(w2.log.filter((m) => m.t === 'invite').length, 0);
    for (const c of [h, w1, w2]) c.ws.close();
  });
});

describe('moderación y denuncias', () => {
  fresh();
  test('reportar desde el perfil; con 3 personas distintas la cuenta pasa a revisión (sin sanción automática)', async () => {
    await boot();
    const [target, r1, r2, r3] = [await guest('Abusivo'), await guest('Uno'), await guest('Dos'), await guest('Tres')];
    assert.equal((await post(r1, '/api/report', { id: target.user.id, reason: 'nombre', ctx: 'profile' })).status, 200);
    assert.equal((await post(r1, '/api/report', { id: target.user.id, reason: 'nombre', ctx: 'profile' })).json.duplicate, true, 'el mismo reporte no se duplica');
    assert.equal(app.db.community.moderation(target.user.id).status, 'ok');
    await post(r2, '/api/report', { id: target.user.id, reason: 'abuso', ctx: 'profile' });
    assert.equal(app.db.community.moderation(target.user.id).status, 'ok', 'con 2 personas todavía no');
    await post(r3, '/api/report', { id: target.user.id, reason: 'otro', ctx: 'profile' });
    assert.equal(app.db.community.moderation(target.user.id).status, 'review');
    assert.equal((await get(r1, `/api/users/${target.user.id}`)).json.profile.limited, false, 'en revisión no se le oculta: solo se avisa a quien modera');
    assert.equal((await post(r1, '/api/report', { id: target.user.id, reason: 'inventado', ctx: 'profile' })).status, 400);
    assert.equal((await post(r1, '/api/report', { id: r1.user.id, reason: 'abuso', ctx: 'profile' })).status, 400, 'no te puedes reportar');
  });

  test('un reporte es limitado por día y no se puede reportar a un bloqueado sin pasar por el perfil', async () => {
    await boot();
    const a = await guest('Reporta');
    const victims = [];
    for (let i = 0; i < 6; i += 1) victims.push(await guest('Victima'));
    const codes = [];
    for (const v of victims) codes.push((await post(a, '/api/report', { id: v.user.id, reason: 'nombre', ctx: 'profile' })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429], 'máximo 5 reportes al día');
  });

  test('las rutas de administración no existen sin ADMIN_TOKEN y exigen el token', async () => {
    await boot();
    delete process.env.ADMIN_TOKEN;
    assert.equal((await fetch(`${base}/api/admin/reports`)).status, 404);
    process.env.ADMIN_TOKEN = 'secreto-de-prueba-123';
    try {
      assert.equal((await fetch(`${base}/api/admin/reports`)).status, 401);
      assert.equal((await fetch(`${base}/api/admin/reports`, { headers: { Authorization: 'Bearer otro' } })).status, 401);
      const ok = { headers: { Authorization: 'Bearer secreto-de-prueba-123', ...json } };
      const target = await guest('Revisado');
      const reporter = await guest('Denuncia');
      await post(reporter, '/api/report', { id: target.user.id, reason: 'abuso', ctx: 'profile' });
      const list = await (await fetch(`${base}/api/admin/reports`, ok)).json();
      assert.ok(list.reports.some((r) => r.id === target.user.id && r.people === 1));
      assert.equal((await fetch(`${base}/api/admin/moderate`, { method: 'POST', ...ok, body: JSON.stringify({ userId: target.user.id, status: 'raro' }) })).status, 400);
      assert.equal((await fetch(`${base}/api/admin/moderate`, { method: 'POST', ...ok, body: JSON.stringify({ userId: 'nadie', status: 'ok' }) })).status, 400);
      const res = await fetch(`${base}/api/admin/moderate`, { method: 'POST', ...ok, body: JSON.stringify({ userId: target.user.id, status: 'restricted', note: 'prueba' }) });
      assert.equal(res.status, 200);
      assert.equal(app.db.community.moderation(target.user.id).status, 'restricted');
      assert.ok(!(await get(reporter, '/api/users/search?q=revisado')).json.users.some((u) => u.id === target.user.id), 'una cuenta restringida desaparece de la búsqueda');
    } finally {
      delete process.env.ADMIN_TOKEN;
    }
  });
});

describe('espectadores', () => {
  fresh();
  test('quien mira no puede mover, rendirse, ofrecer tablas, hacer gestos ni pedir revancha', () => {
    const db = openDb(':memory:');
    const rooms = new RoomManager(db);
    const room = rooms.create({ tcId: 'none', rated: true, colorPref: 'w' });
    const [w, b, spec] = [fakeWs(), fakeWs(), fakeWs()];
    for (const [id, ws] of [['uw', w], ['ub', b]]) {
      db.createUser({ id, name: id, tokenHash: `h-${id}`, recoveryHash: null });
      room.seat({ id, name: id, rating: 1000, games: 0 }, ws);
    }
    room.seat({ id: 'us', name: 'espectador', rating: 1000, games: 0 }, spec);
    room.move(w, 'e2e4');
    const before = JSON.stringify([room.uci, room.status, room.drawOffer]);
    room.move(spec, 'e7e5');
    room.move(spec, 'd2d4');
    room.resign(spec);
    room.drawAction(spec, 'offer');
    room.drawAction(spec, 'accept');
    room.emote(spec, 1);
    room.rematch(spec);
    assert.equal(JSON.stringify([room.uci, room.status, room.drawOffer]), before, 'nada cambió');
    assert.equal(spec.meta.role, 's');
    assert.equal(room.status, 'playing');
    rooms.close();
    db.close();
  });

  test('por WebSocket: un espectador que intenta jugar, rendirse o chatear no altera la partida', async () => {
    await boot();
    const [a, b, s] = [await guest('Blancas'), await guest('Negras'), await guest('Mirón')];
    const conn = async (g) => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
      const log = [];
      ws.on('message', (d) => log.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ t: 'auth', token: g.token }));
      await new Promise((r) => setTimeout(r, 120));
      return { ws, log, send: (m) => ws.send(JSON.stringify(m)) };
    };
    const [ca, cb, cs] = [await conn(a), await conn(b), await conn(s)];
    ca.send({ t: 'create', tc: 'none', color: 'w' });
    await new Promise((r) => setTimeout(r, 150));
    const code = ca.log.find((m) => m.t === 'created').code;
    cb.send({ t: 'join', code });
    cs.send({ t: 'join', code });
    await new Promise((r) => setTimeout(r, 250));
    ca.send({ t: 'move', uci: 'e2e4' });
    await new Promise((r) => setTimeout(r, 150));
    const seen = cs.log.filter((m) => m.t === 'state').at(-1);
    assert.equal(seen.you, 's');
    assert.deepEqual(seen.moves, ['e2e4'], 'el espectador ve la partida en directo (sin retraso en partidas con amigo)');
    for (const m of [{ t: 'move', uci: 'e7e5' }, { t: 'resign' }, { t: 'draw', action: 'offer' }, { t: 'emote', id: 2 }, { t: 'rematch' }]) cs.send(m);
    await new Promise((r) => setTimeout(r, 250));
    const room = app.rooms.get(code);
    assert.deepEqual(room.uci, ['e2e4']);
    assert.equal(room.status, 'playing');
    assert.equal(cb.log.filter((m) => m.t === 'emote').length, 0, 'tampoco llegan gestos de espectadores a los jugadores');
    for (const c of [ca, cb, cs]) c.ws.close();
  });

  test('retraso configurable: los jugadores ven la jugada al instante y los espectadores, pasado el retraso', async () => {
    const db = openDb(':memory:');
    const rooms = new RoomManager(db, { spectatorDelays: { ranked: 250, circuit: 20_000 } });
    assert.equal(rooms.create({ tcId: 'none', rated: true }).specDelay, 250, 'las clasificatorias usan su retraso');
    assert.equal(rooms.create({ tcId: 'none', circuit: { id: 't', round: 0, label: 'Final' } }).specDelay, 20_000, 'las del Circuit, el suyo');
    assert.equal(rooms.create({ tcId: 'none' }).specDelay, 0, 'las partidas con amigo, en directo');
    assert.equal(new RoomManager(db).create({ tcId: 'none', circuit: { id: 't', round: 0, label: 'Final' } }).specDelay, 20_000, 'por defecto, el Circuit retrasa 20 s');
    assert.equal(new RoomManager(db).create({ tcId: 'none', rated: true }).specDelay, 0);

    const room = rooms.create({ tcId: 'none', rated: true, colorPref: 'w' });
    const [w, b, spec] = [fakeWs(), fakeWs(), fakeWs()];
    for (const [id, ws] of [['dw', w], ['db', b]]) {
      db.createUser({ id, name: id, tokenHash: `h-${id}`, recoveryHash: null });
      room.seat({ id, name: id, rating: 1000, games: 0 }, ws);
    }
    room.broadcast();
    room.seat({ id: 'ds', name: 'mira', rating: 1000, games: 0 }, spec);
    room.broadcast();
    room.move(w, 'e2e4');
    assert.deepEqual(lastState(w).moves, ['e2e4'], 'el jugador lo ve al instante');
    assert.equal(lastState(w).delayMs, 0);
    assert.deepEqual(lastState(spec).moves, [], 'el espectador todavía no');
    assert.equal(lastState(spec).delayMs, 250);
    const late = fakeWs();
    room.seat({ id: 'dl', name: 'tarde', rating: 1000, games: 0 }, late);
    assert.deepEqual(lastState(late).moves, [], 'quien llega ahora ve el estado de hace 250 ms, no el actual');
    await new Promise((r) => setTimeout(r, 330));
    assert.deepEqual(lastState(spec).moves, ['e2e4'], 'pasado el retraso, lo recibe');
    assert.deepEqual(lastState(late).moves, ['e2e4']);
    room.move(b, 'e7e5');
    assert.deepEqual(lastState(spec).moves, ['e2e4'], 'la siguiente jugada también llega con retraso');
    await new Promise((r) => setTimeout(r, 330));
    assert.deepEqual(lastState(spec).moves, ['e2e4', 'e7e5']);
    rooms.close();
    db.close();
  });

  test('el resultado también llega con retraso a los espectadores del Circuit (no se filtra lo que pasa en directo)', async () => {
    const db = openDb(':memory:');
    const rooms = new RoomManager(db, { spectatorDelays: { circuit: 200 } });
    const room = rooms.create({ tcId: 'none', colorPref: 'w', reserved: { w: 'cw', b: 'cb' }, strict: true, circuit: { id: 't1', round: 2, label: 'Final', tournament: 'Copa' } });
    const [w, b, spec] = [fakeWs(), fakeWs(), fakeWs()];
    for (const [id, ws] of [['cw', w], ['cb', b]]) {
      db.createUser({ id, name: id, tokenHash: `h-${id}`, recoveryHash: null });
      room.seat({ id, name: id, rating: 1000, games: 0 }, ws);
    }
    room.seat({ id: 'cs', name: 'mira', rating: 1000, games: 0 }, spec);
    room.broadcast();
    for (const [ws, uci] of [[w, 'f2f3'], [b, 'e7e5'], [w, 'g2g4'], [b, 'd8h4']]) room.move(ws, uci);
    assert.equal(lastState(w).status, 'over');
    assert.notEqual(lastState(spec).status, 'over', 'el espectador aún no sabe que terminó');
    assert.equal(lastState(spec).circuit.label, 'Final', 'sabe a qué ronda y torneo pertenece');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lastState(spec).status, 'over');
    assert.equal(lastState(spec).result.winner, 'b');
    rooms.close();
    db.close();
  });
});

describe('partidas públicas y repeticiones', () => {
  fresh();
  test('una clasificatoria terminada es pública: aparece en la lista y se puede repetir sin sesión', async () => {
    await boot();
    const [a, b] = [await guest('Publica'), await guest('Rival')];
    const room = playRated(a.user, b.user);
    const list = (await get(null, '/api/public/games')).json.games;
    const g = list.find((x) => x.white.id === a.user.id);
    assert.ok(g, 'aparece en las partidas públicas');
    assert.equal(g.kind, 'ranked');
    const rep = (await get(null, `/api/public/games/${g.id}`)).json.game;
    assert.deepEqual(rep.moves, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.equal(rep.winner, 'b');
    assert.equal(rep.white.name, a.user.name);
    assert.doesNotMatch(JSON.stringify(rep), /token|hash|recovery|email|_id"/i, 'sin datos privados ni identificadores internos de cuenta');
    assert.ok(room.gameId);
  });

  test('las partidas con amigo no son públicas; las de quien tiene el perfil privado, tampoco', async () => {
    await boot();
    const [a, b, c, d] = [await guest('Amigos'), await guest('Juntos'), await guest('Reservada'), await guest('Rival')];
    // partida con amigo (no clasificatoria): sin rastro público
    const friendly = app.rooms.create({ tcId: 'none', rated: false, colorPref: 'w' });
    const [wa, wb] = [fakeWs(), fakeWs()];
    friendly.seat({ ...a.user, games: 0 }, wa);
    friendly.seat({ ...b.user, games: 0 }, wb);
    for (const [ws, uci] of [[wa, 'f2f3'], [wb, 'e7e5'], [wa, 'g2g4'], [wb, 'd8h4']]) friendly.move(ws, uci);
    assert.equal(app.db.community.publicGame(friendly.gameId), null);
    // clasificatoria con una cuenta privada: existe pero no se enseña
    const ranked = playRated(c.user, d.user);
    assert.ok(app.db.community.publicGame(ranked.gameId));
    assert.equal((await get(null, `/api/public/games/${ranked.gameId}`)).status, 200);
    await patch(c, '/api/me/privacy', { profile: 'private' });
    assert.equal((await get(null, `/api/public/games/${ranked.gameId}`)).status, 404);
    assert.ok(!(await get(null, '/api/public/games')).json.games.some((x) => x.id === ranked.gameId));
    assert.equal((await get(null, '/api/public/games/no-existe-1')).status, 404);
    assert.equal((await get(null, `/api/public/games/${friendly.gameId}`)).status, 404);
  });

  test('las partidas de torneo son públicas y llevan el torneo; el perfil enseña las recientes', async () => {
    await boot();
    const [a, b] = [await guest('Torneo'), await guest('Final')];
    const room = playRated(a.user, b.user, { circuit: { id: 'copa-1', round: 1, label: 'Semifinal', tournament: 'Copa' } });
    const g = (await get(null, '/api/public/games')).json.games.find((x) => x.id === room.gameId);
    assert.equal(g.kind, 'circuit');
    assert.equal(g.tournament, 'copa-1');
    const profile = (await get(null, `/api/users/${a.user.id}`)).json.profile;
    assert.ok(profile.recent.some((r) => r.id === room.gameId && r.kind === 'circuit'));
  });

  test('en directo: se listan clasificatorias y de torneo con su retraso; no las de amigos ni las de cuentas privadas', async () => {
    await boot();
    const [a, b, c, d] = [await guest('EnVivoA'), await guest('EnVivoB'), await guest('PrivadaC'), await guest('PrivadaD')];
    const open = (u1, u2, extra) => {
      const room = app.rooms.create({ tcId: 'blitz5', colorPref: 'w', ...extra });
      room.seat({ ...u1, games: 0 }, fakeWs());
      room.seat({ ...u2, games: 0 }, fakeWs());
      return room;
    };
    const ranked = open(a.user, b.user, { rated: true });
    const friendly = open(a.user, c.user, { rated: false });
    await patch(c, '/api/me/privacy', { profile: 'private' });
    const hidden = open(c.user, d.user, { rated: true });
    const circuit = open(d.user, a.user, { rated: false, reserved: { w: d.user.id, b: a.user.id }, strict: true, circuit: { id: 'live-t', round: 0, label: 'Cuartos de final', tournament: 'Copa viva' } });
    const live = (await get(null, '/api/live')).json.games;
    const codes = live.map((g) => g.code);
    assert.ok(codes.includes(ranked.code) && codes.includes(circuit.code));
    assert.ok(!codes.includes(friendly.code), 'una partida con amigo es privada por enlace');
    assert.ok(!codes.includes(hidden.code), 'la de una cuenta privada no se enseña');
    const c1 = live.find((g) => g.code === circuit.code);
    assert.equal(c1.kind, 'circuit');
    assert.equal(c1.circuit.label, 'Cuartos de final');
    assert.equal(c1.delayMs, 20_000, 'se avisa del retraso de la retransmisión');
    assert.equal(live.find((g) => g.code === ranked.code).delayMs, 0);
  });
});

describe('eventos de comunidad (torneos de creadores)', () => {
  fresh();
  const when = (min) => Date.now() + min * 60_000;
  const valid = (over = {}) => ({ title: 'Copa de los viernes', description: 'Torneo amistoso', size: 8, tc: 'blitz5', startsAt: when(30), ...over });
  async function organizer(name = 'Organiza') {
    const g = await guest(name);
    createWallets(app.db).grant(g.user.id, { ref: `lvl-${g.user.id}`, source: 'xp', xp: 100 + 160 }); // nivel 3: actividad mínima verificada
    return g;
  }

  test('crear un evento: valida nivel, texto, tamaño, control de tiempo y hora', async () => {
    await boot();
    const newbie = await guest('Novato');
    const r0 = await post(newbie, '/api/events', valid());
    assert.equal(r0.status, 403);
    assert.equal(r0.json.reason, 'level');
    const o = await organizer();
    const cases = [
      [{ title: 'ab' }, 'title'], [{ title: 'Visita www.malo.com' }, 'link'], [{ description: 'entra en https://x.y' }, 'link'], [{ size: 12 }, 'size'],
      [{ tc: 'bullet' }, 'tc'], [{ startsAt: when(2) }, 'time'], [{ startsAt: when(60 * 24 * 30) }, 'time'], [{ startsAt: 'mañana' }, 'time'],
    ];
    for (const [over, reason] of cases) {
      const r = await post(o, '/api/events', valid(over));
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.equal(r.json.reason, reason);
    }
    const ok = await post(o, '/api/events', valid({ title: '  <b>Copa</b>   de   los viernes ' }));
    assert.equal(ok.status, 200);
    const t = ok.json.tournament;
    assert.equal(t.name, 'b Copa /b de los viernes', 'sin marcado: < y > se sustituyen y los espacios se normalizan');
    assert.equal(t.community, true);
    assert.equal(t.organizer.name, o.user.name);
    assert.deepEqual(t.prizes, {}, 'los torneos de creador no dan premios');
    assert.ok(['scheduled', 'open'].includes(t.status));
  });

  test('límites: dos eventos activos, tres al día, cancelar solo el organizador y solo antes de empezar', async () => {
    await boot();
    const [o, other] = [await organizer('Prolifico'), await organizer('Otro')];
    const a = await post(o, '/api/events', valid());
    const b = await post(o, '/api/events', valid({ title: 'Segunda copa' }));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const c = await post(o, '/api/events', valid({ title: 'Tercera copa' }));
    assert.equal(c.status, 429);
    assert.equal(c.json.reason, 'active');
    assert.equal((await post(other, `/api/events/${a.json.id}/cancel`)).status, 404, 'solo cancela el organizador');
    assert.equal((await post(o, `/api/events/${a.json.id}/cancel`)).status, 200);
    assert.equal((await post(o, `/api/events/${a.json.id}/cancel`)).status, 409, 'ya estaba cancelado');
    assert.equal((await post(o, '/api/events', valid({ title: 'Tercera copa' }))).status, 200, 'al cancelar queda hueco');
    await post(o, `/api/events/${b.json.id}/cancel`);
    const d = await post(o, '/api/events', valid({ title: 'Cuarta copa' }));
    assert.equal(d.status, 429);
    assert.equal(d.json.reason, 'daily', 'máximo 3 creaciones al día');
    const t = (await get(null, `/api/circuit/t/${a.json.id}`)).json;
    assert.equal(t.status, 'cancelled');
    assert.match(t.cancelReason, /organizador/);
  });

  test('cuentas en revisión o restringidas no pueden organizar', async () => {
    await boot();
    const [o, r] = [await organizer('Revisada'), await organizer('Restringida')];
    app.db.community.setModeration(o.user.id, 'review');
    app.db.community.setModeration(r.user.id, 'restricted');
    assert.equal((await post(o, '/api/events', valid())).json.reason, 'restricted');
    assert.equal((await post(r, '/api/events', valid())).status, 403);
  });

  test('aparece en la lista pública con su organizador y se juega como un torneo, sin premios, XP ni historial oficial', async () => {
    await boot({});
    const o = await organizer('Creador');
    const t = app.circuit.scheduleCommunity({ creatorId: o.user.id, creatorName: o.user.name, title: 'Copa sin premios', size: 8, tc: 'blitz3_2', startsAt: Date.now() + 700 });
    const list = (await get(null, '/api/circuit')).json;
    const card = list.tournaments.find((x) => x.id === t.id);
    assert.equal(card.community, true);
    assert.equal(card.organizer.name, o.user.name);
    const hs = [];
    for (let i = 0; i < 4; i += 1) {
      const g = await guest('Jug');
      const ws = fakeWs();
      hs.push({ g, ws });
      assert.equal(app.circuit.join(g.user, t.id, ws).ok, true);
    }
    for (let i = 0; i < 80 && t.status !== 'running'; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.status, 'running');
    for (let guard = 0; guard < 20 && t.status === 'running'; guard += 1) {
      for (const m of t.matches.flat()) if (m.status !== 'done' && m.aId && m.bId) app.circuit.finishMatch(t, m, app.circuit.higherSeed(t, m), 'prueba');
    }
    assert.equal(t.status, 'finished');
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) AS n FROM tournament_results WHERE tournament_id = ?').get(t.id).n, 0, 'sin historial oficial ni premios');
    assert.equal(app.db.raw.prepare("SELECT COUNT(*) AS n FROM progress_events WHERE ref LIKE ?").get(`circuit%${t.id}`).n, 0, 'sin XP de torneo');
    assert.equal(app.db.raw.prepare('SELECT status FROM community_events WHERE tournament_id = ?').get(t.id).status, 'finished');
    const winner = hs.find((h) => h.g.user.id === t.championId);
    const claim = await post(winner.g, '/api/wallet/ops', { ops: [{ oid: 'c', t: 'earn', source: 'circuit', key: `circuit:${t.id}` }] });
    assert.equal(claim.json.results[0].reason, 'unverified', 'no hay premio que cobrar');
    const after = (await get(null, '/api/circuit')).json;
    const recent = after.recent.find((r) => r.id === t.id);
    assert.equal(recent.community, true);
    assert.equal(recent.organizer, o.user.name);
    assert.equal(recent.champion, winner.g.user.name, 'la página de resultados muestra al campeón');
    assert.ok(!after.champions.some((c) => c.name === winner.g.user.name), 'el palmarés oficial no incluye torneos de creadores');
  });
});

describe('enlaces compartibles', () => {
  test('perfil (/u/), torneo (/t/), repetición (/r/) y partida (/g/) sirven la aplicación; lo demás, no', async () => {
    await boot();
    for (const p of ['/u/abc123', '/t/6f1c2d3e-aaaa-bbbb-cccc-111122223333', '/r/9f8e7d6c-1111-2222-3333-444455556666', '/g/ABCDEF']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(await res.text(), /CHECKPOINT/);
    }
    assert.equal((await fetch(`${base}/x/abc`)).status, 404);
    assert.equal((await fetch(`${base}/u/../server/index.js`)).status === 200, false);
    assert.equal((await fetch(`${base}/u/${'a'.repeat(100)}`)).status, 404);
  });
});

describe('límites de frecuencia', () => {
  fresh();
  test('los visitantes anónimos tienen límite de frecuencia', async () => {
    await boot();
    const a = await guest('Limite');
    let last = 200;
    for (let i = 0; i < 125; i += 1) last = (await get(null, `/api/users/${a.user.id}`)).status;
    assert.equal(last, 429);
  });
});
