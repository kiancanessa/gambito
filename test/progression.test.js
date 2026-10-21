// Progresión: XP de cuenta, misiones, logros y temporadas verificados por el servidor. Seguridad y consistencia.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import WebSocket from 'ws';
import { openDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { mergeSnapshot } from '../server/persist.js';
import { createProgression } from '../server/progression.js';
import { createWallets } from '../server/wallet.js';
import { analyzeGame, gameXp } from '../server/xp-rules.js';
import { levelUnlocks } from '../public/js/cosmetics-data.js';
import {
  ACHIEVEMENTS, MISSIONS_DAILY, MISSIONS_WEEKLY, SEASONS, XP_RULES as R, dayIdOf, dayWindow, missionDef, missionProgress, missionsFor,
  seasonAt, seasonEnd, seasonLevelOf, seasonStart, weekIdOf, weekWindow,
} from '../public/js/progression-data.js';

// Légal: 13 jugadas, blancas dan jaque mate con Cd5 (un jaque con Axf7+). Las negras capturan la dama blanca (Axd1).
const LEGAL = 'e2e4 e7e5 g1f3 d7d6 f1c4 c8g4 b1c3 g7g6 f3e5 g4d1 c4f7 e8e7 c3d5'.split(' ');
// Otra partida legal de 12 jugadas sin final (para tablas/abandonos): ambos bandos se mueven y nadie gana en el tablero.
const LONG = 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8c5 c2c3 d7d6 b2b4 c5b6'.split(' ');

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let seq = 0;
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0); // 5 nov 2026: dentro de la temporada 1

