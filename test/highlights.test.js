// Highlights del inicio (rediseño): las partidas históricas deben ser exactamente lo que dicen ser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { materialBalance } from '../public/js/moments.js';
import { WORLD_CATEGORIES, WORLD_HIGHLIGHTS } from '../public/js/world-highlights.js';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');

test('cada partida histórica es legal de principio a fin y termina como dice su resultado', () => {
  for (const h of WORLD_HIGHLIGHTS) {
    const c = new Chess();
    const sans = h.san.split(' ');
    sans.forEach((s, i) => assert.doesNotThrow(() => c.move(s), `${h.id}: la jugada ${i + 1} (${s}) es ilegal`));
    if (h.categories.includes('mate')) {
      assert.ok(c.isCheckmate(), `${h.id}: dice terminar en mate y no lo hace`);
      const winner = c.turn() === 'w' ? 'b' : 'w';
      assert.equal(h.result, winner === 'w' ? '1-0' : '0-1', `${h.id}: el resultado no coincide con quien dio el mate`);
    }
  }
});

test('la jugada destacada es la anunciada, y si se llama sacrificio, entrega material de verdad', () => {
  for (const h of WORLD_HIGHLIGHTS) {
    const sans = h.san.split(' ');
    assert.equal(sans[h.ply - 1], h.key, `${h.id}: la jugada ${h.ply} no es ${h.key}`);
    if (!h.categories.includes('sacrifice')) continue;
    const c = new Chess();
    sans.slice(0, h.ply - 1).forEach((s) => c.move(s));
    const mover = c.turn();
    const pov = (fen) => (mover === 'w' ? materialBalance(fen) : -materialBalance(fen));
    const before = pov(c.fen());
    c.move(sans[h.ply - 1]);
    if (sans[h.ply]) c.move(sans[h.ply]); // la respuesta del rival
    assert.ok(before - pov(c.fen()) >= 5, `${h.id}: tras ${h.key} y la respuesta, quien juega debe haber entregado al menos 5 puntos de material`);
  }
});

test('metadatos completos, categorías conocidas e ids únicos', () => {
  const ids = new Set();
  for (const h of WORLD_HIGHLIGHTS) {
    for (const k of ['id', 'title', 'white', 'black', 'event', 'idea']) assert.ok(typeof h[k] === 'string' && h[k].length > 2, `${h.id}: falta ${k}`);
    assert.ok(Number.isInteger(h.year) && h.year > 1500 && h.year <= new Date().getFullYear(), `${h.id}: año`);
    assert.ok(h.categories.length && h.categories.every((c) => c in WORLD_CATEGORIES), `${h.id}: categoría desconocida`);
    assert.ok(!ids.has(h.id), `id repetido ${h.id}`);
    ids.add(h.id);
    assert.ok(h.idea.length <= 260, `${h.id}: la explicación debe ser breve (una o dos frases)`);
  }
});

test('el inicio ya no carga la escena 3D ni la partida de demostración', () => {
  const stage = readFileSync(path.join(JS, 'stage.js'), 'utf8');
  assert.doesNotMatch(stage, /from '\.\/board3d\.js'/, 'stage.js no debe importar three.js');
  const lobby = readFileSync(path.join(JS, 'lobby.js'), 'utf8');
  assert.doesNotMatch(lobby, /from '\.\/board3d\.js'/);
  const main = readFileSync(path.join(JS, 'main.js'), 'utf8');
  assert.match(main, /import\('\.\/highlights\.js'\)/, 'los highlights se cargan bajo demanda');
});

test('los highlights propios solo usan momentos que el criterio considera buenas jugadas, y siempre del propio jugador', () => {
  const src = readFileSync(path.join(JS, 'highlights.js'), 'utf8');
  assert.match(src, /m\.side !== d\.you/);
  for (const bad of ['blunder', 'mistake', 'inaccuracy', 'missed', 'sacrifice-candidate']) assert.doesNotMatch(src.match(/const GOOD = new Set\(\[([^\]]+)\]\)/)[1], new RegExp(`'${bad}'`), `«${bad}» no es una buena jugada`);
});
