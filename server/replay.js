// Repeticiones (PROMPT 08): la partida guardada en `games` es la única fuente. Aquí se comprueba que sea coherente y se arma
// la respuesta que ven los clientes. Nada de lo que envíe un cliente (posición, notas, análisis) modifica una partida ni su resultado.
import { Chess } from 'chess.js';
import { randomBytes } from 'node:crypto';

// Motivos cuyo resultado se deduce solo de las jugadas (se puede comprobar) y los que registró el servidor (reloj, rendición...).
const BY_MOVES = new Set(['jaque mate', 'rey ahogado', 'material insuficiente', 'triple repetición', 'regla de las 50 jugadas']);
export const SHARE_TOKEN = /^rs[\w-]{16,40}$/;

/**
 * Reproduce las jugadas guardadas (UCI) con las reglas del ajedrez y comprueba el resultado registrado.
 * Devuelve `{ legal, plies, proof, ok }`: `proof: 'moves'` si el final se deduce de la posición; `'server'` si lo decidió el
 * reloj o un evento de la partida (tiempo, rendición, desconexión, tablas pactadas, partida abortada).
 */
export function verifyGame({ moves, winner, reason }) {
  const chess = new Chess();
  let legal = Array.isArray(moves);
  let plies = 0;
  if (legal) {
    for (const uci of moves) {
      try {
        if (typeof uci !== 'string' || !chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })) throw new Error('ilegal');
        plies += 1;
      } catch {
        legal = false;
        break;
      }
    }
  }
  if (!legal) return { legal: false, plies, proof: 'moves', ok: false };
  const lastMover = chess.turn() === 'w' ? 'b' : 'w';
  let ok = true;
  const proof = BY_MOVES.has(reason) ? 'moves' : 'server';
  if (reason === 'jaque mate') ok = chess.isCheckmate() && winner === lastMover;
  else if (reason === 'rey ahogado') ok = chess.isStalemate() && !winner;
  else if (reason === 'material insuficiente') ok = chess.isInsufficientMaterial() && !winner;
  else if (reason === 'triple repetición') ok = chess.isThreefoldRepetition() && !winner;
  else if (reason === 'regla de las 50 jugadas') ok = chess.isDraw() && !winner;
  else if (reason === 'abortada') ok = plies < 2 && !winner;
  else if (reason === 'rendición' || reason === 'desconexión') ok = (winner === 'w' || winner === 'b') && plies >= 2;
  else if (reason === 'tiempo') ok = winner === 'w' || winner === 'b';
  else if (reason === 'tiempo con material insuficiente' || reason === 'tablas acordadas') ok = !winner;
  return { legal, plies, proof, ok };
}

export const newShareToken = () => `rs${randomBytes(15).toString('base64url')}`;

/** Respuesta de una repetición. `you`: color de quien mira si jugó la partida; si no, se ve desde las blancas. */
export function replayPayload(db, g, { you = 'w', id = g.id, extra = {} } = {}) {
  const moves = JSON.parse(g.moves);
  const pub = db.community.publicGame(g.id);
  const ctx = pub?.kind === 'circuit' ? db.community.tournamentContext(pub.ref, g.code) : null;
  const integrity = verifyGame({ moves, winner: g.winner, reason: g.reason });
  return {
    id,
    code: g.code,
    you,
    winner: g.winner,
    reason: g.reason,
    rated: !!g.rated,
    tc: g.tc,
    createdAt: g.created_at,
    kind: pub?.kind ?? null,
    tournament: ctx ? { id: ctx.id, name: ctx.name, round: ctx.round, roundLabel: ctx.roundLabel, final: ctx.final, champion: ctx.final && !!g.winner && ctx.championId === (g.winner === 'w' ? g.white_id : g.black_id) } : null,
    moves,
    white: { name: g.white_name ?? 'Jugador', rating: g.white_rating },
    black: { name: g.black_name ?? 'Jugador', rating: g.black_rating },
    integrity: { ok: integrity.ok, proof: integrity.proof },
    ...extra,
  };
}