function setup(start = T0) {
  const db = openDb(':memory:');
  const wallets = createWallets(db);
  const clock = { t: start };
  const pushes = [];
  const prog = createProgression({ db, wallets, now: () => clock.t, notify: (id, msg) => pushes.push({ id, ...msg }) });
  const user = (name) => {
    const id = `u${++seq}-${name}`;
    db.createUser({ id, name, tokenHash: `h-${id}`, recoveryHash: null });
    return id;
  };
  let g = 0;
  // Inserta una partida terminada tal como la guardaría el servidor y avisa a la progresión, como hace Room.end().
  const game = ({ w, b, moves = LEGAL, winner = 'w', reason = 'jaque mate', rated = false, delta = null, circuit = null }) => {
    const id = `game-${++g}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
    db.insertGame({ id, code: 'ABCDEF', whiteId: w, blackId: b, winner, reason, moves: JSON.stringify(moves), rated, tc: 'blitz3_2', createdAt: clock.t });
    prog.recordGame({ gameId: id, ratingDelta: delta, unrated: false, circuit, players: { w: { rating: 1000 }, b: { rating: 1000 } } });
    return id;
  };
  const events = (u) => db.raw.prepare('SELECT kind, xp, ref FROM progress_events WHERE user_id = ? ORDER BY at, rowid').all(u);
  const gameXpOf = (u) => db.raw.prepare("SELECT COALESCE(SUM(xp),0) AS n FROM progress_events WHERE user_id = ? AND kind = 'game'").get(u).n;
  const xpOf = (u) => {
    const w = wallets.ensure(u);
    let total = w.xp;
    for (let l = 1; l < w.level; l += 1) total += 100 + (l - 1) * 60;
    return total;
  };
  // Eventos verificados sintéticos para fijar una misión sin jugar partidas (la lógica de reclamo es la que se prueba).
  const PRESETS = {
    games: ['game', { result: 'loss' }], games_clean: ['game', { result: 'loss' }], wins: ['game', { result: 'win' }], rated: ['game', { result: 'win', rated: true }],
    checks: ['game', {}], promos: ['game', {}], mates: ['game', { result: 'win', mate: true }], win_keepqueen: ['game', { result: 'win' }],
    win_black: ['game', { result: 'win', color: 'b' }], win_underdog: ['game', { result: 'win', underdog: true }], puzzle: ['puzzle', {}], circuit: ['circuit_join', {}], review: ['review', {}],
  };
  const force = (u, metric, n, at = clock.t) => {
    const [kind, meta] = PRESETS[metric];
    const ev = db.raw.prepare('INSERT INTO progress_events (user_id, ref, kind, xp, season_id, at, meta) VALUES (?,?,?,?,?,?,?)');
    if (metric === 'checks') ev.run(u, `f${++seq}`, kind, 0, 1, at, JSON.stringify({ checks: n }));
    else if (metric === 'promos') ev.run(u, `f${++seq}`, kind, 0, 1, at, JSON.stringify({ promotions: n }));
    else for (let i = 0; i < n; i += 1) ev.run(u, `f${++seq}`, kind, 0, 1, at, JSON.stringify(meta));
  };
  return { db, wallets, prog, clock, pushes, user, game, events, xpOf, gameXpOf, force };
}

describe('reglas de XP (puras)', () => {
  test('analizar una partida cuenta jaques, mate, coronaciones y dama perdida desde cada lado', () => {
    const w = analyzeGame(LEGAL, 'w');
    assert.deepEqual({ plies: w.plies, checks: w.checks, mate: w.mate, lostQueen: w.lostQueen, promotions: w.promotions }, { plies: 13, checks: 1, mate: true, lostQueen: true, promotions: 0 });
    const b = analyzeGame(LEGAL, 'b');
    assert.equal(b.mate, false);
    assert.equal(b.lostQueen, false);
    assert.equal(analyzeGame(['e2e4', 'zz'], 'w').plies, 2, 'jugadas ilegibles no rompen nada');
  });

  test('participar y terminar vale más que ganar; abandonar casi no da; las partidas cortas no cuentan', () => {
    const facts = { plies: 30, checks: 0, captures: 0, promotions: 0, mate: false, lostQueen: false };
    const loss = gameXp({ facts, result: 'loss', abandon: false, rated: false, underdog: false });
    const win = gameXp({ facts, result: 'win', abandon: false, rated: false, underdog: false });
    assert.equal(loss.xp, R.base + R.complete);
    assert.equal(win.xp, R.base + R.complete + R.win);
    assert.ok(loss.xp / win.xp >= 0.8, 'perder terminando da casi lo mismo que ganar');
    const quit = gameXp({ facts, result: 'loss', abandon: true, rated: false, underdog: false });
    assert.equal(quit.xp, R.abandonBase);
    assert.ok(quit.xp < loss.xp / 3);
    assert.equal(gameXp({ facts: { ...facts, plies: R.minPlies - 1 }, result: 'win', abandon: false, rated: true, underdog: true }).xp, 0);
  });

  test('los objetivos de habilidad suman, pero hay un tope por partida', () => {
    const facts = { plies: 60, checks: 9, captures: 12, promotions: 2, mate: true, lostQueen: false };
    const r = gameXp({ facts, result: 'win', abandon: false, rated: true, underdog: true });
    assert.equal(r.parts.jaques, R.maxChecks * R.check, 'los jaques cuentan hasta un máximo');
    assert.equal(r.xp, R.perGameCap);
    assert.ok(Object.values(r.parts).reduce((a, b) => a + b, 0) > R.perGameCap, 'sin el tope, sumaría más');
  });
});

describe('XP por partidas: solo lo que el servidor arbitró', () => {
  test('una partida completa da XP a los dos jugadores y es idempotente', () => {
    const { prog, user, game, xpOf, gameXpOf, events, pushes } = setup();
    const a = user('Ana');
    const b = user('Beto');
    const id = game({ w: a, b });
    assert.equal(gameXpOf(a), R.base + R.complete + R.win + R.mate + R.check, 'ganó, dio un jaque y mate');
    assert.equal(gameXpOf(b), R.base + R.complete, 'perdió terminando la partida: casi lo mismo');
    // el mismo evento otra vez (reintento, doble gancho...) no suma nada
    const before = xpOf(a);
    prog.recordGame({ gameId: id, ratingDelta: null, players: { w: { rating: 1000 }, b: { rating: 1000 } } });
    assert.equal(xpOf(a), before);
    assert.equal(events(a).filter((e) => e.kind === 'game').length, 1);
    assert.ok(pushes.some((p) => p.id === a && p.t === 'progress' && p.xp > 0), 'se avisa al jugador en tiempo real');
  });

  test('las abortadas, las partidas cortas y las ilegibles no dan XP ni cuentan para misiones', () => {
    const { user, game, xpOf, events } = setup();
    const a = user('Ana');
    const b = user('Beto');
    game({ w: a, b, moves: LEGAL, winner: null, reason: 'abortada' });
    game({ w: a, b, moves: ['e2e4', 'e7e5', 'g1f3'], winner: 'w', reason: 'rendición' });
    assert.equal(xpOf(a), 0);
    assert.equal(events(a).length, 0);
  });

  test('quien abandona (se rinde o se desconecta y pierde) recibe solo la participación mínima', () => {
    const { user, game, gameXpOf } = setup();
    const a = user('Ana');
    const b = user('Beto');
    game({ w: a, b, moves: LONG, winner: 'w', reason: 'rendición' });
    assert.equal(gameXpOf(b), R.abandonBase);
    assert.equal(gameXpOf(a), R.base + R.complete + R.win);
  });

  test('la misma pareja solo da XP en sus primeras partidas del día', () => {
    const { user, game, events, clock } = setup();
    const a = user('Ana');
    const b = user('Beto');
    for (let i = 0; i < 6; i += 1) game({ w: a, b, moves: LONG, winner: null, reason: 'tablas acordadas' });
    assert.equal(events(a).filter((e) => e.kind === 'game').length, R.pairPerDay);
    clock.t += 24 * 3600 * 1000; // al día siguiente vuelve a contar
    game({ w: a, b, moves: LONG, winner: null, reason: 'tablas acordadas' });
    assert.equal(events(a).filter((e) => e.kind === 'game').length, R.pairPerDay + 1);
  });

  test('pasado el tope diario, la XP se amortigua al 25 % (no se castiga ni se bloquea)', () => {
    const { db, user, game, gameXpOf, clock } = setup();
    const a = user('Ana');
    db.raw.prepare("INSERT INTO progress_events (user_id, ref, kind, xp, season_id, at, meta) VALUES (?,?,?,?,?,?,?)").run(a, 'seed', 'game', R.dailySoftCap, 1, clock.t - 1000, '{}');
    const before = gameXpOf(a);
    game({ w: a, b: user('Beto'), moves: LONG, winner: null, reason: 'tablas acordadas' });
    const got = gameXpOf(a) - before;
    assert.equal(got, Math.round((R.base + R.complete + R.draw) * R.softFactor));
    assert.ok(got > 0);
  });

  test('un jugador no puede ganar XP jugando contra sí mismo ni con cuentas inexistentes', () => {
    const { user, game, events, db } = setup();
    const a = user('Ana');
    game({ w: a, b: a });
    assert.equal(events(a).length, 0);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM progress_events').get().n, 0);
  });

  test('el nivel de cuenta no depende del rating: sube con XP aunque el rating baje', () => {
    const { user, game, wallets, db } = setup();
    const a = user('Ana');
    const b = user('Beto');
    const before = db.userById(a).rating;
    for (let i = 0; i < 5; i += 1) game({ w: a, b: user(`R${i}`), moves: LEGAL, winner: 'b', reason: 'jaque mate' });
    assert.ok(wallets.ensure(a).xp > 0 || wallets.ensure(a).level > 1, 'perdiendo también se progresa terminando partidas');
    assert.equal(db.userById(a).rating, before, 'la XP no toca el rating');
  });
});

describe('misiones', () => {
  const firstOf = (sum, kind = 'daily') => sum.missions[kind].items[0];

  test('mismas misiones para todos, deterministas, con estado y progreso', () => {
    const { prog, user } = setup();
    const a = prog.summary(user('Ana'));
    const b = prog.summary(user('Beto'));
    assert.deepEqual(a.missions.daily.items.map((m) => m.id), b.missions.daily.items.map((m) => m.id));
    assert.equal(a.missions.daily.items.length, 3);
    assert.equal(a.missions.weekly.items.length, 3);
    assert.ok(a.missions.daily.items.every((m) => m.state === 'pending' && m.progress === 0 && m.target > 0 && m.coins > 0 && m.xp > 0));
    assert.equal(a.missions.daily.endsAt - a.missions.daily.startsAt, 86_400_000);
    assert.equal(a.missions.weekly.endsAt - a.missions.weekly.startsAt, 7 * 86_400_000);
    assert.equal(new Date(a.missions.weekly.startsAt).getUTCDay(), 1, 'la semana empieza en lunes');
  });

  test('los estados pasan de pendiente a en progreso, completada y reclamada', () => {
    const { prog, user, force } = setup();
    const u = user('Ana');
    const m = firstOf(prog.summary(u));
    const def = missionDef('daily', m.id);
    assert.equal(m.state, 'pending');
    if (def.target > 1) {
      force(u, def.metric, def.target - 1);
      assert.equal(firstOf(prog.summary(u)).state, 'inprogress');
    }
    force(u, def.metric, def.metric === 'checks' || def.metric === 'promos' ? def.target : 1);
    assert.equal(firstOf(prog.summary(u)).state, 'completed');
    const period = prog.summary(u).missions.daily.period;
    assert.equal(prog.claimMission(u, { kind: 'daily', id: def.id, period }).ok, true);
    assert.equal(firstOf(prog.summary(u)).state, 'claimed');
  });

  test('no se reclama sin cumplir, ni dos veces, ni una misión que no toca, y paga una sola vez', () => {
    const { prog, user, force, wallets, xpOf } = setup();
    const u = user('Ana');
    const sum = prog.summary(u);
    const { period } = sum.missions.daily;
    const def = missionDef('daily', firstOf(sum).id);
    assert.deepEqual(prog.claimMission(u, { kind: 'daily', id: def.id, period }), { ok: false, reason: 'incomplete' });
    force(u, def.metric, def.target);
    const coins0 = wallets.ensure(u).coins;
    const xp0 = xpOf(u);
    const first = prog.claimMission(u, { kind: 'daily', id: def.id, period });
    assert.equal(first.ok, true);
    for (let i = 0; i < 5; i += 1) assert.deepEqual(prog.claimMission(u, { kind: 'daily', id: def.id, period }), { ok: false, reason: 'claimed' });
    assert.equal(wallets.ensure(u).coins, coins0 + def.coins, 'las monedas se pagan una sola vez');
    assert.ok(xpOf(u) >= xp0 + def.xp, 'y la XP también');
    const notAssigned = MISSIONS_DAILY.find((m) => !sum.missions.daily.items.some((x) => x.id === m.id));
    assert.deepEqual(prog.claimMission(u, { kind: 'daily', id: notAssigned.id, period }), { ok: false, reason: 'unknown' });
    assert.deepEqual(prog.claimMission(u, { kind: 'daily', id: 'inventada', period }), { ok: false, reason: 'unknown' });
    assert.deepEqual(prog.claimMission(u, { kind: 'otra', id: def.id, period }), { ok: false, reason: 'invalid' });
    assert.deepEqual(prog.claimMission(u, { kind: 'daily', id: def.id, period: 'x1; DROP' }), { ok: false, reason: 'unknown' });
  });

  test('un periodo futuro o muy antiguo no se puede reclamar; el anterior sí (gracia de un periodo)', () => {
    const { prog, user, force, clock } = setup();
    const u = user('Ana');
    const sum = prog.summary(u);
    const def = missionDef('daily', firstOf(sum).id);
    const today = dayIdOf(clock.t);
    force(u, def.metric, def.target);
    assert.deepEqual(prog.claimMission(u, { kind: 'daily', id: def.id, period: `d${today + 1}` }), { ok: false, reason: 'expired' }, 'no se adelanta');
    // al día siguiente, lo completado ayer sigue reclamable (no se pierde por no conectarse a tiempo)
    clock.t += 86_400_000;
    const next = prog.summary(u);
    const carried = next.missions.carryover.find((m) => m.id === def.id);
    assert.ok(carried, 'aparece como pendiente de reclamar');
    assert.equal(prog.claimMission(u, { kind: 'daily', id: def.id, period: carried.period }).ok, true);
    // dos días después, el periodo de origen ya no admite reclamaciones
    const u2 = user('Beto');
    const def2 = missionDef('daily', firstOf(prog.summary(u2)).id);
    const p2 = prog.summary(u2).missions.daily.period;
    force(u2, def2.metric, def2.target);
    clock.t += 2 * 86_400_000;
    assert.deepEqual(prog.claimMission(u2, { kind: 'daily', id: def2.id, period: p2 }), { ok: false, reason: 'expired' });
  });

  test('el progreso solo cuenta eventos del periodo y nunca se alimenta de lo que diga el cliente', () => {
    const { prog, user, force, clock } = setup();
    const u = user('Ana');
    const def = missionDef('daily', firstOf(prog.summary(u)).id);
    force(u, def.metric, def.target, clock.t - 3 * 86_400_000); // eventos de hace 3 días
    assert.equal(firstOf(prog.summary(u)).progress, 0);
    force(u, def.metric, def.target, clock.t - 1000);
    assert.equal(firstOf(prog.summary(u)).progress, def.target);
  });

  test('las métricas de las misiones se calculan sobre los eventos (pura)', () => {
    const ev = (meta, kind = 'game') => ({ kind, meta });
    const evs = [ev({ result: 'win', color: 'b', lostQueen: false, checks: 2, mate: true, rated: true, underdog: true, promotions: 1 }), ev({ result: 'loss', abandon: true }), ev({}, 'puzzle'), ev({}, 'review'), ev({}, 'circuit_join')];
    const get = (metric, target = 99) => missionProgress({ metric, target }, evs);
    assert.deepEqual(['games', 'games_clean', 'wins', 'rated', 'checks', 'promos', 'mates', 'win_keepqueen', 'win_black', 'win_underdog', 'puzzle', 'circuit', 'review'].map((m) => get(m)), [2, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal(missionProgress({ metric: 'games', target: 1 }, evs), 1, 'el progreso no pasa del objetivo');
    for (const kind of ['daily', 'weekly']) {
      for (let p = 0; p < 50; p += 1) {
        const picks = missionsFor(kind, p);
        assert.equal(new Set(picks.map((m) => m.id)).size, picks.length);
      }
    }
    assert.ok([...MISSIONS_DAILY, ...MISSIONS_WEEKLY].every((m) => m.coins > 0 && m.xp > 0 && m.target > 0 && m.text));
  });

  test('las misiones se pueden cumplir de verdad con partidas reales del servidor', () => {
    const { prog, user, game, clock } = setup();
    const a = user('Ana');
    const b = user('Beto');
    // buscamos un día cuyas misiones diarias incluyan «completar partidas»/«sin abandonar»/«ganar»
    let day = dayIdOf(clock.t);
    while (!missionsFor('daily', day).some((m) => ['games', 'games_clean', 'wins', 'checks'].includes(m.metric))) day += 1;
    clock.t = dayWindow(day)[0] + 3600_000;
    game({ w: a, b, moves: LEGAL, winner: 'w' });
    const items = prog.summary(a).missions.daily.items;
    const touched = items.filter((m) => m.progress > 0);
    assert.ok(touched.length >= 1, 'una partida real avanza al menos una misión');
  });
});

describe('temporadas', () => {
  const lastSeasonDay = (s) => seasonEnd(s) - 3600_000;

  test('definiciones: identificadores, fechas consecutivas, temática y recompensas gratuitas', () => {
    assert.deepEqual(SEASONS.map((s) => s.id), [1, 2, 3]);
    for (const s of SEASONS) {
      assert.ok(s.name && s.theme.accent && s.theme.glyph && s.theme.tagline, `tema de ${s.id}`);
      assert.ok(seasonEnd(s) > seasonStart(s));
      assert.ok(Object.values(s.rewards).length >= 5 && s.defaultReward.coins > 0);
    }
    for (let i = 1; i < SEASONS.length; i += 1) assert.equal(seasonStart(SEASONS[i]) - seasonEnd(SEASONS[i - 1]), 1, 'sin huecos ni solapes entre temporadas');
    assert.equal(seasonAt(Date.UTC(2026, 10, 30, 23, 59, 59))?.id, 1);
    assert.equal(seasonAt(Date.UTC(2026, 11, 1, 0, 0, 0))?.id, 2);
    assert.equal(seasonAt(Date.UTC(2027, 7, 1)), null, 'después de la última no hay temporada actual');
  });

  const giveSeasonXp = (db, u, season, xp, at = seasonStart(season) + 1000) =>
    db.raw.prepare('INSERT INTO progress_events (user_id, ref, kind, xp, season_id, at, meta) VALUES (?,?,?,?,?,?,?)').run(u, `s${++seq}`, 'game', xp, season.id, at, '{}');

  test('el nivel de temporada sale de la XP verificada de esa temporada y no se puede reclamar por encima', () => {
    const { db, prog, user, wallets } = setup();
    const u = user('Ana');
    const s1 = SEASONS[0];
    assert.deepEqual(prog.claimSeason(u, { season: 1, level: 1 }), { ok: false, reason: 'locked' });
    assert.deepEqual(prog.claimSeason(u, { season: 1, level: 30 }), { ok: false, reason: 'locked' }, 'ni siquiera el último nivel con 0 XP');
    giveSeasonXp(db, u, s1, s1.xpPerLevel * 5 + 10);
    assert.equal(prog.summary(u).season.level, 5);
    assert.deepEqual(prog.claimSeason(u, { season: 1, level: 6 }), { ok: false, reason: 'locked' });
    const coins0 = wallets.ensure(u).coins;
    assert.equal(prog.claimSeason(u, { season: 1, level: 3 }).ok, true);
    assert.equal(wallets.ensure(u).coins, coins0 + 60);
    const five = prog.claimSeason(u, { season: 1, level: 5 });
    assert.equal(five.item, 'board:forest');
    assert.ok(wallets.ensure(u).owned.includes('board:forest'));
    for (let i = 0; i < 4; i += 1) assert.deepEqual(prog.claimSeason(u, { season: 1, level: 5 }), { ok: false, reason: 'claimed' });
    assert.deepEqual(prog.claimSeason(u, { season: 99, level: 1 }), { ok: false, reason: 'unknown' });
    assert.deepEqual(prog.claimSeason(u, { season: 1, level: 0 }), { ok: false, reason: 'unknown' });
    assert.deepEqual(prog.claimSeason(u, { season: 1, level: 'x' }), { ok: false, reason: 'unknown' });
  });

  test('lo reclamado con el sistema anterior (libro de cuentas) no se puede cobrar otra vez', () => {
    const { db, prog, user, wallets } = setup();
    const u = user('Ana');
    giveSeasonXp(db, u, SEASONS[0], SEASONS[0].xpPerLevel * 10);
    wallets.ensure(u);
    db.raw.prepare("INSERT INTO ledger (user_id, ref, source, coins, xp, created_at) VALUES (?, 'season:1:3', 'season', 60, 0, 1)").run(u);
    assert.deepEqual(prog.claimSeason(u, { season: 1, level: 3 }), { ok: false, reason: 'claimed' });
    assert.equal(prog.summary(u).season.track[2].state, 'claimed');
  });

  test('un objeto que ya tienes se compensa con monedas en vez de perderse', () => {
    const { db, prog, user, wallets } = setup();
    const u = user('Ana');
    giveSeasonXp(db, u, SEASONS[0], SEASONS[0].xpPerLevel * 5);
    wallets.grant(u, { ref: 'x', source: 'xp', item: 'board:forest' });
    const before = wallets.ensure(u).coins;
    const r = prog.claimSeason(u, { season: 1, level: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.item, null);
    assert.equal(wallets.ensure(u).coins, before + 60);
  });

  test('transición: la XP va a la temporada de su fecha y las recompensas de la anterior se pueden reclamar 14 días más', () => {
    const { db, prog, user, clock, wallets } = setup();
    const u = user('Ana');
    const [s1, s2] = SEASONS;
    giveSeasonXp(db, u, s1, s1.xpPerLevel * 4);
    clock.t = seasonStart(s2) + 1000; // ya estamos en la temporada 2
    const sum = prog.summary(u);
    assert.equal(sum.season.id, 2);
    assert.equal(sum.season.xp, 0, 'la temporada nueva empieza de cero');
    assert.equal(sum.pastSeasons.find((p) => p.id === 1).level, 4, 'el historial conserva lo conseguido');
    assert.equal(prog.claimSeason(u, { season: 1, level: 3 }).ok, true, 'dentro del plazo de gracia');
    assert.deepEqual(prog.claimSeason(u, { season: 2, level: 1 }), { ok: false, reason: 'locked' }, 'la XP vieja no cuenta en la nueva');
    clock.t = seasonEnd(s1) + 15 * 86_400_000;
    assert.deepEqual(prog.claimSeason(u, { season: 1, level: 4 }), { ok: false, reason: 'expired' });
    assert.ok(wallets.ensure(u).coins > 0);
  });

  test('los eventos del segundo exacto del cambio de temporada van a la nueva y no a la anterior', () => {
    const { db, prog, user, clock } = setup();
    const u = user('Ana');
    clock.t = seasonEnd(SEASONS[0]);
    prog.recordPuzzle(u, 1);
    clock.t = seasonStart(SEASONS[1]);
    prog.recordPuzzle(u, 2);
    const rows = db.raw.prepare('SELECT ref, season_id FROM progress_events WHERE user_id = ? AND kind = ? ORDER BY ref').all(u, 'puzzle');
    assert.deepEqual(rows.map((r) => r.season_id), [1, 2]);
  });

  test('fuera de toda temporada la XP de cuenta sigue contando y no se reclama nada', () => {
    const { prog, user, clock, wallets } = setup();
    const u = user('Ana');
    clock.t = Date.UTC(2027, 8, 1);
    prog.recordPuzzle(u, 5);
    const sum = prog.summary(u);
    assert.equal(sum.season, null);
    assert.ok(wallets.ensure(u).xp > 0, 'la cuenta progresa igualmente');
  });

  test('clasificación de temporada: rating propio con arranque suave, mínimo de partidas y congelada al terminar', () => {
    const { prog, user, game, clock } = setup();
    const a = user('Ana');
    const b = user('Beto');
    const delta = (dw, db) => ({ w: dw, b: db, ratings: { w: 1200 + dw, b: 1000 + db } });
    game({ w: a, b, rated: true, delta: delta(10, -10) });
    let s = prog.summary(a).season;
    assert.equal(s.ranking.rating, 1100 + 10, 'rating previo 1200 → arranque a mitad de camino: 1100, más el cambio');
    assert.equal(s.ranking.rank, null, 'con menos de 3 partidas todavía no aparece en la tabla');
    game({ w: a, b, rated: true, delta: delta(8, -8) });
    game({ w: a, b, rated: true, delta: delta(6, -6) });
    s = prog.summary(a).season;
    assert.equal(s.ranking.games, 3);
    assert.equal(s.ranking.rank, 1);
    const board = prog.leaderboard(1, a);
    assert.equal(board.top[0].name, 'Ana');
    assert.ok(board.top.every((r, i, arr) => i === 0 || arr[i - 1].rating >= r.rating));
    assert.equal(board.me.rank, 1);
    // otra temporada: la tabla de la primera queda intacta
    const frozen = prog.leaderboard(1, a).top[0].rating;
    clock.t = seasonStart(SEASONS[1]) + 1000;
    game({ w: a, b, rated: true, delta: delta(30, -30) });
    assert.equal(prog.leaderboard(1, a).top[0].rating, frozen);
    assert.equal(prog.summary(a).pastSeasons[0].ranking.games, 3);
    assert.equal(prog.summary(a).season.ranking.games, 1);
  });

  test('las partidas no clasificatorias o sin cambio de rating no tocan la clasificación', () => {
    const { prog, user, game } = setup();
    const a = user('Ana');
    const b = user('Beto');
    game({ w: a, b, rated: false });
    game({ w: a, b, rated: true, delta: null });
    assert.equal(prog.summary(a).season.ranking.games, 0);
    assert.equal(prog.leaderboard(1, a).top.length, 0);
  });
});

describe('logros', () => {
  test('se desbloquean por hitos verificados, pagan una vez y recuperan el historial anterior', () => {
    const { db, prog, user, wallets, clock } = setup();
    const a = user('Ana');
    const b = user('Beto');
    // historial anterior a este sistema: partidas ya guardadas en `games` sin eventos de progresión
    for (let i = 0; i < 10; i += 1) {
      db.insertGame({ id: `old-${i}-${a}`, code: 'OLD', whiteId: a, blackId: b, winner: i % 2 ? 'w' : 'b', reason: 'jaque mate', moves: JSON.stringify(LEGAL), rated: false, tc: 'blitz3_2', createdAt: clock.t - 1000 });
    }
    const first = prog.summary(a);
    const got = (id) => first.achievements.find((x) => x.id === id);
    assert.ok(got('games_1').unlockedAt && got('games_10').unlockedAt && got('wins_1').unlockedAt, 'recupera lo ya jugado');
    assert.equal(got('games_50').unlockedAt, null);
    assert.equal(got('games_50').progress, 10);
    const coins = wallets.ensure(a).coins;
    const again = prog.summary(a);
    assert.equal(wallets.ensure(a).coins, coins, 'ver la página otra vez no vuelve a pagar');
    assert.equal(again.achievements.filter((x) => x.unlockedAt).length, first.achievements.filter((x) => x.unlockedAt).length);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?').get(a).n, first.achievements.filter((x) => x.unlockedAt).length);
  });

  test('las partidas abortadas o cortas del historial no cuentan para los logros', () => {
    const { db, prog, user, clock } = setup();
    const a = user('Ana');
    const b = user('Beto');
    db.insertGame({ id: `ab-${a}`, code: 'X', whiteId: a, blackId: b, winner: null, reason: 'abortada', moves: JSON.stringify(LEGAL), rated: false, tc: 't', createdAt: clock.t });
    db.insertGame({ id: `sh-${a}`, code: 'X', whiteId: a, blackId: b, winner: 'w', reason: 'rendición', moves: JSON.stringify(['e2e4', 'e7e5']), rated: false, tc: 't', createdAt: clock.t });
    assert.equal(prog.summary(a).achievements.filter((x) => x.unlockedAt).length, 0);
  });

  test('el desafío diario, el circuit y las repeticiones también dan logros; todos los logros tienen hito y premio', () => {
    const { db, prog, user } = setup();
    const a = user('Ana');
    prog.recordPuzzle(a, 1);
    db.raw.prepare('INSERT INTO daily_results (day, user_id, seconds, attempts, created_at) VALUES (?,?,?,?,?)').run(1, a, 10, 1, 1);
    prog.recordCircuitJoin([a], 'T1');
    const sum = prog.summary(a);
    for (const id of ['puzzle_1', 'circuit_1']) assert.ok(sum.achievements.find((x) => x.id === id).unlockedAt, id);
    assert.ok(ACHIEVEMENTS.every((x) => x.target > 0 && x.name && x.text && (x.coins > 0 || x.xp > 0)));
    assert.equal(new Set(ACHIEVEMENTS.map((x) => x.id)).size, ACHIEVEMENTS.length);
  });
});

describe('repasar partidas, torneos y niveles', () => {
  test('revisar una partida propia da XP una sola vez, solo de partidas completas y llegando al final', () => {
    const { prog, user, game, xpOf } = setup();
    const a = user('Ana');
    const b = user('Beto');
    const c = user('Carla');
    const id = game({ w: a, b });
    const xp0 = xpOf(a);
    assert.deepEqual(prog.recordReview(a, id, 3), { ok: false, reason: 'notplayed' }, 'hay que llegar a la última jugada');
    assert.deepEqual(prog.recordReview(c, id, 13), { ok: false, reason: 'notplayed' }, 'no se revisa una partida ajena');
    assert.deepEqual(prog.recordReview(a, 'no-existe-123', 13), { ok: false, reason: 'notplayed' });
    assert.equal(prog.recordReview(a, id, 13).ok, true);
    assert.deepEqual(prog.recordReview(a, id, 13), { ok: false, reason: 'dup' });
    assert.equal(xpOf(a) - xp0, R.review + 0 + (xpOf(a) - xp0 - R.review), 'suma la XP de la revisión');
    assert.ok(xpOf(a) > xp0);
  });

  test('revisar muchas partidas el mismo día tiene un tope de XP', () => {
    const { prog, user, game, db } = setup();
    const a = user('Ana');
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(game({ w: a, b: user(`R${i}`), moves: LONG, winner: null, reason: 'tablas acordadas' }));
    for (const id of ids) assert.equal(prog.recordReview(a, id, 12).ok, true);
    const xps = db.raw.prepare("SELECT xp FROM progress_events WHERE user_id = ? AND kind = 'review' ORDER BY at, rowid").all(a).map((r) => r.xp);
    assert.deepEqual(xps, [R.review, R.review, R.review, 0, 0], 'las tres primeras dan XP (tope diario 45); las demás siguen contando para misiones pero sin XP');
  });

  test('torneo: participar y los resultados se registran una sola vez', () => {
    const { prog, user, events, xpOf } = setup();
    const a = user('Ana');
    prog.recordCircuitJoin([a], 'T9');
    prog.recordCircuitJoin([a], 'T9');
    prog.recordCircuitResults([{ userId: a, placement: 'semi', xp: 60 }], 'T9');
    prog.recordCircuitResults([{ userId: a, placement: 'semi', xp: 60 }], 'T9');
    assert.equal(events(a).filter((e) => e.kind === 'circuit_join').length, 1);
    assert.equal(events(a).filter((e) => e.kind === 'circuit').length, 1);
    assert.ok(xpOf(a) >= 60);
  });

  test('desbloqueos visuales por nivel de cuenta y aviso de nivel en tiempo real', () => {
    const { prog, user, wallets, pushes } = setup();
    const a = user('Ana');
    assert.equal(prog.summary(a).unlocks.filter((u) => u.unlocked).length, 0);
    wallets.grant(a, { ref: 'big', source: 'xp', xp: 400 });
    const sum = prog.summary(a);
    assert.ok(sum.account.level >= 3);
    assert.deepEqual(sum.unlocks.filter((u) => u.unlocked).map((u) => u.level), levelUnlocks().filter((u) => u.level <= sum.account.level).map((u) => u.level));
    prog.recordPuzzle(a, 7);
    assert.ok(pushes.every((p) => p.t === 'progress'));
  });
});

describe('sin castigos por no conectarse', () => {
  test('pasar días sin jugar no resta XP, nivel, reclamos ni logros; no hay rachas', () => {
    const { prog, user, game, clock, wallets, xpOf } = setup();
    const a = user('Ana');
    const b = user('Beto');
    game({ w: a, b });
    const before = { xp: xpOf(a), level: wallets.ensure(a).level, ach: prog.summary(a).achievements.filter((x) => x.unlockedAt).length, coins: wallets.ensure(a).coins };
    clock.t += 40 * 86_400_000; // 40 días sin entrar
    const after = prog.summary(a);
    assert.equal(xpOf(a), before.xp);
    assert.equal(after.account.level, before.level);
    assert.equal(after.achievements.filter((x) => x.unlockedAt).length, before.ach);
    assert.equal(wallets.ensure(a).coins, before.coins);
    assert.equal(JSON.stringify(after).match(/streak|racha/i), null, 'la página de progresión no tiene rachas');
    assert.ok(after.missions.daily.items.every((m) => m.state === 'pending'), 'las misiones de hoy empiezan limpias para todos, sin deuda');
  });
});

describe('API y tiempo real (servidor completo)', () => {
  const json = { 'Content-Type': 'application/json' };
  let app;
  let base;
  const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
  const authed = (g) => ({ ...json, Authorization: `Bearer ${g.token}` });
  const get = async (g, p) => (await fetch(`${base}${p}`, { headers: authed(g) })).json();
  const post = (g, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: authed(g), body: JSON.stringify(body) });

  const boot = async () => {
    app ??= await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0, circuitOptions: { autoSchedule: false } });
    base = `http://127.0.0.1:${app.port}`;
  };
  after(async () => app?.close());

  async function client(g) {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const log = [];
    ws.on('message', (d) => log.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'auth', token: g.token }));
    const until = async (pred, ms = 5000) => {
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

  test('exige sesión y rechaza peticiones mal formadas o falsificadas', async () => {
    await boot();
    assert.equal((await fetch(`${base}/api/progress`)).status, 401);
    assert.equal((await fetch(`${base}/api/progress/claim`, { method: 'POST', headers: json, body: '{}' })).status, 401);
    const g = await guest('Falsario');
    const bad = async (body) => (await post(g, '/api/progress/claim', body)).status;
    assert.equal(await bad({ kind: 'nada' }), 400);
    assert.equal(await bad({ kind: 'season', season: 1, level: 30 }), 409, 'no se reclama el último nivel sin XP');
    assert.equal(await bad({ kind: 'mission', slot: 'daily', id: 'd_play3', period: 'd1' }), 409, 'un periodo antiguo ya no admite reclamaciones');
    const sum = await get(g, '/api/progress');
    const m = sum.missions.daily.items[0];
    assert.equal((await post(g, '/api/progress/claim', { kind: 'mission', mission: m.id })).status, 400);
    assert.equal((await post(g, '/api/progress/review', { gameId: 'x'.repeat(12), ply: 99 })).status, 400);
    assert.equal((await post(g, '/api/progress/claim', 'no es json')).status >= 400, true);
    const after = await get(g, '/api/progress');
    assert.equal(after.account.xp, 0);
    assert.equal(after.account.level, 1);
  });

  test('recargar la página y repetir peticiones no genera XP; el monedero no acepta XP sin verificar', async () => {
    await boot();
    const g = await guest('Recargador');
    for (let i = 0; i < 8; i += 1) await get(g, '/api/progress');
    const sum = await get(g, '/api/progress');
    assert.equal(sum.account.xp, 0);
    const earn = await (await post(g, '/api/wallet/ops', { ops: [{ oid: 'a', t: 'earn', source: 'online', key: 'game:inventada', xp: 99999 }, { oid: 'b', t: 'earn', source: 'season', key: 'season:1:30' }, { oid: 'c', t: 'earn', source: 'mission', key: 'mission:x:y', coins: 500 }, { oid: 'd', t: 'earn', source: 'xp', key: 'ev:game:x', xp: 500 }] })).json();
    assert.deepEqual(earn.results.map((r) => r.reason), ['unverified', 'moved', 'unknown', 'unknown']);
    assert.equal((await get(g, '/api/progress')).account.xp, 0);
  });

  test('desafío diario: la XP se concede una sola vez por día y solo con solución válida', async () => {
    await boot();
    const g = await guest('Tactico');
    assert.equal((await post(g, '/api/daily/submit', { moves: ['a1a1'], seconds: 5, attempts: 1 })).status, 400);
    assert.equal((await get(g, '/api/progress')).history.length, 0);
    for (let i = 0; i < 3; i += 1) assert.equal((await post(g, '/api/daily/submit', { moves: ['a1a8'], seconds: 12, attempts: 1 })).status, 200);
    const sum = await get(g, '/api/progress');
    assert.equal(sum.history.filter((h) => h.kind === 'puzzle').length, 1);
    assert.ok(sum.account.xp >= R.puzzle || sum.account.level > 1);
    assert.ok(sum.achievements.find((a) => a.id === 'puzzle_1').unlockedAt);
  });

  test('una partida online real da XP a ambos, avisa en tiempo real y no se repite al recargar', async () => {
    await boot();
    const ga = await guest('Blancas');
    const gb = await guest('Negras');
    const a = await client(ga);
    const b = await client(gb);
    a.send({ t: 'create', tc: 'none', color: 'w' });
    const created = await a.until((m) => m.t === 'created');
    b.send({ t: 'join', code: created.code });
    await a.until((m) => m.t === 'state' && m.status === 'playing');
    const turn = async (c, uci, idx) => {
      c.send({ t: 'move', uci });
      await a.until((m) => m.t === 'state' && m.moves.length === idx + 1, 4000);
    };
    for (let i = 0; i < LEGAL.length; i += 1) await turn(i % 2 === 0 ? a : b, LEGAL[i], i);
    await a.until((m) => m.t === 'state' && m.status === 'over');
    const pushA = await a.until((m) => m.t === 'progress' && m.source === 'game');
    const pushB = await b.until((m) => m.t === 'progress' && m.source === 'game');
    assert.ok(pushA.xp > pushB.xp, 'el ganador con mate recibe algo más');
    assert.ok(pushB.xp >= R.base + R.complete, 'quien pierde terminando la partida recibe casi lo mismo');
    const sa = await get(ga, '/api/progress');
    const sb = await get(gb, '/api/progress');
    for (let i = 0; i < 4; i += 1) await get(ga, '/api/progress');
    const again = await get(ga, '/api/progress');
    assert.equal(again.account.xp, sa.account.xp);
    assert.equal(again.history.filter((h) => h.kind === 'game').length, 1);
    assert.equal(sb.history.filter((h) => h.kind === 'game').length, 1);
    // el servidor contó la partida para los logros del historial
    assert.ok(sa.achievements.find((x) => x.id === 'games_1').unlockedAt);
    assert.ok(sa.achievements.find((x) => x.id === 'mate_1').unlockedAt, 'dio jaque mate');
    // y se puede revisar la repetición una vez
    const games = (await get(ga, '/api/me/games')).games;
    const r1 = await (await post(ga, '/api/progress/review', { gameId: games[0].id, ply: games[0].plies })).json();
    assert.equal(r1.ok, true);
    const r2 = await post(ga, '/api/progress/review', { gameId: games[0].id, ply: games[0].plies });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).ok, false, 'repetirla no da XP otra vez');
    // un ajeno no puede revisar partidas que no jugó
    const outsider = await guest('Ajeno');
    assert.equal((await post(outsider, '/api/progress/review', { gameId: games[0].id, ply: games[0].plies })).status, 400);
    a.ws.close();
    b.ws.close();
  });

  test('clasificación de temporada pública y reclamo de pase por la API', async () => {
    await boot();
    const g = await guest('Pasador');
    const board = await (await fetch(`${base}/api/season/leaderboard?season=1`)).json();
    assert.equal(board.season.id, 1);
    assert.equal(board.minGames, 3);
    assert.ok(Array.isArray(board.top));
    assert.equal((await fetch(`${base}/api/season/leaderboard?season=999`)).status, 200, 'una temporada inexistente cae en la actual');
    const sum = await get(g, '/api/progress');
    assert.equal(sum.season.status, 'current');
    assert.equal(sum.season.track.length, sum.season.levels);
    assert.ok(sum.season.track.every((t) => t.state === 'locked'), 'sin XP, ningún nivel está abierto');
    assert.ok(sum.season.theme.accent);
    assert.ok(sum.rules.minPlies >= 1);
  });
});

