// Jugador automático para las pruebas: jugadas legales, prefiere dar mate en 1 y capturas, y no regala mate en 1.
// No forma parte del servidor: los torneos del Circuit solo tienen jugadores reales.
import { Chess } from 'chess.js';

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function chooseBotMove(fen, rnd = Math.random) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const scored = moves.map((m) => {
    chess.move(m);
    let score = rnd() * 2;
    if (chess.isCheckmate()) score += 1000;
    else {
      if (m.captured) score += PIECE_VALUE[m.captured] * 3 - (PIECE_VALUE[m.piece] > PIECE_VALUE[m.captured] ? PIECE_VALUE[m.piece] : 0) * 0.5;
      if (chess.inCheck()) score += 1.5;
      if (m.promotion) score += 8;
      for (const r of chess.moves({ verbose: true })) {
        chess.move(r);
        if (chess.isCheckmate()) score -= 500;
        chess.undo();
        if (score < -400) break;
      }
    }
    chess.undo();
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].m;
  return best.from + best.to + (best.promotion ?? '');
}
