// Interfaz CHECKPOINT: comprobaciones estáticas para que no haya botones de navegación sin destino ni iconos rotos.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const jsFiles = readdirSync(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js'));
const jsSource = jsFiles.map((f) => readFileSync(path.join(PUBLIC, 'js', f), 'utf8')).join('\n');

const screens = new Set([...html.matchAll(/<section class="screen"[^>]*id="screen-([\w-]+)"/g)].map((m) => m[1]));

test('cada data-go del HTML y del JS apunta a una pantalla que existe', () => {
  const targets = new Set([...html.matchAll(/data-go="([\w-]+)"/g), ...jsSource.matchAll(/data-go="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...targets].filter((t) => !screens.has(t));
  assert.deepEqual(missing, [], `pantallas sin sección en index.html: ${missing.join(', ')}`);
  for (const must of ['home', 'lobby', 'circuit', 'ranking', 'profile', 'history', 'settings', 'progress', 'shop', 'social', 'academy', 'watch']) {
    assert.ok(screens.has(must), `falta la pantalla ${must}`);
  }
});

test('main.js sabe abrir todas las pantallas de la navegación principal', () => {
  const main = readFileSync(path.join(PUBLIC, 'js', 'main.js'), 'utf8');
  for (const name of ['lobby', 'circuit', 'social', 'ranking', 'profile', 'history', 'settings', 'academy', 'progress']) {
    assert.match(main, new RegExp(`name === '${name}'`), `go('${name}') no está gestionado`);
  }
});

test('todos los iconos del sprite que se usan están definidos', () => {
  const defined = new Set([...html.matchAll(/<symbol id="(i-[\w-]+)"/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/href="#(i-[\w-]+)"/g), ...jsSource.matchAll(/href="#(i-[\w-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((u) => !defined.has(u)), []);
});

test('la hoja de estilos CHECKPOINT se carga después de style.css y define los tokens', () => {
  const css = html.indexOf('/css/style.css');
  const cp = html.indexOf('/css/checkpoint.css');
  assert.ok(css > 0 && cp > css, 'checkpoint.css debe ir después de style.css');
  const tokens = readFileSync(path.join(PUBLIC, 'css', 'checkpoint.css'), 'utf8');
  for (const t of ['--cp-obsidian', '--cp-graphite', '--cp-cyan', '--cp-violet', '--cp-r', '--cp-s4']) assert.match(tokens, new RegExp(`${t}:`));
});

test('la marca es CHECKPOINT en la página, el manifiesto y la política de privacidad', () => {
  assert.match(html, /<title>CHECKPOINT/);
  assert.match(readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'), /"short_name": "CHECKPOINT"/);
  assert.doesNotMatch(readFileSync(path.join(PUBLIC, 'privacidad.html'), 'utf8'), /Gambito/);
});

test('los ids que usa el arranque existen en el HTML (no se rompe ningún enlace al iniciar)', () => {
  // Elementos buscados con $('#id') por los módulos que se inician en main.js sin esperar a ninguna pantalla.
  // (El rediseño minimalista quitó del inicio playNow, homeAccount, homeAcademyInfo y progressDot, y el ajuste set2d: el tablero ya es siempre 2D.)
  const ids = ['profileChip', 'profileBody', 'profileRating', 'muteBtn', 'homeHello', 'hlMineBody', 'hlWorldBody', 'rankTabs', 'rankingBody', 'historyFilter', 'historyBody', 'setSound', 'setMotion', 'setArena', 'setAccount', 'setLook', 'tutorialBtn', 'installBtn', 'resetBtn', 'tabbar', 'lobbyBody', 'circuitBody', 'socialBody', 'academyBody', 'progressBody', 'customBody', 'czLive'];
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `falta #${id}`);
});

test('la campaña con mapa ya no existe: la Academia la sustituye y ningún archivo la referencia', () => {
  assert.doesNotMatch(html, /screen-campaign|homeCampaignInfo|mapHost/);
  assert.doesNotMatch(jsSource, /startCampaign|renderMap|from '\.\/map\.js'/);
  assert.ok(!jsFiles.includes('map.js'));
  assert.ok(jsFiles.includes('academy.js') && jsFiles.includes('academy-data.js'));
});

test('la progresión sustituye a las misiones y la temporada locales: nada de XP ni premios decididos por el cliente', () => {
  assert.doesNotMatch(html, /screen-missions|screen-season|missionsBody|seasonBody/);
  assert.doesNotMatch(jsSource, /from '\.\/(missions|season)\.js'|addSeasonXp|track\('/);
  assert.ok(jsFiles.includes('progress.js') && jsFiles.includes('progression-data.js'));
  assert.ok(!jsFiles.includes('missions.js') && !jsFiles.includes('season.js'));
});

test('la personalización sustituye a la tienda antigua: sin cuadrícula de compra local ni equipar desde el cliente', () => {
  assert.doesNotMatch(html, /id="shopGrid"|id="shopTabs"/);
  assert.ok(jsFiles.includes('customize.js') && jsFiles.includes('cosmetics-data.js') && jsFiles.includes('cosmetics-art.js'));
  const main = readFileSync(path.join(PUBLIC, 'js', 'main.js'), 'utf8');
  assert.match(main, /import\('\.\/customize\.js'\)/, 'la página se carga a demanda');
  assert.doesNotMatch(main, /renderShop|from '\.\/store\.js'[^;]*equip/);
});
