// Sistema de puntuación Elo para partidas clasificatorias.
export const START_RATING = 1000;
export const MIN_RATING = 100;

export const expectedScore = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

// K más alto con pocas partidas para que el rating converja rápido.
export const kFactor = (games) => (games < 20 ? 40 : 24);

/**
 * @param {{rating:number, games:number}} a
 * @param {{rating:number, games:number}} b
 * @param {number} scoreA 1 gana A, 0.5 tablas, 0 gana B
 * @returns {[number, number]} cambios de rating [A, B]
 */
export function ratingChanges(a, b, scoreA) {
  const da = Math.round(kFactor(a.games) * (scoreA - expectedScore(a.rating, b.rating)));
  const db = Math.round(kFactor(b.games) * (1 - scoreA - expectedScore(b.rating, a.rating)));
  return [da, db];
}
