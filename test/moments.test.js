// Momentos destacados (PROMPT 08): lo que se afirma solo con las jugadas y lo que exige la evaluación del motor.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Chess } from 'chess.js';
import { engineMoments, materialBalance, mergeMoments, moveLabel, structuralMoments, summarize, THRESHOLDS, topMoments, whiteCp, winPct } from '../public/js/moments.js';

// Convierte jugadas UCI en lo que da chess.history({ verbose: true }).
function plies(uci) {
  const c = new Chess();
  uci.forEach((u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }));
  return c.history({ verbose: true });
}
const kinds = (ms) => ms.map((m) => m.kind);
const flat = (n, v = 0) => Array.from({ length: n }, () => v);

// 1.e4 e5 2.Dh5 Cc6 3.Dxe5 Cxe5 4.d3 Cf6: las blancas ceden la dama por un peón y no la recuperan.
const QUEEN_GIVEAWAY = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5e5', 'c6e5', 'd2d3', 'g8f6'];

describe('cálculo básico', () => {
  test('material y etiquetas de jugada', () => {
    assert.equal(materialBalance('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 0);
    assert.equal(materialBalance('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1'), -9);
    assert.equal(moveLabel(1, 'e4'), '1. e4');
    assert.equal(moveLabel(2, 'e5'), '1... e5');
    assert.equal(moveLabel(23, 'Cf3'), '12. Cf3');
  });

  test('las puntuaciones de mate pesan más que cualquier ventaja material y respetan el color', () => {
    assert.ok(whiteCp({ mate: 3 }, 'w') > 9000);
    assert.ok(whiteCp({ mate: 3 }, 'b') < -9000, 'mate a favor de quien mueve siendo negras = mal para las blancas');
    assert.ok(whiteCp({ mate: -2 }, 'w') < -9000);
    assert.ok(whiteCp({ mate: 0 }, 'w') < 0, 'mate 0 = quien mueve ya está mateado');
    assert.equal(whiteCp({ cp: 120 }, 'b'), -120);
    assert.ok(winPct(0) === 50 && winPct(600) > 85 && winPct(-600) < 15);
  });
});

describe('momentos que se deducen de las jugadas', () => {
  test('jaque mate (mate del loco) y nada más en una partida corta y limpia', () => {
    const m = structuralMoments(plies(['f2f3', 'e7e5', 'g2g4', 'd8h4']), { winner: 'b' });
    assert.deepEqual(kinds(m), ['checkmate']);
    assert.equal(m[0].ply, 4);
    assert.equal(m[0].side, 'b');
    assert.equal(m[0].source, 'moves');
  });

  test('coronación, con y sin captura', () => {
    const c = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    c.move({ from: 'a7', to: 'a8', promotion: 'q' });
    const m = structuralMoments(c.history({ verbose: true }), {});
    assert.deepEqual(kinds(m), ['promotion']);
    assert.match(m[0].title, /dama/);
  });

  test('victoria de torneo y campeón solo si el contexto lo dice y hay ganador', () => {
    const p = plies(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const t = { name: 'Royale Blitz', roundLabel: 'Final', final: true, champion: true };
    assert.ok(kinds(structuralMoments(p, { winner: 'b', tournament: t })).includes('champion'));
    assert.ok(kinds(structuralMoments(p, { winner: 'b', tournament: { ...t, champion: false } })).includes('tournament-win'));
    assert.ok(!kinds(structuralMoments(p, { winner: null, tournament: t })).some((k) => /champion|tournament/.test(k)), 'unas tablas no son una victoria');
    assert.ok(!kinds(structuralMoments(p, { winner: 'b' })).some((k) => /champion|tournament/.test(k)), 'sin torneo no hay victoria de torneo');
  });

  test('una captura o un cambio de piezas NO es un sacrificio', () => {
    // 1.e4 d5 2.exd5 Dxd5 3.Cc3 Da5: captura y recaptura, material igualado.
    const m = structuralMoments(plies(['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5a5', 'g1f3', 'g8f6']), {});
    assert.deepEqual(m, []);
  });

  test('ceder la dama por un peón sin recuperar es «material cedido», sin llamarlo brillante', () => {
    const m = structuralMoments(plies(QUEEN_GIVEAWAY), {});
    const c = m.find((x) => x.kind === 'sacrifice-candidate');
    assert.ok(c, 'se detecta el material cedido');
    assert.equal(c.ply, 5);
    assert.equal(c.side, 'w');
    assert.equal(c.source, 'moves');
    assert.ok(!kinds(m).includes('brilliant'));
    assert.match(c.detail, /Analiza la partida/);
  });
});

describe('momentos que exigen el motor', () => {
  const P = plies(QUEEN_GIVEAWAY);

  test('error grave: la evaluación se hunde y se señala la mejor alternativa', () => {
    const evals = [0, 20, 20, 20, 20, -900, -900, -900, -900];
    const m = engineMoments(P, evals, [null, null, null, null, 'g1f3']);
    const b = m.find((x) => x.kind === 'blunder');
    assert.ok(b && b.ply === 5 && b.side === 'w');
    assert.equal(b.bestUci, 'g1f3');
    assert.ok(!kinds(m).includes('brilliant') && !kinds(m).includes('sacrifice'));
  });

  test('sacrificio brillante: cede material, la posición aguanta, no estaba ganada y la ventaja crece', () => {
    const evals = [0, 0, 0, 0, 0, 10, 10, 260, 260];
    const m = engineMoments(P, evals);
    assert.ok(kinds(m).includes('brilliant'));
    const b = m.find((x) => x.kind === 'brilliant');
    assert.equal(b.ply, 5);
    assert.equal(b.source, 'engine');
    assert.ok(b.drop >= THRESHOLDS.sacrificeMaterial);
  });

  test('sacrificio sólido (no brillante) si la ventaja no crece después', () => {
    const m = engineMoments(P, [0, 0, 0, 0, 0, 10, 10, 10, 10]);
    assert.ok(kinds(m).includes('sacrifice'));
    assert.ok(!kinds(m).includes('brilliant'));
  });

  test('con la partida ya ganada, ceder material no se premia', () => {
    const m = engineMoments(P, [0, 0, 0, 0, 900, 900, 900, 900, 900]);
    assert.ok(!kinds(m).some((k) => k === 'brilliant' || k === 'sacrifice'));
  });

  test('con la evaluación plana y sin material cedido no hay sacrificio, aunque haya capturas', () => {
    const P2 = plies(['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5a5', 'g1f3', 'g8f6']);
    assert.deepEqual(kinds(engineMoments(P2, flat(9))), []);
  });

  test('error aprovechado y oportunidad perdida', () => {
    // 1.f3 e5 2.g4 Dh4#: las blancas se hunden con 2.g4; las negras lo aprovechan.
    const p = plies(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const good = engineMoments(p, [0, -10, -10, -400, -9000]);
    assert.ok(kinds(good).includes('blunder'));
    assert.ok(kinds(good).includes('opportunity'));
    const missed = engineMoments(p, [0, -10, -10, -400, 0]);
    assert.ok(kinds(missed).includes('missed'), 'tras el error rival se tiró la ventaja');
  });

  test('remontada: de claramente peor a claramente mejor', () => {
    const p = plies(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    const m = engineMoments(p, [0, -400, -400, 400, 400]);
    const t = m.find((x) => x.kind === 'turnaround');
    assert.ok(t);
    assert.equal(t.side, 'w');
  });

  test('longitud de evaluaciones inválida: sin momentos en vez de inventarlos', () => {
    assert.deepEqual(engineMoments(P, [0, 0, 0]), []);
    assert.equal(summarize(P, [0, 0]), null);
  });
});

describe('unión, ranking y resumen', () => {
  const P = plies(QUEEN_GIVEAWAY);

  test('sin análisis se conserva el material cedido; con análisis manda el motor', () => {
    const s = structuralMoments(P, {});
    assert.ok(kinds(mergeMoments(s)).includes('sacrifice-candidate'));
    const e = engineMoments(P, [0, 0, 0, 0, 0, -900, -900, -900, -900]);
    const merged = mergeMoments(s, e);
    assert.ok(!kinds(merged).includes('sacrifice-candidate'), 'el motor dice que fue un error, no un sacrificio');
    assert.ok(kinds(merged).includes('blunder'));
    assert.deepEqual(merged.map((m) => m.ply), [...merged.map((m) => m.ply)].sort((a, b) => a - b), 'ordenados por jugada');
  });

  test('topMoments: máximo uno por jugada, sin imprecisiones y por orden de partida', () => {
    const p = plies(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const all = mergeMoments(structuralMoments(p, { winner: 'b' }), engineMoments(p, [0, -10, -10, -400, -9000]));
    const top = topMoments(all, 5);
    assert.equal(new Set(top.map((m) => m.ply)).size, top.length);
    assert.ok(top.every((m) => m.kind !== 'inaccuracy'));
    assert.ok(top.some((m) => m.kind === 'checkmate'));
    assert.deepEqual(top.map((m) => m.ply), [...top.map((m) => m.ply)].sort((a, b) => a - b));
  });

  test('resumen: precisión y recuento de errores por bando', () => {
    const p = plies(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const s = summarize(p, [0, -10, -10, -400, -9000]);
    assert.equal(s.w.blunders, 1, 'g4 es un error grave');
    assert.ok(s.w.accuracy < s.b.accuracy);
    assert.ok(s.b.accuracy > 80);
    assert.equal(s.w.n + s.b.n, 4);
  });

  test('partida sin jugadas (abortada): no hay momentos ni se rompe nada', () => {
    assert.deepEqual(structuralMoments([], { winner: null }), []);
    assert.deepEqual(engineMoments([], [0]), []);
    assert.deepEqual(topMoments(mergeMoments([], []), 5), []);
    assert.equal(summarize([], [0]).w.accuracy, null);
  });
});
