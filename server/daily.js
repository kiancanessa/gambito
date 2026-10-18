// Desafío diario: un mate en 2-3 igual para todo el mundo, verificado en el servidor.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { ROOT } from './config.js';

export const EPOCH = Date.UTC(2026, 9, 1); // día 0 del desafío diario (1 oct 2026, UTC)

export const dayId = (now = Date.now()) => Math.floor((now - EPOCH) / 86_400_000);
export const nextResetAt = (now = Date.now()) => EPOCH + (dayId(now) + 1) * 86_400_000;

let cache = null;
export function loadPuzzles(file = path.join(ROOT, 'server', 'puzzles.json')) {
  cache ??= JSON.parse(readFileSync(file, 'utf8'));
  return cache;
}

export function puzzleFor(day, puzzles = loadPuzzles()) {
  const n = puzzles.length;
  return puzzles[((day % n) + n) % n];
}

/**
 * Comprueba una solución: jugadas UCI alternadas (jugador, rival, jugador...) que terminan en
 * jaque mate del jugador en como máximo `mateIn` jugadas suyas. No exige que el rival juegue lo mejor
 * (el cliente lo decide con el motor), solo que todo sea legal y acabe en mate a tiempo.
 */
export function verifySolution(puzzle, moves) {
  if (!Array.isArray(moves) || !moves.length || moves.length > puzzle.mateIn * 2 || moves.length % 2 === 0) return false;
  const chess = new Chess(puzzle.fen);
  const me = chess.turn();
  for (const uci of moves) {
    if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false;
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      return false;
    }
  }
  return chess.isCheckmate() && chess.turn() !== me;
}
