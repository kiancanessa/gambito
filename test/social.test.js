// Fase 5: amigos por código, presencia, invitaciones, bloqueos y reportes (con varios clientes).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { LIMITS } from '../server/config.js';
import { startServer } from '../server/index.js';
import { SOCIAL_LIMITS } from '../server/social.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
let app;
let base;

before(async () => {
  LIMITS.guestsPerHour = 500; // este archivo crea muchas cuentas de prueba desde la misma IP
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES });
  base = `http://127.0.0.1:${app.port}`;
});
after(() => {
  LIMITS.guestsPerHour = 20;
  return app.close();
});

const json = { 'Content-Type': 'application/json' };
const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
const auth = (g) => ({ ...json, Authorization: `Bearer ${g.token}` });
const social = async (g) => (await fetch(`${base}/api/social`, { headers: auth(g) })).json();
const post = async (g, path, body) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: auth(g), body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const befriend = async (a, b) => {
  const code = (await social(b)).code;
  await post(a, '/api/social/request', { code });
  await post(b, '/api/social/respond', { id: a.user.id, accept: true });
};

async function connect(g) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const f = msgs.find(pred);
        if (f) return resolve(f);
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push({ test: pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    close: () => ws.close(),
  };
  c.send({ t: 'auth', token: g.token });
  await c.waitFor((m) => m.t === 'authed');
  return c;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

describe('amigos', () => {
  test('código de amigo, solicitud, aceptación y lista con presencia', async () => {
    const [a, b] = [await guest('Ana'), await guest('Beto')];
    const sa = await social(a);
    assert.match(sa.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal((await social(a)).code, sa.code, 'el código es estable');
    assert.deepEqual(sa.friends, []);

    assert.equal((await post(a, '/api/social/request', { code: 'ZZZZ-ZZZZ' })).status, 404);
    assert.equal((await post(a, '/api/social/request', { code: sa.code })).status, 400, 'no puedes añadirte a ti mismo');

    const wsA = await connect(a);
    const req = await post(b, '/api/social/request', { code: sa.code.toLowerCase().replace('-', ' ') });
    assert.equal(req.json.status, 'pending');
    const pushed = await wsA.waitFor((m) => m.t === 'friend_request');
    assert.equal(pushed.from.id, b.user.id);
    assert.equal((await post(b, '/api/social/request', { code: sa.code })).json.status, 'pending', 'repetir no duplica');

    const sa2 = await social(a);
    assert.equal(sa2.incoming.length, 1);
    assert.equal((await social(b)).outgoing.length, 1);
    assert.equal((await post(b, '/api/social/respond', { id: a.user.id, accept: true })).status, 404, 'quien pidió no puede aceptar');
    assert.equal((await post(a, '/api/social/respond', { id: b.user.id, accept: true })).json.status, 'friends');

    const fa = await social(a);
    assert.deepEqual(fa.friends.map((f) => f.name), ['Beto']);
    assert.equal(fa.friends[0].presence, 'offline');
    const wsB = await connect(b);
    assert.equal((await social(a)).friends[0].presence, 'online');
    wsB.send({ t: 'create', tc: 'blitz5', color: 'w' });
    await wsB.waitFor((m) => m.t === 'created');
    assert.equal((await social(a)).friends[0].presence, 'online', 'esperando rival no cuenta como jugando');
    wsA.close();
    wsB.close();
  });

  test('si los dos se piden amistad, se aceptan solos; quitar amigo la borra', async () => {
    const [a, b] = [await guest('Cruz'), await guest('Dani')];
    await post(a, '/api/social/request', { code: (await social(b)).code });
    const mutual = await post(b, '/api/social/request', { code: (await social(a)).code });
    assert.equal(mutual.json.status, 'friends');
    assert.equal((await social(a)).friends.length, 1);
    await post(a, '/api/social/remove', { id: b.user.id });
    assert.equal((await social(a)).friends.length, 0);
    assert.equal((await social(b)).friends.length, 0);
  });

  test('rechazar una solicitud la elimina', async () => {
    const [a, b] = [await guest('Elena'), await guest('Fran')];
    await post(a, '/api/social/request', { code: (await social(b)).code });
    await post(b, '/api/social/respond', { id: a.user.id, accept: false });
    assert.equal((await social(b)).incoming.length, 0);
    assert.equal((await social(a)).outgoing.length, 0);
  });

  test('por id (búsqueda o perfil) se puede pedir amistad si la persona lo permite; nunca a un bot; reportar exige trato o perfil', async () => {
    const [a, b, c] = [await guest('Gala'), await guest('Hugo'), await guest('Ines')];
    assert.equal((await post(a, '/api/social/request', { id: 'bot-1234' })).status, 404);
    assert.equal((await post(a, '/api/report', { id: c.user.id, reason: 'abuso' })).status, 404, 'no se reporta a un desconocido sin pasar por su perfil');
    assert.equal((await post(a, '/api/report', { id: c.user.id, reason: 'nombre', ctx: 'profile' })).status, 200, 'desde su perfil sí, por un nombre abusivo');
    assert.equal((await post(a, '/api/social/request', { id: c.user.id })).json.status, 'pending', 'desde la búsqueda o el perfil se puede pedir amistad');

    const [wa, wb] = [await connect(a), await connect(b)];
    wa.send({ t: 'create', tc: 'blitz5', color: 'w' });
    const { code } = await wa.waitFor((m) => m.t === 'created');
    wb.send({ t: 'join', code });
    await wb.waitFor((m) => m.t === 'state' && m.status === 'playing');
    assert.equal((await social(a)).friends.length, 0);
    const r = await post(a, '/api/social/request', { id: b.user.id });
    assert.equal(r.json.status, 'pending', 'mientras comparten sala se puede pedir amistad');
    wa.close();
    wb.close();
  });
});

describe('invitaciones', () => {
  test('un amigo recibe la invitación a tu sala y puede unirse; los ajenos no', async () => {
    const [a, b, c] = [await guest('Jana'), await guest('Kike'), await guest('Lola')];
    await befriend(a, b);
    const [wa, wb, wc] = [await connect(a), await connect(b), await connect(c)];

    wa.send({ t: 'invite', to: b.user.id });
    assert.match((await wa.waitFor((m) => m.t === 'error')).message, /Crea una partida/, 'sin sala no se invita');

    wa.send({ t: 'create', tc: 'blitz3', color: 'w' });
    const { code } = await wa.waitFor((m) => m.t === 'created');
    wa.send({ t: 'invite', to: c.user.id });
    await pause(80);
    assert.ok(wa.msgs.filter((m) => m.t === 'error').some((m) => /amigos/.test(m.message)), 'no se invita a no amigos');
    assert.equal(wc.msgs.some((m) => m.t === 'invite'), false);

    wa.send({ t: 'invite', to: b.user.id });
    const inv = await wb.waitFor((m) => m.t === 'invite');
    assert.equal(inv.code, code);
    assert.equal(inv.from.name, 'Jana');
    assert.equal(inv.tc, 'blitz3');
    await wa.waitFor((m) => m.t === 'invited');

    wb.send({ t: 'join', code: inv.code });
    const st = await wb.waitFor((m) => m.t === 'state' && m.status === 'playing');
    assert.equal(st.you === 'w' || st.you === 'b', true);
    [wa, wb, wc].forEach((w) => w.close());
  });

  test('si el amigo no está conectado se avisa', async () => {
    const [a, b] = [await guest('Mara'), await guest('Nico')];
    await befriend(a, b);
    const wa = await connect(a);
    wa.send({ t: 'create', tc: 'blitz5', color: 'w' });
    await wa.waitFor((m) => m.t === 'created');
    wa.send({ t: 'invite', to: b.user.id });
    assert.match((await wa.waitFor((m) => m.t === 'error')).message, /no está conectado/);
    wa.close();
  });
});

describe('bloqueos', () => {
  test('bloquear borra la amistad y corta solicitudes, invitaciones y emparejamientos en ambos sentidos', async () => {
    const [a, b] = [await guest('Olga'), await guest('Pablo')];
    await befriend(a, b);
    const codeA = (await social(a)).code;
    const codeB = (await social(b)).code;
    const bl = await post(a, '/api/social/block', { id: b.user.id });
    assert.equal(bl.status, 200);
    const sa = await social(a);
    assert.equal(sa.friends.length, 0);
    assert.deepEqual(sa.blocked.map((x) => x.name), ['Pablo']);

    // ni él ni yo podemos pedirnos amistad (y no se revela quién bloqueó)
    assert.equal((await post(b, '/api/social/request', { code: codeA })).status, 404);
    assert.equal((await post(a, '/api/social/request', { code: codeB })).status, 404);

    // no se emparejan en la cola clasificatoria
    const [wa, wb] = [await connect(a), await connect(b)];
    wa.send({ t: 'queue', tc: 'blitz3' });
    wb.send({ t: 'queue', tc: 'blitz3' });
    await pause(2200);
    assert.equal(wa.msgs.some((m) => m.t === 'matched'), false);
    assert.equal(wb.msgs.some((m) => m.t === 'matched'), false);
    assert.equal(app.matchmaker.size() >= 2, true);
    wa.send({ t: 'dequeue' });
    wb.send({ t: 'dequeue' });

    // al desbloquear se puede volver a pedir amistad
    await post(a, '/api/social/unblock', { id: b.user.id });
    assert.equal((await social(a)).blocked.length, 0);
    assert.equal((await post(b, '/api/social/request', { code: codeA })).json.status, 'pending');
    wa.close();
    wb.close();
  });

  test('no puedes bloquearte a ti mismo ni a quien no existe', async () => {
    const a = await guest('Quique');
    assert.equal((await post(a, '/api/social/block', { id: a.user.id })).status, 400);
    assert.equal((await post(a, '/api/social/block', { id: 'nadie-existe' })).status, 404);
  });
});

describe('reportes', () => {
  // `host` crea la sala y `guestWs` (una sola conexión del reportero) entra en ella.
  async function playedWith(guestWs, host) {
    const wh = await connect(host);
    wh.send({ t: 'create', tc: 'blitz5', color: 'w' });
    const { code } = await wh.waitFor((m) => m.t === 'created');
    guestWs.send({ t: 'join', code });
    await guestWs.waitFor((m) => m.t === 'state' && m.code === code && m.status === 'playing');
    return { wa: wh, code };
  }

  test('se guardan con motivo válido, sin duplicar el mismo día, y con tope diario', async () => {
    const r = await guest('Reporta');
    const targets = await Promise.all(Array.from({ length: SOCIAL_LIMITS.reportsPerDay + 1 }, (_, i) => guest(`Objetivo${i}`)));
    const wr = await connect(r);
    const rooms = [];
    for (const t of targets) rooms.push(await playedWith(wr, t));

    assert.equal((await post(r, '/api/report', { id: targets[0].user.id, reason: 'spam' })).status, 400, 'motivo inválido');
    assert.equal((await post(r, '/api/report', { id: r.user.id, reason: 'abuso' })).status, 400, 'no puedes reportarte a ti mismo');
    const first = await post(r, '/api/report', { id: targets[0].user.id, reason: 'abuso', ctx: rooms[0].code });
    assert.deepEqual(first.json, { ok: true });
    const dup = await post(r, '/api/report', { id: targets[0].user.id, reason: 'trampas' });
    assert.equal(dup.json.duplicate, true);

    for (const t of targets.slice(1, SOCIAL_LIMITS.reportsPerDay)) assert.equal((await post(r, '/api/report', { id: t.user.id, reason: 'nombre' })).status, 200);
    const over = await post(r, '/api/report', { id: targets.at(-1).user.id, reason: 'otro' });
    assert.equal(over.status, 429);
    const total = app.db.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?').get(r.user.id).n;
    assert.equal(total, SOCIAL_LIMITS.reportsPerDay);
    rooms.forEach(({ wa }) => wa.close());
    wr.close();
  });
});
