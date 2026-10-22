// Cosméticos: catálogo coherente con sus recursos, inventario por servidor, desbloqueos, equipado y seguridad.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RARITY, DEFAULT_EQUIPPED, DEFAULT_OWNED } from '../public/js/data.js';
import { ACHIEVEMENTS, SEASONS, seasonStart } from '../public/js/progression-data.js';
import { CATEGORIES, CATEGORY_IDS, ITEMS, findItem, isGranted, itemKey, itemsOf, levelUnlocks, priceOf, unlockInfo } from '../public/js/cosmetics-data.js';
import { createCosmetics } from '../server/cosmetics.js';
import { openDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { createProgression } from '../server/progression.js';
import { createWallets } from '../server/wallet.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8').split('\r\n').join('\n');
// El tablero es 2D desde el rediseño minimalista: cada cosmético visual debe existir en CSS (piezas, tableros, coronación) o en JS 2D.
const SRC = { game: read('js/game.js'), art: read('js/cosmetics-art.js'), fx: read('js/fx.js'), css: `${read('css/style.css')}\n${read('css/checkpoint.css')}\n${read('css/minimal.css')}` };

let seq = 0;
function setup(start = Date.UTC(2026, 10, 5, 12)) {
  const db = openDb(':memory:');
  const wallets = createWallets(db);
  const pushes = [];
  const cosmetics = createCosmetics({ db, wallets, notify: (id, m) => pushes.push({ id, ...m }) });
  const clock = { t: start };
  const prog = createProgression({ db, wallets, now: () => clock.t, after: (id) => cosmetics.sync(id) });
  const user = (name) => {
    const id = `c${++seq}-${name}`;
    db.createUser({ id, name, tokenHash: `h-${id}`, recoveryHash: null });
    return id;
  };
  return { db, wallets, cosmetics, prog, clock, pushes, user };
}
const owned = (wallets, u) => wallets.ensure(u).owned;

