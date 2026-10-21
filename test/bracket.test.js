// Cuadro de eliminación simple: lógica pura (cabezas de serie, byes, avance, nombres y puestos).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bracketSize, bySeed, firstRound, nextSlot, placementOf, roundCount, roundName, seedOrder } from '../server/bracket.js';

describe('cabezas de serie', () => {
  test('el orden clásico: 1v8, 4v5, 2v7, 3v6', () => {
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
    assert.deepEqual(seedOrder(2), [1, 2]);
  });

  test('para 4, 8, 16, 32 y 64: cada seed aparece una vez y el 1 y el 2 solo se cruzan en la final', () => {
    for (const size of [4, 8, 16, 32, 64]) {
      const order = seedOrder(size);
      assert.equal(order.length, size);
      assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: size }, (_, i) => i + 1));
      assert.ok(order.indexOf(1) < size / 2 && order.indexOf(2) >= size / 2, `seeds 1 y 2 en mitades distintas (${size})`);
      // los dos mejores del cuadro entero nunca se enfrentan antes de la final: el primer cruce de mitades es la ronda final
      assert.equal(order[0] + order[1], size + 1, 'el 1 juega contra el peor');
    }
  });

  test('desempate para ordenar: rating, después antigüedad de inscripción, después id', () => {
    const list = [
      { id: 'c', rating: 1000, joinedAt: 5 },
      { id: 'a', rating: 1200, joinedAt: 9 },
      { id: 'b', rating: 1000, joinedAt: 2 },
      { id: 'd', rating: 1000, joinedAt: 5 },
    ];
    assert.deepEqual(list.sort(bySeed).map((e) => e.id), ['a', 'b', 'c', 'd']);
  });
});

describe('primera ronda y byes', () => {
  test('potencia de dos exacta: sin byes', () => {
    for (const n of [2, 4, 8, 16, 32, 64]) {
      const r = firstRound(n);
      assert.equal(r.size, n);
      assert.equal(r.first.length, n / 2);
      assert.ok(r.first.every((m) => !m.bye));
      assert.equal(r.rounds, Math.log2(n));
    }
  });

  test('con huecos, los mejores cabezas de serie reciben el bye y nadie se queda sin sitio ni se repite', () => {
    for (const n of [3, 5, 6, 7, 9, 12, 15, 17, 40]) {
      const r = firstRound(n);
      assert.equal(r.size, bracketSize(n));
      const players = r.first.flatMap((m) => [m.a, m.b]).filter((x) => x !== null);
      assert.equal(players.length, n, `${n} jugadores colocados`);
      assert.equal(new Set(players).size, n, 'ninguno repetido');
      const byes = r.first.filter((m) => m.bye);
      assert.equal(byes.length, r.size - n, 'tantos byes como plazas libres');
      // el bye lo recibe un seed alto: los que tienen bye son los de menor índice
      const lucky = byes.map((m) => m.a ?? m.b).sort((x, y) => x - y);
      assert.deepEqual(lucky, Array.from({ length: r.size - n }, (_, i) => i), 'byes para los mejores cabezas de serie');
      assert.ok(r.first.every((m) => !(m.a === null && m.b === null)), 'nunca dos byes en el mismo partido');
    }
  });

  test('5 jugadores: tres byes, 4 contra 5 es el único partido', () => {
    const r = firstRound(5);
    assert.equal(r.size, 8);
    assert.deepEqual(r.first.filter((m) => !m.bye).map((m) => [m.a, m.b]), [[3, 4]]);
  });

  test('entradas no válidas', () => {
    assert.throws(() => firstRound(1), RangeError);
    assert.throws(() => firstRound(0), RangeError);
    assert.throws(() => firstRound(2.5), RangeError);
  });
});

describe('avance, nombres y puestos', () => {
  test('el ganador del partido (r, s) pasa a la plaza s>>1, lado según la paridad', () => {
    assert.deepEqual(nextSlot(0), { slot: 0, side: 'a' });
    assert.deepEqual(nextSlot(1), { slot: 0, side: 'b' });
    assert.deepEqual(nextSlot(2), { slot: 1, side: 'a' });
    assert.deepEqual(nextSlot(7), { slot: 3, side: 'b' });
  });

  test('cada plaza de la ronda siguiente recibe exactamente a dos partidos', () => {
    const size = 16;
    const seen = new Map();
    for (let slot = 0; slot < size / 2; slot += 1) {
      const n = nextSlot(slot);
      seen.set(`${n.slot}${n.side}`, (seen.get(`${n.slot}${n.side}`) ?? 0) + 1);
    }
    assert.ok([...seen.values()].every((v) => v === 1));
    assert.equal(seen.size, size / 2);
  });

  test('nombres de ronda y puestos para 4, 8, 16, 32 y 64', () => {
    assert.equal(roundCount(16), 4);
    assert.deepEqual(Array.from({ length: 3 }, (_, r) => roundName(r, 3)), ['Cuartos de final', 'Semifinal', 'Final']);
    assert.deepEqual(Array.from({ length: 4 }, (_, r) => roundName(r, 4)), ['Octavos de final', 'Cuartos de final', 'Semifinal', 'Final']);
    assert.equal(roundName(0, 5), 'Dieciseisavos de final');
    assert.deepEqual(Array.from({ length: 4 }, (_, r) => placementOf(r, 4)), ['r16', 'quarter', 'semi', 'final']);
    assert.deepEqual(Array.from({ length: 6 }, (_, r) => placementOf(r, 6)), ['r64', 'r32', 'r16', 'quarter', 'semi', 'final']);
  });
});
