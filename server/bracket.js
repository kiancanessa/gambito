// Cuadro de eliminación simple: funciones puras (sin reloj, sin base de datos) para que sean fáciles de probar.
// Sirve para cualquier potencia de dos (4, 8, 16, 32, 64...); con menos inscritos que plazas, los mejores cabezas de serie reciben un «bye».

/** Menor potencia de dos ≥ n (mínimo 2). */
export const bracketSize = (n) => {
  let b = 2;
  while (b < n) b *= 2;
  return b;
};

export const roundCount = (size) => Math.log2(size);

/**
 * Orden de cabezas de serie por plaza: [1, B, ...] de modo que el 1 y el 2 solo se cruzan en la final,
 * y el 1.º se enfrenta al peor. order(8) = [1,8,4,5,2,7,3,6] → 1v8, 4v5, 2v7, 3v6.
 */
export function seedOrder(size) {
  if (size === 1) return [1];
  return seedOrder(size / 2).flatMap((s) => [s, size + 1 - s]);
}

/**
 * Emparejamientos de la primera ronda para `count` jugadores ya ordenados por cabeza de serie (índice 0 = seed 1).
 * Devuelve `{ size, rounds, first: [{ slot, a, b, bye }] }` donde a/b son índices de jugador o null (bye).
 */
export function firstRound(count) {
  if (!Number.isInteger(count) || count < 2) throw new RangeError('Un cuadro necesita al menos 2 jugadores');
  const size = bracketSize(count);
  const order = seedOrder(size);
  const first = [];
  for (let slot = 0; slot < size / 2; slot += 1) {
    const a = order[slot * 2] <= count ? order[slot * 2] - 1 : null;
    const b = order[slot * 2 + 1] <= count ? order[slot * 2 + 1] - 1 : null;
    first.push({ slot, a, b, bye: a === null || b === null });
  }
  return { size, rounds: roundCount(size), first };
}

/** Plaza de la ronda siguiente a la que avanza el ganador de (round, slot). */
export const nextSlot = (slot) => ({ slot: slot >> 1, side: slot % 2 === 0 ? 'a' : 'b' });

const ROUND_NAMES = ['Final', 'Semifinal', 'Cuartos de final', 'Octavos de final', 'Dieciseisavos de final'];
/** Nombre de la ronda `round` (0 = primera) en un cuadro de `rounds` rondas. */
export const roundName = (round, rounds) => ROUND_NAMES[rounds - 1 - round] ?? `Ronda ${round + 1}`;

/** Puesto con el que cae quien pierde en `round`: 'final', 'semi', 'quarter', 'r16', 'r32'... (el campeón es 'champion'). */
export function placementOf(round, rounds) {
  const left = rounds - 1 - round; // 0 = final
  return ['final', 'semi', 'quarter', 'r16', 'r32', 'r64'][left] ?? `r${2 ** (left + 1)}`;
}

/** Orden de cabezas de serie: mejor rating primero; a igualdad, quien se inscribió antes. Determinista. */
export const bySeed = (a, b) => b.rating - a.rating || a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1);
