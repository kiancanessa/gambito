// Reglas de XP de una partida: funciones puras y probadas. El servidor las aplica a las partidas que él mismo arbitró.
import { Chess } from 'chess.js';
import { XP_RULES as R } from '../public/js/progression-data.js';

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Hechos de una partida desde el punto de vista de `you` ('w' | 'b'), reproduciendo las jugadas con el motor de reglas. */
export function analyzeGame(moves, you) {
  const facts = { plies: Array.isArray(moves) ? moves.length : 0, checks: 0, captures: 0, promotions: 0, mate: false, lostQueen: false };
  if (!facts.plies) return facts;
  const chess = new Chess();
  try {
    moves.forEach((uci, i) => {
      if (typeof uci !== 'string' || !UCI.test(uci)) throw new Error('jugada no válida');
      const mine = (i % 2 === 0) === (you === 'w');
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (mine) {
        if (m.san.endsWith('#')) facts.mate = true;
        else if (m.san.endsWith('+')) facts.checks += 1;
        if (m.captured) facts.captures += 1;
        if (m.promotion) facts.promotions += 1;
      } else if (m.captured === 'q') facts.lostQueen = true;
    });
  } catch {
    /* partida guardada ilegible: se cuenta lo que se pudo reproducir */
  }
  return facts;
}

/**
 * XP de una partida. `facts` viene de analyzeGame; el resto lo decide el servidor.
 * Participar y terminar da la mayor parte; ganar es solo un extra, y abandonar no premia.
 * Devuelve { xp, parts } con el desglose (para mostrarlo en el historial).
 */
export function gameXp({ facts, result, abandon, rated, underdog }) {
  if (facts.plies < R.minPlies) return { xp: 0, parts: {} };
  const parts = { participar: abandon ? R.abandonBase : R.base };
  if (!abandon) parts.terminar = R.complete;
  if (result === 'win') parts.victoria = R.win;
  else if (result === 'draw') parts.tablas = R.draw;
  if (rated) parts.clasificatoria = R.rated;
  if (facts.mate) parts.mate = R.mate;
  if (facts.checks) parts.jaques = Math.min(R.maxChecks, facts.checks) * R.check;
  if (facts.promotions) parts.coronacion = R.promotion;
  if (underdog) parts.rival_superior = R.underdog;
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { xp: Math.min(R.perGameCap, total), parts };
}
