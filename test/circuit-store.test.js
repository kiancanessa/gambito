// Persistencia del Circuit: inscripciones únicas, plazos, cupos y avance atómico sin resultados duplicados.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { openDb } from '../server/db.js';

let db;
let store;
let n = 0;
const NOW = 1_000_000;

const user = (name, rating = 1000) => ({ id: `u-${name}`, name, rating });
const tournament = (over = {}) => {
  const t = { id: `t-${++n}`, format: 'f', name: 'Torneo de prueba', tc: 'blitz3_2', size: 4, minPlayers: 2, status: 'open', regOpensAt: NOW - 1000, regClosesAt: NOW + 5000, startsAt: NOW + 6000, createdAt: NOW - 1000, ...over };
  store.create(t);
  return t;
};
const join = (t, names) => names.map((x) => store.register(t.id, user(x), NOW));

// Deja un torneo de 4 jugadores en marcha: cuadro de 2 + 1 con los jugadores a, b, c, d (seeds 1-4).
function running() {
  const t = tournament();
  join(t, ['a', 'b', 'c', 'd']);
  assert.ok(store.update(t.id, { status: 'closed' }, ['open']));
  const matches = [
    { round: 0, slot: 0, aId: 'u-a', bId: 'u-d', status: 'ready' },
    { round: 0, slot: 1, aId: 'u-b', bId: 'u-c', status: 'ready' },
    { round: 1, slot: 0, aId: null, bId: null, status: 'pending' },
  ];
  const res = store.start({ tid: t.id, absent: [], seeds: ['a', 'b', 'c', 'd'].map((x, i) => ({ id: `u-${x}`, seed: i + 1 })), matches, rounds: 2, now: NOW });
  assert.equal(res.ok, true);
  return t;
}
const done = (t, round, slot, w, l, next) => store.completeMatch({ tid: t.id, round, slot, winnerId: `u-${w}`, loserId: `u-${l}`, reason: 'mate', placement: round === 0 ? 'semi' : 'final', next, now: NOW + 10 });

beforeEach(() => {
  db?.close();
  db = openDb(':memory:');
  store = db.circuit;
});

describe('inscripción', () => {
  test('una plaza por usuario y torneo', () => {
    const t = tournament();
    assert.equal(store.register(t.id, user('a'), NOW).ok, true);
    assert.deepEqual(store.register(t.id, user('a'), NOW), { ok: false, reason: 'already' });
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM circuit_entries WHERE tournament_id = ?').get(t.id).n, 1);
  });

  test('un usuario solo puede estar en un torneo vivo a la vez, pero puede apuntarse a otro cuando el primero termina', () => {
    const t1 = tournament();
    const t2 = tournament();
    assert.equal(store.register(t1.id, user('a'), NOW).ok, true);
    assert.deepEqual(store.register(t2.id, user('a'), NOW), { ok: false, reason: 'busy' });
    store.cancel(t1.id, 'prueba', NOW);
    assert.equal(store.register(t2.id, user('a'), NOW).ok, true);
  });

  test('respeta el cupo, el estado y el plazo (ni un milisegundo fuera de tiempo)', () => {
    const t = tournament({ size: 2, regClosesAt: NOW + 1000 });
    assert.equal(store.register(t.id, user('a'), NOW).ok, true);
    assert.equal(store.register(t.id, user('b'), NOW + 999).ok, true);
    assert.deepEqual(store.register(t.id, user('c'), NOW), { ok: false, reason: 'full' });
    const late = tournament({ regClosesAt: NOW + 1000 });
    assert.deepEqual(store.register(late.id, user('z'), NOW + 1000), { ok: false, reason: 'closed' }, 'en el instante de cierre ya no se admite');
    const scheduled = tournament({ status: 'scheduled' });
    assert.deepEqual(store.register(scheduled.id, user('y'), NOW), { ok: false, reason: 'closed' }, 'no se admite antes de abrir');
    assert.deepEqual(store.register('no-existe', user('x'), NOW), { ok: false, reason: 'unknown' });
  });

  test('cancelar la inscripción solo es posible mientras está abierta', () => {
    const t = tournament({ regClosesAt: NOW + 1000 });
    store.register(t.id, user('a'), NOW);
    assert.deepEqual(store.withdraw(t.id, 'u-nadie', NOW), { ok: false, reason: 'notin' });
    assert.deepEqual(store.withdraw(t.id, 'u-a', NOW + 1000), { ok: false, reason: 'closed' }, 'fuera de plazo no se puede salir');
    assert.equal(store.withdraw(t.id, 'u-a', NOW).ok, true);
    assert.equal(store.register(t.id, user('a'), NOW).ok, true, 'puede volver a inscribirse');
  });

  test('100 intentos de inscribir al mismo usuario dejan una sola fila', () => {
    const t = tournament({ size: 8 });
    for (let i = 0; i < 100; i += 1) store.register(t.id, user('spam'), NOW);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM circuit_entries WHERE tournament_id = ?').get(t.id).n, 1);
  });
});