describe('catálogo', () => {
  test('cada artículo tiene identificador, nombre, descripción, categoría, recurso, rareza, método de desbloqueo y estado', () => {
    for (const it of ITEMS) {
      const where = itemKey(it.category, it.id);
      assert.ok(it.id && /^[\w-]+$/.test(it.id), `id válido: ${where}`);
      assert.ok(CATEGORY_IDS.includes(it.category), `categoría: ${where}`);
      assert.ok(it.name && it.desc, `nombre y descripción: ${where}`);
      assert.ok(it.asset && Object.keys(it.asset).length, `recurso: ${where}`);
      assert.ok(RARITY[it.rarity], `rareza estética: ${where}`);
      assert.ok(['default', 'level', 'achievement', 'season', 'circuit', 'purchase', 'future'].includes(it.unlock.type), `desbloqueo: ${where}`);
      assert.ok(['active', 'soon'].includes(it.status), `estado: ${where}`);
      assert.ok(unlockInfo(it).short && unlockInfo(it).long, `texto de desbloqueo: ${where}`);
    }
    assert.equal(new Set(ITEMS.map((i) => itemKey(i.category, i.id))).size, ITEMS.length, 'identificadores únicos por categoría');
  });

  test('colección inicial: las diez categorías, con un artículo por defecto cada una', () => {
    assert.equal(CATEGORIES.length, 10);
    for (const c of CATEGORIES) {
      assert.ok(itemsOf(c.id).length >= 4, `${c.id} tiene una colección`);
      assert.equal(itemsOf(c.id).filter((i) => i.unlock.type === 'default').length, 1, `${c.id} tiene exactamente un predeterminado`);
    }
    assert.deepEqual([...DEFAULT_OWNED].sort(), ITEMS.filter((i) => i.unlock.type === 'default').map((i) => itemKey(i.category, i.id)).sort());
    assert.deepEqual(DEFAULT_EQUIPPED, Object.fromEntries(CATEGORIES.map((c) => [c.id, itemsOf(c.id).find((i) => i.unlock.type === 'default').id])));
  });

  test('los métodos de desbloqueo apuntan a cosas que existen (logros, temporadas, niveles, precios)', () => {
    const achievementIds = new Set(ACHIEVEMENTS.map((a) => a.id));
    for (const it of ITEMS) {
      const u = it.unlock;
      if (u.type === 'achievement') assert.ok(achievementIds.has(u.id), `logro inexistente en ${it.id}: ${u.id}`);
      if (u.type === 'level') assert.ok(Number.isInteger(u.level) && u.level >= 2 && u.level <= 50, `nivel de ${it.id}`);
      if (u.type === 'purchase') assert.ok(u.price > 0, `precio de ${it.id}`);
      if (u.type === 'season') {
        const s = SEASONS.find((x) => x.id === u.season);
        assert.ok(s, `temporada de ${it.id}`);
        assert.deepEqual(s.rewards[u.level]?.item, [it.category, it.id], `la temporada ${u.season} concede ${it.id} en el nivel ${u.level}`);
      }
      if (u.type === 'future') assert.equal(it.status, 'soon', `${it.id}: lo previsto no se puede conseguir`);
    }
    // y al revés: todo objeto de recompensa de temporada existe en el catálogo como artículo de temporada o de tienda
    for (const s of SEASONS) {
      for (const [level, r] of Object.entries(s.rewards)) {
        if (!r.item) continue;
        const it = findItem(r.item[0], r.item[1]);
        assert.ok(it, `la temporada ${s.id} nivel ${level} concede un artículo inexistente: ${r.item}`);
      }
    }
  });

  test('cada artículo visual tiene su recurso: CSS, partículas o animación (nada roto)', () => {
    for (const it of itemsOf('set')) {
      if (it.unlock.type !== 'default') assert.match(SRC.css, new RegExp(`\\.set-${it.id}\\b`), `piezas 2D ${it.id}`); // las clásicas usan el estilo base
    }
    for (const it of itemsOf('board')) assert.match(SRC.css, new RegExp(`\\.board-${it.id}\\b`), `tablero 2D ${it.id}`);
    for (const it of itemsOf('fx')) assert.match(read('js/fx.js'), new RegExp(`\\n\\s+${it.id}:`), `partículas ${it.id}`);
    for (const it of itemsOf('victory').filter((i) => i.id !== 'confetti')) assert.match(SRC.fx, new RegExp(`case '${it.id === 'fireworks' ? 'fireworks' : it.id}'`), `efecto de victoria ${it.id}`);
    for (const it of itemsOf('crown')) assert.match(SRC.css, new RegExp(`\\.crown-${it.id}\\b`), `coronación ${it.id}`);
    assert.match(SRC.game, /crown-\$\{style\}/, 'game.js aplica la coronación equipada');
    for (const it of itemsOf('avatar').filter((i) => i.asset.art)) assert.match(SRC.art, new RegExp(`\\n  ${it.asset.art}: `), `ilustración ${it.asset.art}`);
    for (const it of itemsOf('decor').filter((i) => i.unlock.type !== 'default')) assert.match(SRC.css, new RegExp(`\\.decor-${it.id}\\b`), `decoración ${it.id}`);
    for (const it of itemsOf('frame')) assert.ok(['none', 'solid', 'double', 'dashed', 'aurora'].includes(it.asset.style), `estilo de marco ${it.id}`);
  });

  test('los artículos son solo estéticos: las piezas nuevas solo cambian materiales y los efectos no tocan la partida', () => {
    // Un diseño de piezas solo define color/material: ninguna regla .set-* cambia el tamaño o la posición de las piezas
    for (const m of SRC.css.matchAll(/\.set-[\w-]+[^{]*\.piece[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(m[1], /(^|;)\s*(width|height|font-size|position|left|top|margin)\s*:/i, m[0].slice(0, 60));
    // El efecto de coronación es una capa encima de la casilla: no toca la partida ni el tablero
    const crown = SRC.game.slice(SRC.game.indexOf('  crownFx(sq) {'), SRC.game.indexOf('  squareCenter(sq) {'));
    assert.ok(crown.length > 50, 'existe crownFx');
    assert.doesNotMatch(crown, /chess\.|\.move\(|render\(|els\.board\.innerHTML/);
    // Y los efectos de victoria solo dibujan en la capa de celebración
    const victory = SRC.fx.slice(SRC.fx.indexOf('export function victoryFx'));
    assert.doesNotMatch(victory, /fetch\(|socket|state\./);
  });

  test('sin personajes ni marcas de terceros en nombres y descripciones', () => {
    const banned = /pok[eé]mon|mario|zelda|fortnite|marvel|disney|star wars|league of legends|valorant|minecraft|sonic/i;
    for (const it of ITEMS) assert.doesNotMatch(`${it.name} ${it.desc}`, banned, itemKey(it.category, it.id));
  });

  test('ayudas del catálogo: precios solo en artículos de tienda activos y lo concedido por el servidor', () => {
    assert.equal(priceOf(findItem('board', 'lava')), 800);
    assert.equal(priceOf(findItem('avatar', 'king')), null);
    assert.equal(priceOf(findItem('frame', 'eclipse')), null);
    assert.ok(isGranted(findItem('frame', 'gold')) && isGranted(findItem('set', 'royal')) && !isGranted(findItem('set', 'dragon')));
    assert.ok(levelUnlocks().every((u, i, a) => i === 0 || a[i - 1].level <= u.level));
  });
});

describe('inventario y equipado en el servidor', () => {
  test('una cuenta nueva solo tiene lo predeterminado y lo lleva equipado', () => {
    const { wallets, user } = setup();
    const u = user('Ana');
    const w = wallets.ensure(u);
    assert.deepEqual([...w.owned].sort(), [...DEFAULT_OWNED].sort());
    assert.deepEqual(w.equipped, DEFAULT_EQUIPPED);
  });

  test('equipar exige poseer el artículo; lo desconocido, lo previsto y los datos raros se rechazan', () => {
    const { cosmetics, user } = setup();
    const u = user('Ana');
    assert.deepEqual(cosmetics.equip(u, { category: 'avatar', id: 'king' }), { ok: false, reason: 'owned' });
    assert.deepEqual(cosmetics.equip(u, { category: 'avatar', id: 'inventado' }), { ok: false, reason: 'unknown' });
    assert.deepEqual(cosmetics.equip(u, { category: 'frame', id: 'eclipse' }), { ok: false, reason: 'unavailable' });
    assert.deepEqual(cosmetics.equip(u, { category: 'nada', id: 'pawn' }), { ok: false, reason: 'invalid' });
    assert.deepEqual(cosmetics.equip(u, { category: 'avatar', id: { $ne: 1 } }), { ok: false, reason: 'invalid' });
    assert.deepEqual(cosmetics.equip(u, { category: ['avatar'], id: 'pawn' }), { ok: false, reason: 'invalid' });
    assert.deepEqual(cosmetics.equip(u, { category: 'avatar' }), { ok: false, reason: 'invalid' });
    assert.equal(cosmetics.equip(u, { category: 'avatar', id: 'pawn' }).ok, true, 'lo que sí tiene se puede equipar');
  });

  test('el nivel de cuenta desbloquea cosméticos solos, sin duplicados, y avisa en tiempo real', () => {
    const { wallets, cosmetics, user, pushes } = setup();
    const u = user('Ana');
    assert.deepEqual(cosmetics.sync(u), []);
    wallets.grant(u, { ref: 'xp1', source: 'xp', xp: 100 + 160 }); // nivel 3
    const first = cosmetics.sync(u);
    const names = first.map((g) => `${g.category}:${g.id}`).sort();
    assert.deepEqual(names, ['avatar:knight', 'frame:bronze', 'title:apprentice'].sort());
    assert.ok(pushes.some((p) => p.t === 'cosmetics' && p.unlocked.length === 3));
    for (let i = 0; i < 4; i += 1) assert.deepEqual(cosmetics.sync(u), [], 'repetir no concede nada más');
    const list = owned(wallets, u);
    assert.equal(new Set(list).size, list.length, 'sin duplicados en el inventario');
    assert.equal(cosmetics.equip(u, { category: 'avatar', id: 'knight' }).ok, true);
    assert.equal(wallets.ensure(u).equipped.avatar, 'knight', 'el equipamiento persiste en la cartera');
    assert.equal(cosmetics.view(u).equipped.avatar, 'knight');
  });

  test('los logros desbloquean cosméticos por su cuenta (también los del historial anterior)', () => {
    const { db, prog, cosmetics, wallets, user, clock } = setup();
    const a = user('Ana');
    const b = user('Beto');
    // historial anterior: una victoria ya guardada
    db.insertGame({ id: `old-${a}`, code: 'OLD', whiteId: a, blackId: b, winner: 'w', reason: 'jaque mate', moves: JSON.stringify('e2e4 e7e5 g1f3 d7d6 f1c4 c8g4 b1c3 g7g6 f3e5 g4d1 c4f7 e8e7 c3d5'.split(' ')), rated: false, tc: 't', createdAt: clock.t });
    assert.ok(!owned(wallets, a).includes('avatar:comet'));
    prog.summary(a); // recupera los logros del historial
    cosmetics.sync(a);
    const list = owned(wallets, a);
    assert.ok(list.includes('avatar:comet') && list.includes('badge:first-win'), 'primera victoria → avatar Cometa e insignia');
    assert.ok(!list.includes('badge:champion'), 'lo que no se ha ganado, no se tiene');
  });

  test('el servidor concede los cosméticos al ganar XP aunque nadie abra la pantalla (gancho de progresión)', () => {
    const { prog, wallets, user } = setup();
    const a = user('Ana');
    prog.recordPuzzle(a, 1); // XP verificada
    db_assert_owned(wallets, a, 'frame:none');
    for (let d = 2; d < 9; d += 1) prog.recordPuzzle(a, d);
    assert.ok(owned(wallets, a).includes('avatar:knight'), 'al subir de nivel por XP se desbloquea el avatar de nivel 3');
  });

  test('los premios de temporada y de circuito llegan a su manera y no se duplican', () => {
    const { db, prog, wallets, user, clock } = setup();
    const u = user('Ana');
    clock.t = seasonStart(SEASONS[1]) + 1000; // temporada 2
    db.raw.prepare('INSERT INTO progress_events (user_id, ref, kind, xp, season_id, at, meta) VALUES (?,?,?,?,?,?,?)').run(u, 'xp', 'game', SEASONS[1].xpPerLevel * 22, 2, clock.t, '{}');
    assert.ok(!owned(wallets, u).includes('frame:canopy'));
    const r = prog.claimSeason(u, { season: 2, level: 22 });
    assert.equal(r.item, 'frame:canopy');
    assert.ok(owned(wallets, u).includes('frame:canopy'));
    assert.deepEqual(prog.claimSeason(u, { season: 2, level: 22 }), { ok: false, reason: 'claimed' });
    assert.equal(owned(wallets, u).filter((k) => k === 'frame:canopy').length, 1);
    // el premio del circuito (set royal) lo concede el servidor al cobrarlo
    const g = wallets.grant(u, { ref: 'circuit:t1', source: 'circuit', item: 'set:royal' });
    assert.equal(g.item, 'set:royal');
    assert.equal(wallets.grant(u, { ref: 'circuit:t1', source: 'circuit', item: 'set:royal' }).ok, false, 'el mismo premio no se cobra dos veces');
  });
});

describe('el cliente no puede otorgarse artículos', () => {
  const json = { 'Content-Type': 'application/json' };
  let app;
  let base;
  const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
  const authed = (g) => ({ ...json, Authorization: `Bearer ${g.token}` });
  const get = async (g, p) => (await fetch(`${base}${p}`, { headers: authed(g) })).json();
  const ops = async (g, list) => (await fetch(`${base}/api/wallet/ops`, { method: 'POST', headers: authed(g), body: JSON.stringify({ ops: list }) })).json();
  const equip = (g, body) => fetch(`${base}/api/cosmetics/equip`, { method: 'POST', headers: authed(g), body: JSON.stringify(body) });
  const boot = async () => {
    app ??= await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0, circuitOptions: { autoSchedule: false } });
    base = `http://127.0.0.1:${app.port}`;
  };
  after(async () => app?.close());

  test('las rutas exigen sesión y devuelven el inventario real', async () => {
    await boot();
    assert.equal((await fetch(`${base}/api/cosmetics`)).status, 401);
    assert.equal((await fetch(`${base}/api/cosmetics/equip`, { method: 'POST', headers: json, body: '{}' })).status, 401);
    const g = await guest('Nuevo');
    const d = await get(g, '/api/cosmetics');
    assert.deepEqual([...d.owned].sort(), [...DEFAULT_OWNED].sort());
    assert.deepEqual(d.equipped, DEFAULT_EQUIPPED);
    assert.equal(d.level, 1);
  });

  test('equipar un artículo que no tienes da 403; uno inexistente, 400; y no cambia nada', async () => {
    await boot();
    const g = await guest('Intruso');
    const r1 = await equip(g, { category: 'avatar', id: 'king' });
    assert.equal(r1.status, 403);
    assert.equal((await r1.json()).reason, 'owned');
    assert.equal((await equip(g, { category: 'avatar', id: 'zzz' })).status, 400);
    assert.equal((await equip(g, { category: 'frame', id: 'eclipse' })).status, 400, 'lo previsto aún no existe');
    assert.deepEqual((await get(g, '/api/cosmetics')).equipped, DEFAULT_EQUIPPED);
  });

  test('ni comprar, ni importar desde el guardado, ni la cartera, ni equipar por operación otorgan nada', async () => {
    await boot();
    const g = await guest('Tramposo');
    // 1) comprar lo que no se vende
    const r = await ops(g, [
      { oid: 'a', t: 'buy', kind: 'avatar', id: 'king' },
      { oid: 'b', t: 'buy', kind: 'frame', id: 'gold' },
      { oid: 'c', t: 'buy', kind: 'frame', id: 'eclipse' },
      { oid: 'd', t: 'buy', kind: 'set', id: 'royal' },
      { oid: 'e', t: 'buy', kind: 'avatar', id: 'inventado' },
      { oid: 'f', t: 'equip', kind: 'avatar', id: 'king' },
      { oid: 'g', t: 'earn', source: 'cosmetic', key: 'cosm:avatar:king', coins: 1 },
    ]);
    assert.deepEqual(r.results.map((x) => x.reason), ['exclusive', 'exclusive', 'unknown', 'exclusive', 'unknown', 'owned', 'unknown']);
    assert.ok(!r.wallet.owned.includes('avatar:king'));
    // 2) importar un guardado con artículos inventados (en una cuenta que aún no tiene cartera)
    const g2 = await guest('Importador');
    await fetch(`${base}/api/save`, { method: 'PUT', headers: authed(g2), body: JSON.stringify({ data: { coins: 5000, owned: ['avatar:king', 'frame:gold', 'victory:nova', 'title:legend', 'board:lava'], equipped: { avatar: 'king', frame: 'gold' } }, updatedAt: 1 }) });
    const w = (await get(g2, '/api/wallet')).wallet;
    for (const k of ['avatar:king', 'frame:gold', 'victory:nova', 'title:legend']) assert.ok(!w.owned.includes(k), `${k} no se importa`);
    assert.equal(w.equipped.avatar, 'pawn');
    assert.equal(w.equipped.frame, 'none');
    assert.ok(w.owned.includes('board:lava'), 'lo que sí se vende (tablero Magma) se conserva como siempre');
  });

  test('con oros suficientes se compra una vez; repetir no cobra ni duplica; luego se equipa', async () => {
    await boot();
    const g = await guest('Rico');
    await fetch(`${base}/api/save`, { method: 'PUT', headers: authed(g), body: JSON.stringify({ data: { coins: 5000 }, updatedAt: 1 }) });
    const w0 = (await get(g, '/api/wallet')).wallet;
    assert.equal(w0.coins, 5000);
    const r = await ops(g, [{ oid: 'b1', t: 'buy', kind: 'board', id: 'forest' }, { oid: 'b2', t: 'buy', kind: 'board', id: 'forest' }]);
    assert.deepEqual(r.results.map((x) => x.reason ?? 'ok'), ['ok', 'owned']);
    assert.equal(r.wallet.coins, 5000 - 120);
    assert.equal(r.wallet.owned.filter((k) => k === 'board:forest').length, 1);
    const e = await equip(g, { category: 'board', id: 'forest' });
    assert.equal(e.status, 200);
    assert.equal((await e.json()).equipped.board, 'forest');
    assert.equal((await get(g, '/api/cosmetics')).equipped.board, 'forest');
  });

  test('una partida real desbloquea cosméticos y avisa; el inventario sale del servidor', async () => {
    await boot();
    const g = await guest('Ganador');
    const d0 = await get(g, '/api/cosmetics');
    assert.ok(!d0.owned.includes('avatar:comet'));
    // logro por historial: se inserta una victoria guardada y se consulta
    const me = (await get(g, '/api/me')).user;
    const other = await guest('Rival');
    app.db.insertGame({ id: `h-${me.id}`, code: 'HIST', whiteId: me.id, blackId: other.user.id, winner: 'w', reason: 'jaque mate', moves: JSON.stringify('e2e4 e7e5 g1f3 d7d6 f1c4 c8g4 b1c3 g7g6 f3e5 g4d1 c4f7 e8e7 c3d5'.split(' ')), rated: false, tc: 't', createdAt: Date.now() });
    await get(g, '/api/progress'); // el servidor recupera los logros
    const d1 = await get(g, '/api/cosmetics');
    assert.ok(d1.owned.includes('avatar:comet'), 'Cometa por la primera victoria');
    assert.ok(d1.achievements.includes('wins_1'));
    const ok = await equip(g, { category: 'avatar', id: 'comet' });
    assert.equal(ok.status, 200);
    assert.equal((await get(g, '/api/cosmetics')).equipped.avatar, 'comet');
  });
});

function db_assert_owned(wallets, u, key) {
  assert.ok(owned(wallets, u).includes(key));
}
