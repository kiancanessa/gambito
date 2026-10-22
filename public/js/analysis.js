// Análisis de una partida con Stockfish en el navegador (PROMPT 08). No cuesta nada al servidor y no cambia nada oficial:
// las jugadas y el resultado salen siempre de la partida guardada; esto solo calcula evaluaciones para mostrar momentos destacados.
import { Chess } from '../vendor/chess.js';
import { Engine } from './engine.js';
import { engineMoments, mergeMoments, structuralMoments, summarize, whiteCp } from './moments.js';

const CACHE_KEY = 'gambito.analysis.v1.';
const DEPTH = 11;
const MOVETIME = 250;

/** Jugadas UCI → lista verbose de chess.js (con FEN antes y después, SAN, captura, coronación). */
export function verbosePlies(moves) {
  const c = new Chess();
  for (const u of moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return c.history({ verbose: true });
}

const readCache = (id, n) => {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY + id) ?? 'null');
    return c && c.v === 1 && c.evals?.length === n + 1 && c.evals.every((x) => Number.isFinite(x)) ? c : null;
  } catch {
    return null;
  }
};
const writeCache = (id, data) => {
  try {
    localStorage.setItem(CACHE_KEY + id, JSON.stringify({ v: 1, ...data }));
  } catch {
    /* sin almacenamiento: se recalcula la próxima vez */
  }
};

/**
 * Evalúa cada posición de la partida. Devuelve `{ evals, best }` (evals en centipeones desde las blancas) o null si no hay motor
 * o se canceló. Las posiciones terminales (mate, tablas) no se envían al motor: se puntúan con las reglas.
 */
export async function analyzeGame(id, moves, { onProgress, signal } = {}) {
  const cached = readCache(id, moves.length);
  if (cached) return { evals: cached.evals, best: cached.best ?? [], cached: true };
  const engine = new Engine();
  try {
    const c = new Chess();
    const evals = [];
    const best = [];
    for (let k = 0; k <= moves.length; k += 1) {
      if (signal?.aborted) return null;
      const turn = c.turn();
      if (c.isCheckmate()) {
        evals.push(whiteCp({ mate: 0 }, turn));
        best.push(null);
      } else if (c.isDraw() || c.isStalemate() || c.isInsufficientMaterial()) {
        evals.push(0);
        best.push(null);
      } else {
        const v = await engine.evaluate(c.fen(), { depth: DEPTH, movetime: MOVETIME });
        if (signal?.aborted) return null;
        if (!v || (v.cp === undefined && v.mate === undefined)) return null;
        evals.push(whiteCp(v, turn));
        best.push(v.best ?? null);
      }
      onProgress?.(k, moves.length);
      if (k < moves.length) c.move({ from: moves[k].slice(0, 2), to: moves[k].slice(2, 4), promotion: moves[k][4] });
    }
    const out = { evals, best };
    writeCache(id, out);
    return out;
  } finally {
    engine.dispose();
  }
}

/** Todo junto: momentos (por jugadas y por motor), resumen y mejores jugadas para cada partida. */
export function buildMoments(moves, ctx, analysis = null) {
  const plies = verbosePlies(moves);
  const structural = structuralMoments(plies, ctx);
  const engine = analysis ? engineMoments(plies, analysis.evals, analysis.best) : [];
  return { plies, moments: mergeMoments(structural, engine), summary: analysis ? summarize(plies, analysis.evals) : null };
}

/** SAN de una jugada UCI en una posición (para «mejor era ...»); null si no es legal. */
export function uciToSan(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })?.san ?? null;
  } catch {
    return null;
  }
}
