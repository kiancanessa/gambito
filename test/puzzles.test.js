import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chess } from 'chess.js';
import { dayId, loadPuzzles, nextResetAt, puzzleFor, verifySolution } from '../server/daily.js';

const puzzles = loadPuzzles();

test('hay suficientes puzzles para varios meses', () => {
  assert.ok(puzzles.length >= 60, `solo hay ${puzzles.length}; ejecuta npm run puzzles`);
});

test('cada puzzle es válido: FEN legal, mate en 2-3 y solución que mata a tiempo', () => {
  const seen = new Set();
  for (const p of puzzles) {
    const chess = new Chess(p.fen); // lanza si el FEN no es válido
    assert.ok([2, 3].includes(p.mateIn), `puzzle ${p.id}: mateIn inesperado`);
    assert.ok(!chess.isGameOver(), `puzzle ${p.id}: la posición ya terminó`);
    assert.ok(verifySolution(p, p.solution), `puzzle ${p.id}: la solución guardada no es un mate válido`);
    assert.ok(!seen.has(p.fen.split(' ').slice(0, 4).join(' ')), `puzzle ${p.id}: duplicado`);
    seen.add(p.fen.split(' ').slice(0, 4).join(' '));
  }
});

test('el puzzle del día es estable y rota', () => {
  const day = dayId(Date.UTC(2026, 9, 18));
  assert.equal(day, 17);
  assert.equal(puzzleFor(day), puzzleFor(day));
  assert.notEqual(puzzleFor(day).id, puzzleFor(day + 1).id);
  assert.equal(nextResetAt(Date.UTC(2026, 9, 18, 5)), Date.UTC(2026, 9, 19));
});
