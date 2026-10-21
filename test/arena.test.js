// Arena del lobby: decisión 3D / 2D (función pura) y comprobaciones estáticas de la escena.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { arenaMode } from '../public/js/arena-caps.js';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');

test('equipo normal con WebGL: arena 3D animada', () => {
  assert.deepEqual(arenaMode({ cores: 8, memory: 8 }), { use3d: true, reason: 'ok', animate: true });
});

test('movimiento reducido: 3D pero un solo fotograma, sin bucle', () => {
  assert.deepEqual(arenaMode({ reducedMotion: true }), { use3d: true, reason: 'movimiento-reducido', animate: false });
});

test('alternativa 2D: ajustes, modo tablero 2D, sin WebGL, ahorro de datos y equipos limitados', () => {
  assert.deepEqual(arenaMode({ pref: '0' }), { use3d: false, reason: 'ajustes', animate: false });
  assert.equal(arenaMode({ board2d: true }).use3d, false, '«Tablero 2D» significa sin gráficos 3D');
  assert.equal(arenaMode({ webgl: false }).reason, 'sin-webgl');
  assert.equal(arenaMode({ saveData: true }).reason, 'ahorro-datos');
  assert.equal(arenaMode({ cores: 2 }).reason, 'equipo-limitado');
  assert.equal(arenaMode({ memory: 1 }).reason, 'equipo-limitado');
  assert.equal(arenaMode({ cores: 4, memory: 4 }).use3d, true);
});

test('valores por defecto sin datos del navegador: se asume un equipo capaz', () => {
  assert.equal(arenaMode().use3d, true);
});

test('la escena se carga bajo demanda y libera sus recursos', () => {
  const lobby = readFileSync(path.join(JS, 'lobby.js'), 'utf8');
  assert.match(lobby, /await import\('\.\/arena3d\.js'\)/, 'arena3d.js debe cargarse con import() dinámico');
  assert.doesNotMatch(lobby, /^import .* from '\.\/arena3d\.js'/m, 'no debe importarse de forma estática');
  const scene = readFileSync(path.join(JS, 'arena3d.js'), 'utf8');
  for (const needle of ['renderer.dispose()', 'forceContextLoss()', 'cancelAnimationFrame', 'webglcontextlost', 'visibilitychange', 'watchPerformance', "removeEventListener('pointermove'"]) {
    assert.ok(scene.includes(needle), `arena3d.js debe incluir ${needle}`);
  }
});
