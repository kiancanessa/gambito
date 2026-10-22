// Repeticiones inteligentes (PROMPT 08): integridad del resultado, enlaces que respetan la privacidad y partidas
// ganadas, perdidas, tablas e interrumpidas. La repetición solo se lee: nada que envíe un cliente cambia una partida.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { LIMITS } from '../server/config.js';
import { startServer } from '../server/index.js';
import { SHARE_TOKEN, verifyGame } from '../server/replay.js';

LIMITS.guestsPerHour = 100_000;
const json = { 'Content-Type': 'application/json' };
let app;
let base;
before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0 });
  base = `http://127.0.0.1:${app.port}`;
});
after(() => app.close());

let n = 0;
const guest = async (name = 'Rep') => (await (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name: `${name}${++n}` }) })).json());
const call = async (g, method, p, body) => {
  const res = await fetch(`${base}${p}`, { method, headers: g ? { ...json, Authorization: `Bearer ${g.token}` } : json, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const fakeWs = () => ({ readyState: 1, sent: [], meta: {}, send(raw) { this.sent.push(JSON.parse(raw)); } });

// Juega una partida real en una sala y la deja guardada. `script`: jugadas UCI alternas; `finish(room, wa, wb)` cierra la partida.
function play(ua, ub, { rated = true, script = [], finish = null } = {}) {
  const room = app.rooms.create({ tcId: 'none', rated, colorPref: 'w' });
  const [wa, wb] = [fakeWs(), fakeWs()];
  room.seat({ ...ua, games: 0 }, wa);
  room.seat({ ...ub, games: 0 }, wb);
  script.forEach((uci, k) => room.move(k % 2 === 0 ? wa : wb, uci));
  finish?.(room, wa, wb);
  assert.equal(room.status, 'over');
  return room;
}
const MATE = ['f2f3', 'e7e5', 'g2g4', 'd8h4']; // mate del loco: ganan las negras
const own = async (g, room) => (await call(g, 'GET', `/api/games/${room.gameId}`)).json.game;

describe('verifyGame: el resultado guardado debe cuadrar con las jugadas', () => {
  const mate = { moves: MATE, winner: 'b', reason: 'jaque mate' };
  test('mate real verificado por las jugadas', () => {
    assert.deepEqual(verifyGame(mate), { legal: true, plies: 4, proof: 'moves', ok: true });
  });
  test('mate con el ganador cambiado, o sin mate en el tablero, NO se acepta', () => {
    assert.equal(verifyGame({ ...mate, winner: 'w' }).ok, false);
    assert.equal(verifyGame({ moves: MATE.slice(0, 3), winner: 'b', reason: 'jaque mate' }).ok, false);
    assert.equal(verifyGame({ ...mate, reason: 'rey ahogado', winner: null }).ok, false);
  });
  test('jugadas ilegales o mal formadas invalidan la partida', () => {
    assert.equal(verifyGame({ moves: ['e2e5'], winner: null, reason: 'abortada' }).legal, false);
    assert.equal(verifyGame({ moves: ['e2e4', 'e2e4'], winner: null, reason: 'abortada' }).legal, false);
    assert.equal(verifyGame({ moves: [42], winner: null, reason: 'abortada' }).ok, false);
    assert.equal(verifyGame({ moves: 'no es una lista', winner: null, reason: 'abortada' }).ok, false);
  });
  test('rendición, tiempo y desconexión los registra el servidor; abortada exige menos de 2 jugadas', () => {
    assert.deepEqual(verifyGame({ moves: ['e2e4', 'e7e5'], winner: 'w', reason: 'rendición' }), { legal: true, plies: 2, proof: 'server', ok: true });
    assert.equal(verifyGame({ moves: ['e2e4', 'e7e5'], winner: 'b', reason: 'tiempo' }).ok, true);
    assert.equal(verifyGame({ moves: ['e2e4', 'e7e5'], winner: 'w', reason: 'desconexión' }).ok, true);
    assert.equal(verifyGame({ moves: ['e2e4'], winner: null, reason: 'abortada' }).ok, true);
    assert.equal(verifyGame({ moves: ['e2e4', 'e7e5'], winner: null, reason: 'abortada' }).ok, false);
    assert.equal(verifyGame({ moves: ['e2e4'], winner: 'w', reason: 'rendición' }).ok, false, 'no se puede ganar por rendición sin partida');
    assert.equal(verifyGame({ moves: ['e2e4', 'e7e5'], winner: 'w', reason: 'tablas acordadas' }).ok, false, 'unas tablas no tienen ganador');
  });
  test('rey ahogado verificado', () => {
    const c = ['e2e3', 'a7a5', 'd1h5', 'a8a6', 'h5a5', 'h7h5', 'a5c7', 'a6h6', 'h2h4', 'f7f6', 'c7d7', 'e8f7', 'd7b7', 'd8d3', 'b7b8', 'd3h7', 'b8c8', 'f7g6', 'c8e6'];
    assert.deepEqual(verifyGame({ moves: c, winner: null, reason: 'rey ahogado' }), { legal: true, plies: 19, proof: 'moves', ok: true });
  });
});

describe('repetición de una partida: ganada, perdida, tablas e interrumpida', () => {
  test('ganada y perdida: cada jugador la ve desde su color y verificada', async () => {
    const a = await guest('Blanca');
    const b = await guest('Negra');
    const room = play(a.user, b.user, { script: MATE });
    const mine = await own(b, room);
    assert.equal(mine.you, 'b');
    assert.equal(mine.winner, 'b');
    assert.equal(mine.reason, 'jaque mate');
    assert.deepEqual(mine.moves, MATE);
    assert.deepEqual(mine.integrity, { ok: true, proof: 'moves' });
    assert.equal(mine.white.name, a.user.name);
    assert.equal(mine.black.name, b.user.name);
    const theirs = await own(a, room);
    assert.equal(theirs.you, 'w');
    assert.equal(theirs.winner, 'b', 'quien perdió ve el mismo resultado');
    assert.doesNotMatch(JSON.stringify(mine), /token|recovery|email|hash/i);
  });

  test('tablas acordadas: sin ganador y verificada por el servidor', async () => {
    const a = await guest('TablasA');
    const b = await guest('TablasB');
    const room = play(a.user, b.user, { script: ['e2e4', 'e7e5'], finish: (r, wa, wb) => { r.drawAction(wa, 'offer'); r.drawAction(wb, 'accept'); } });
    const g = await own(a, room);
    assert.equal(g.winner, null);
    assert.equal(g.reason, 'tablas acordadas');
    assert.deepEqual(g.integrity, { ok: true, proof: 'server' });
  });

  test('interrumpida por desconexión: queda registrada con ganador y las jugadas que hubo', async () => {
    const a = await guest('Cae');
    const b = await guest('Sigue');
    const room = play(a.user, b.user, { script: ['e2e4', 'e7e5', 'g1f3'], finish: (r) => r.end('b', 'desconexión') });
    const g = await own(b, room);
    assert.equal(g.reason, 'desconexión');
    assert.equal(g.winner, 'b');
    assert.equal(g.moves.length, 3);
    assert.equal(g.integrity.ok, true);
  });

  test('abortada sin jugadas no cuenta ni se publica, pero quien la jugó puede ver que existió', async () => {
    const a = await guest('Aborta');
    const b = await guest('Rival');
    const room = play(a.user, b.user, { script: [], finish: (r) => r.end(null, 'abortada') });
    assert.equal(room.gameId == null || room.result.reason === 'abortada', true);
    if (room.gameId) {
      const g = await own(a, room);
      assert.deepEqual(g.moves, []);
      assert.equal(g.integrity.ok, true);
      assert.equal((await call(null, 'GET', `/api/public/games/${room.gameId}`)).status, 404, 'una partida abortada nunca es pública');
    }
  });

  test('partida pública clasificatoria: la ve cualquiera, con nombres públicos, verificada y sin contexto de torneo', async () => {
    const a = await guest('PubA');
    const b = await guest('PubB');
    const room = play(a.user, b.user, { script: MATE });
    const res = await call(null, 'GET', `/api/public/games/${room.gameId}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.game.kind, 'ranked');
    assert.equal(res.json.game.tournament, null);
    assert.deepEqual(res.json.game.integrity, { ok: true, proof: 'moves' });
    assert.equal(res.json.game.you, 'w', 'quien mira ve desde las blancas');
    assert.equal(res.json.game.black.name, b.user.name);
  });

  test('partida de torneo: lleva el nombre del torneo, la ronda y si ganó el campeón', async () => {
    const a = await guest('CirA');
    const b = await guest('CirB');
    const room = app.rooms.create({ tcId: 'none', rated: false, colorPref: 'w', reserved: { w: a.user.id, b: b.user.id }, strict: true, circuit: { id: 'copa-ctx', round: 1, label: 'Final', tournament: 'Copa ctx' } });
    const [wa, wb] = [fakeWs(), fakeWs()];
    room.seat({ ...a.user, games: 0 }, wa);
    room.seat({ ...b.user, games: 0 }, wb);
    MATE.forEach((u, k) => room.move(k % 2 === 0 ? wa : wb, u));
    const raw = app.db.raw;
    const now = Date.now();
    raw.prepare(`INSERT INTO circuit_tournaments (id, format, name, tc, size, min_players, status, reg_opens_at, reg_closes_at, starts_at, created_at, champion_id, rounds) VALUES ('copa-ctx','blitz8','Copa ctx','blitz5',4,2,'finished',?,?,?,?,?,2)`).run(now, now, now, now, b.user.id);
    raw.prepare(`INSERT INTO circuit_matches (tournament_id, round, slot, a_id, b_id, status, winner_id, code, updated_at) VALUES ('copa-ctx',1,0,?,?,'done',?,?,?)`).run(a.user.id, b.user.id, b.user.id, room.code, now);
    const g = (await call(null, 'GET', `/api/public/games/${room.gameId}`)).json.game;
    assert.equal(g.kind, 'circuit');
    assert.equal(g.tournament.name, 'Copa ctx');
    assert.equal(g.tournament.roundLabel, 'Final');
    assert.equal(g.tournament.final, true);
    assert.equal(g.tournament.champion, true, 'ganó la final y es el campeón del torneo');
  });
});

describe('enlaces de repetición y privacidad', () => {
  test('una partida con amigos es privada: ni por id ni sin sesión; solo la ven quienes jugaron', async () => {
    const a = await guest('PrivA');
    const b = await guest('PrivB');
    const c = await guest('Curioso');
    const room = play(a.user, b.user, { rated: false, script: MATE });
    assert.equal((await call(null, 'GET', `/api/public/games/${room.gameId}`)).status, 404);
    assert.equal((await call(null, 'GET', `/api/games/${room.gameId}`)).status, 401);
    assert.equal((await call(c, 'GET', `/api/games/${room.gameId}`)).status, 404, 'ni siquiera sabe que existe');
    assert.equal((await call(a, 'GET', `/api/games/${room.gameId}`)).status, 200);
    const g = await own(a, room);
    assert.equal(g.public, false);
    assert.equal(g.share, null);
  });

  test('solo quien jugó crea el enlace; el token es aleatorio, estable y no revela la partida', async () => {
    const a = await guest('LinkA');
    const b = await guest('LinkB');
    const c = await guest('Ajeno');
    const room = play(a.user, b.user, { rated: false, script: MATE });
    assert.equal((await call(null, 'POST', `/api/games/${room.gameId}/share`, {})).status, 401);
    assert.equal((await call(c, 'POST', `/api/games/${room.gameId}/share`, {})).status, 404);
    const r = await call(a, 'POST', `/api/games/${room.gameId}/share`, {});
    assert.equal(r.status, 201);
    assert.match(r.json.token, SHARE_TOKEN);
    assert.ok(!r.json.token.includes(room.gameId));
    assert.equal(r.json.link, `/r/${r.json.token}`);
    const again = await call(b, 'POST', `/api/games/${room.gameId}/share`, {});
    assert.equal(again.json.token, r.json.token, 'un solo enlace por partida');
    assert.equal((await own(a, room)).share.token, r.json.token);

    const view = await call(null, 'GET', `/api/public/games/${r.json.token}`);
    assert.equal(view.status, 200, 'cualquiera con el enlace la ve, sin iniciar sesión');
    assert.equal(view.json.game.shared, true);
    assert.equal(view.json.game.id, r.json.token, 'el visor no recibe el id interno');
    assert.deepEqual(view.json.game.moves, MATE);
    assert.doesNotMatch(JSON.stringify(view.json), new RegExp(room.gameId));
    assert.doesNotMatch(JSON.stringify(view.json), /token"?:"[^r]|recovery|email|hash/i);
    assert.equal((await call(null, 'GET', `/api/public/games/${room.gameId}`)).status, 404, 'el id de la partida sigue sin ser público');
  });

  test('revocar apaga el enlace; un token inventado o mal formado no existe', async () => {
    const a = await guest('RevA');
    const b = await guest('RevB');
    const room = play(a.user, b.user, { rated: false, script: MATE });
    const { token } = (await call(a, 'POST', `/api/games/${room.gameId}/share`, {})).json;
    assert.equal((await call(b, 'DELETE', `/api/games/${room.gameId}/share`)).json.removed, true, 'el otro jugador también puede revocarlo');
    assert.equal((await call(null, 'GET', `/api/public/games/${token}`)).status, 404);
    assert.equal((await call(null, 'GET', '/api/public/games/rsAAAAAAAAAAAAAAAAAAAA')).status, 404);
    assert.notEqual((await call(null, 'GET', '/api/public/games/rs')).status, 200);
    assert.notEqual((await call(null, 'GET', '/api/public/games/rs..%2F..%2Fetc')).status, 200);
  });

  test('una partida pública se comparte por /r/ID sin crear enlaces', async () => {
    const a = await guest('Pub2A');
    const b = await guest('Pub2B');
    const room = play(a.user, b.user, { script: MATE });
    assert.equal((await own(a, room)).public, true);
  });

  test('si uno de los jugadores pone el perfil privado, la partida pública deja de verse por id', async () => {
    const a = await guest('Priva');
    const b = await guest('Abierto');
    const room = play(a.user, b.user, { script: MATE });
    assert.equal((await call(null, 'GET', `/api/public/games/${room.gameId}`)).status, 200);
    assert.equal((await call(a, 'PATCH', '/api/me/privacy', { profile: 'private' })).status, 200);
    assert.equal((await call(null, 'GET', `/api/public/games/${room.gameId}`)).status, 404);
    assert.equal((await own(a, room)).public, false, 'y el propio jugador ya no la ve como pública');
  });
});

describe('integridad: nadie puede falsificar una repetición', () => {
  test('no existe ninguna ruta para modificar jugadas ni resultado; los cuerpos enviados se ignoran', async () => {
    const a = await guest('Fal');
    const b = await guest('Sif');
    const room = play(a.user, b.user, { script: MATE });
    const before = await own(a, room);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await call(a, method, `/api/games/${room.gameId}`, { winner: 'w' })).status, 405, `${method} no está permitido`);
    assert.equal((await call(a, 'POST', `/api/games/${room.gameId}`, { winner: 'w', moves: [] })).status, 405);
    await call(a, 'POST', `/api/games/${room.gameId}/share`, { winner: 'w', reason: 'jaque mate', moves: ['e2e4'] });
    const after = await own(a, room);
    assert.deepEqual({ ...after, share: null }, { ...before, share: null }, 'la partida no cambió');
    assert.equal(after.winner, 'b');
    assert.deepEqual(after.moves, MATE);
  });

  test('un parámetro ?m= solo es una posición de partida en el visor: el servidor no lo usa', async () => {
    const a = await guest('Pos');
    const b = await guest('Pos2');
    const room = play(a.user, b.user, { script: MATE });
    const plain = (await call(null, 'GET', `/api/public/games/${room.gameId}`)).json;
    const withM = (await call(null, 'GET', `/api/public/games/${room.gameId}?m=2&winner=w`)).json;
    assert.deepEqual(withM, plain);
  });

  test('si una partida guardada no cuadra (resultado o jugadas manipuladas en la base de datos), se marca sin verificar', async () => {
    const a = await guest('Man');
    const b = await guest('Ipu');
    const room = play(a.user, b.user, { script: MATE });
    app.db.raw.prepare('UPDATE games SET winner = ? WHERE id = ?').run('w', room.gameId);
    assert.equal((await own(a, room)).integrity.ok, false, 'el mate lo dieron las negras');
    app.db.raw.prepare('UPDATE games SET winner = ?, moves = ? WHERE id = ?').run('b', JSON.stringify(['e2e5']), room.gameId);
    assert.equal((await own(a, room)).integrity.ok, false, 'jugada ilegal');
  });

  test('los enlaces de repetición están limitados', async () => {
    const a = await guest('Spam');
    const b = await guest('Spam2');
    const room = play(a.user, b.user, { rated: false, script: MATE });
    let last = 0;
    for (let i = 0; i < 25; i += 1) last = (await call(a, 'POST', `/api/games/${room.gameId}/share`, {})).status;
    assert.equal(last, 429);
  });
});