describe('avance atómico', () => {
  test('cerrar el mismo partido dos veces solo avanza una vez al ganador', () => {
    const t = running();
    const next = { round: 1, slot: 0, side: 'a' };
    assert.deepEqual(done(t, 0, 0, 'a', 'd', next), { ok: true, ready: false });
    assert.deepEqual(done(t, 0, 0, 'a', 'd', next), { ok: false, reason: 'dup' });
    // un segundo proceso que cree que ganó el otro tampoco puede darle la vuelta al resultado
    assert.deepEqual(done(t, 0, 0, 'd', 'a', next), { ok: false, reason: 'dup' });
    const final = db.raw.prepare('SELECT a_id, b_id FROM circuit_matches WHERE tournament_id = ? AND round = 1').get(t.id);
    assert.deepEqual({ ...final }, { a_id: 'u-a', b_id: null });
    assert.equal(db.raw.prepare("SELECT status FROM circuit_entries WHERE tournament_id = ? AND user_id = 'u-d'").get(t.id).status, 'out');
  });

  test('un resultado con jugadores ajenos al partido se rechaza y no cambia nada', () => {
    const t = running();
    const next = { round: 1, slot: 0, side: 'a' };
    assert.deepEqual(done(t, 0, 0, 'b', 'c', next), { ok: false, reason: 'dup' }, 'b y c juegan en otro partido');
    assert.deepEqual(done(t, 0, 0, 'a', 'a', next), { ok: false, reason: 'dup' });
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM circuit_entries WHERE tournament_id = ? AND status = 'out'").get(t.id).n, 0);
    assert.equal(db.raw.prepare("SELECT status FROM circuit_matches WHERE tournament_id = ? AND round = 0 AND slot = 0").get(t.id).status, 'ready');
  });

  test('la transacción se deshace entera si la plaza siguiente ya estaba ocupada', () => {
    const t = running();
    db.raw.prepare("UPDATE circuit_matches SET a_id = 'u-intruso' WHERE tournament_id = ? AND round = 1").run(t.id);
    assert.throws(() => done(t, 0, 0, 'a', 'd', { round: 1, slot: 0, side: 'a' }));
    assert.equal(db.raw.prepare("SELECT status FROM circuit_matches WHERE tournament_id = ? AND round = 0 AND slot = 0").get(t.id).status, 'ready', 'el partido sigue abierto');
    assert.equal(db.raw.prepare("SELECT status FROM circuit_entries WHERE tournament_id = ? AND user_id = 'u-d'").get(t.id).status, 'active', 'el perdedor no quedó eliminado a medias');
  });

  test('la final se activa cuando llegan los dos finalistas y el torneo termina una sola vez con un único campeón', () => {
    const t = running();
    assert.deepEqual(done(t, 0, 0, 'a', 'd', { round: 1, slot: 0, side: 'a' }), { ok: true, ready: false });
    assert.deepEqual(done(t, 0, 1, 'b', 'c', { round: 1, slot: 0, side: 'b' }), { ok: true, ready: true });
    assert.deepEqual(done(t, 1, 0, 'a', 'b', null), { ok: true, ready: false });
    const results = [
      { userId: 'u-a', placement: 'champion', coins: 250, xp: 250, item: 'set:royal' },
      { userId: 'u-b', placement: 'final', coins: 120, xp: 120 },
    ];
    for (const x of ['a', 'b']) db.createUser({ id: `u-${x}`, name: x, tokenHash: `h-${x}`, recoveryHash: null }); // los premios referencian a la cuenta real
    const legacy = { tc: t.tc, size: 4, champion: 'a', bracket: '[]', createdAt: NOW };
    assert.equal(store.finish({ tid: t.id, championId: 'u-a', now: NOW + 20, legacy, results }).ok, true);
    assert.deepEqual(store.finish({ tid: t.id, championId: 'u-b', now: NOW + 30, legacy, results }), { ok: false, reason: 'state' }, 'no se corona dos veces');
    const row = store.load(t.id);
    assert.equal(row.status, 'finished');
    assert.equal(row.champion_id, 'u-a');
    assert.equal(row.entries.filter((e) => e.status === 'champion').length, 1);
    // historial heredado y premios: una fila por jugador y torneo
    assert.equal(db.tournamentResult(t.id, 'u-a').coins, 250);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM tournament_results WHERE tournament_id = ?').get(t.id).n, 2);
    assert.equal(db.recentChampions(1)[0].name, 'a');
    assert.equal(store.recent(5)[0].champion_name, 'a');
  });

  test('un torneo terminado o cancelado no vuelve a cambiar de estado', () => {
    const t = tournament();
    assert.equal(store.cancel(t.id, 'pocos jugadores', NOW), true);
    assert.equal(store.cancel(t.id, 'otra vez', NOW), false);
    assert.equal(store.update(t.id, { status: 'open' }, ['scheduled']), false);
    assert.equal(store.load(t.id).cancel_reason, 'pocos jugadores');
    const r = running();
    assert.equal(store.cancel(r.id, 'tarde', NOW), false, 'uno en curso ya no se cancela');
    assert.deepEqual(store.start({ tid: r.id, absent: [], seeds: [], matches: [], rounds: 2, now: NOW }), { ok: false, reason: 'state' }, 'no se arranca dos veces');
  });
});

