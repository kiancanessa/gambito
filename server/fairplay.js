// Juego limpio (Fase 6): heurísticas baratas, sin motor de ajedrez en el servidor.
//
// Hay dos tipos de reacción, a propósito distintos:
//  1. Protección del ranking (se aplica sola): una partida clasificatoria NO mueve el Elo si es la 4.ª+ contra el mismo
//     rival en 24 h (reparto de puntos entre cuentas) o si termina por rendición/desconexión antes de la 6.ª jugada.
//  2. Alertas para revisar (no sancionan): ritmo de juego sospechosamente regular o instantáneo se guarda en `game_flags`
//     y se lista con `npm run reports`. Ninguna señal de tiempo prueba nada por sí sola, así que no hay castigo automático.
import { nullMetrics } from './metrics.js';

export const FAIRPLAY = {
  pairWindowMs: 24 * 3600 * 1000,
  pairRatedLimit: 3, // partidas clasificatorias puntuables contra el mismo rival cada 24 h
  quickEndPlies: 6, // rendirse/desconectarse antes de esto no puntúa
  skipOpeningMoves: 3, // las primeras jugadas de cada bando suelen ser de memoria: no cuentan para el ritmo
  uniform: { minMoves: 15, minMeanMs: 1500, maxCv: 0.12 },
  instant: { minMoves: 20, thresholdMs: 400, minRatio: 0.6, minBaseSeconds: 120 }, // no se evalúa en bala
};

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a, m = mean(a)) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);

/**
 * Analiza el ritmo de las jugadas de un bando. `thinks` = [{ role, ms }] en orden; `baseSeconds` = reloj base de la partida.
 * Devuelve alertas { kind, score (0-1), detail }. Con pocas jugadas no se concluye nada.
 */
export function analyzeTimings(thinks, role, baseSeconds, cfg = FAIRPLAY) {
  const own = thinks.filter((t) => t.role === role).slice(cfg.skipOpeningMoves).map((t) => t.ms);
  const flags = [];
  if (own.length >= cfg.uniform.minMoves) {
    const m = mean(own);
    const cv = stdev(own, m) / m;
    if (m >= cfg.uniform.minMeanMs && cv < cfg.uniform.maxCv) {
      flags.push({ kind: 'uniform_timing', score: +(1 - cv / cfg.uniform.maxCv).toFixed(2), detail: `${own.length} jugadas, media ${Math.round(m)} ms, variación ${(cv * 100).toFixed(1)} %` });
    }
  }
  if (own.length >= cfg.instant.minMoves && baseSeconds >= cfg.instant.minBaseSeconds) {
    const fast = own.filter((ms) => ms < cfg.instant.thresholdMs).length;
    const ratio = fast / own.length;
    if (ratio >= cfg.instant.minRatio) {
      flags.push({ kind: 'instant_moves', score: +ratio.toFixed(2), detail: `${fast} de ${own.length} jugadas en menos de ${cfg.instant.thresholdMs} ms` });
    }
  }
  return flags;
}

/**
 * Evalúa una partida terminada. Devuelve { skipRating, reason, flags: [{ userId, kind, score, detail }] }.
 * Solo se evalúan jugadores humanos (los bots del torneo llevan id `bot-…`).
 */
export function assessGame({ room, db, cfg = FAIRPLAY, now = Date.now() }) {
  const { w, b } = room.players;
  const flags = [];
  let skipRating = false;
  let reason = null;
  const human = (p) => p && !String(p.id).startsWith('bot-');

  if (human(w) && human(b) && !room.circuit) {
    for (const [role, p] of [['w', w], ['b', b]]) {
      for (const f of analyzeTimings(room.thinks ?? [], role, room.tc.base, cfg)) flags.push({ userId: p.id, ...f });
    }
  }

  const res = room.result;
  if (room.rated && human(w) && human(b) && res && res.reason !== 'abortada') {
    const quick = res.winner && ['rendición', 'desconexión'].includes(res.reason) && room.uci.length < cfg.quickEndPlies;
    if (quick) {
      skipRating = true;
      reason = 'quick';
      const loser = res.winner === 'w' ? b : w;
      flags.push({ userId: loser.id, kind: 'quick_end', score: 1, detail: `${res.reason} en la jugada ${room.uci.length}` });
    }
    // El recuento incluye la partida actual (ya guardada en `games`).
    const pairGames = db.ratedGamesBetween(w.id, b.id, now - cfg.pairWindowMs);
    if (pairGames > cfg.pairRatedLimit) {
      skipRating = true;
      reason ??= 'pair';
      for (const p of [w, b]) flags.push({ userId: p.id, kind: 'pair_farming', score: Math.min(1, pairGames / 10), detail: `${pairGames} partidas clasificatorias contra el mismo rival en 24 h` });
    }
  }
  return { skipRating, reason, flags };
}

export function recordFlags({ db, gameId, flags, metrics = nullMetrics }) {
  for (const f of flags) {
    db.insertFlag(gameId, f);
    metrics.inc('fairplay_flags_total', { kind: f.kind });
  }
}