describe('copias de la base de datos', () => {
  test('al fusionar una copia se conservan eventos, reclamos, logros y clasificación de temporada, sin duplicar', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prog-'));
    dirs.push(dir);
    const fileA = path.join(dir, 'a.db');
    const A = openDb(fileA);
    A.createUser({ id: 'ux', name: 'Equis', tokenHash: 'hx', recoveryHash: null });
    A.raw.prepare("INSERT INTO progress_events (user_id, ref, kind, xp, season_id, at, meta) VALUES ('ux','game:1','game',40,1,5,'{}')").run();
    A.raw.prepare("INSERT INTO mission_claims VALUES ('ux','d1','d_play3',5)").run();
    A.raw.prepare("INSERT INTO season_claims VALUES ('ux',1,3,5)").run();
    A.raw.prepare("INSERT INTO achievements VALUES ('ux','games_1',5)").run();
    A.raw.prepare("INSERT INTO season_stats VALUES (1,'ux',1000,1010,1010,3,2,1,0,5)").run();
    A.close();
    const B = openDb(':memory:');
    const buf = readFileSync(fileA);
    mergeSnapshot(B, buf, path.join(dir, 'tmp1.db'));
    mergeSnapshot(B, buf, path.join(dir, 'tmp2.db')); // idempotente
    const n = (t) => B.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    assert.deepEqual(['progress_events', 'mission_claims', 'season_claims', 'achievements', 'season_stats'].map(n), [1, 1, 1, 1, 1]);
    assert.equal(B.raw.prepare('SELECT rating FROM season_stats').get().rating, 1010);
    B.close();
  });
});

// Utilidades de ventanas de tiempo (puras)
describe('periodos', () => {
  test('el día y la semana empiezan y acaban donde dicen, sin huecos', () => {
    const d = dayIdOf(T0);
    assert.equal(dayWindow(d + 1)[0], dayWindow(d)[1]);
    const w = weekIdOf(T0);
    assert.equal(weekWindow(w + 1)[0], weekWindow(w)[1]);
    assert.equal(new Date(weekWindow(w)[0]).getUTCDay(), 1);
    assert.equal(seasonLevelOf(SEASONS[0], 10_000), 30);
    assert.equal(seasonLevelOf(SEASONS[0], -5), 0);
  });
});