describe('persistencia por ronda', () => {
  test('cada ronda queda escrita y se recupera tal cual con el torneo en curso', () => {
    const t = running();
    done(t, 0, 0, 'a', 'd', { round: 1, slot: 0, side: 'a' });
    store.setMatch(t.id, 0, 1, { status: 'playing', code: 'ABC123', draws: 1 }, NOW + 5);
    const [live] = store.loadLive();
    assert.equal(live.id, t.id);
    assert.equal(live.status, 'running');
    assert.equal(live.entries.length, 4);
    const m = live.matches.map((x) => `${x.round}-${x.slot}:${x.status}`);
    assert.deepEqual(m, ['0-0:done', '0-1:playing', '1-0:pending']);
    assert.equal(live.matches[1].code, 'ABC123');
    assert.equal(live.matches[1].draws, 1);
    assert.equal(live.matches[0].winner_id, 'u-a');
  });

  test('un partido ya cerrado no admite cambios de estado', () => {
    const t = running();
    done(t, 0, 0, 'a', 'd', { round: 1, slot: 0, side: 'a' });
    assert.equal(store.setMatch(t.id, 0, 0, { status: 'ready' }, NOW + 50), false);
    assert.equal(db.raw.prepare('SELECT status FROM circuit_matches WHERE tournament_id = ? AND round = 0 AND slot = 0').get(t.id).status, 'done');
  });

  test('update solo acepta campos de la lista blanca', () => {
    const t = tournament();
    assert.throws(() => store.update(t.id, { champion_id: 'x', size: 99 }), /no permitido/);
    assert.throws(() => store.update(t.id, {}), /no permitido/);
  });
});
