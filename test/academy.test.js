// Academia: todo el contenido se verifica con el motor de reglas (posiciones legales, soluciones que cumplen su objetivo).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Chess } from '../public/vendor/chess.js';
import { LESSONS, ORDER, STAGES, canMateIn, judge, mateForced, normSan, pickReply } from '../public/js/academy-data.js';
import { QUICK_LEVELS } from '../public/js/data.js';

const exercises = STAGES.flatMap((s) => s.lessons.flatMap((l) => l.exercises.map((ex) => ({ ex, lesson: l, stage: s }))));
const legal = (fen) => new Chess(fen).moves({ verbose: true });

describe('estructura', () => {
  test('etapas, lecciones y ejercicios tienen identificadores únicos y textos', () => {
    const ids = exercises.map(({ ex }) => ex.id);
    assert.equal(new Set(ids).size, ids.length, 'ids de ejercicio únicos');
    assert.equal(new Set(ORDER).size, ORDER.length);
    assert.equal(Object.keys(LESSONS).length, ORDER.length);
    for (const s of STAGES) {
      assert.ok(s.name && s.level && s.blurb && s.color, `etapa ${s.id}`);
      for (const l of s.lessons) {
        assert.ok(l.title && l.intro && l.exercises.length >= 1, `lección ${l.id}`);
      }
    }
    for (const { ex } of exercises) assert.ok(ex.prompt && ex.explain, `ejercicio ${ex.id} sin texto`);
    assert.ok(exercises.length >= 30, 'ruta completa: al menos 30 ejercicios');
  });

  test('la ruta va de lo básico a lo avanzado: fundamentos → táctica → finales → aperturas', () => {
    assert.deepEqual(STAGES.map((s) => s.id), ['basics', 'tactics', 'endgames', 'openings']);
    assert.equal(STAGES[0].lessons[0].id, 'pieces');
  });
});

describe('cada ejercicio es resoluble y su objetivo se puede cumplir', () => {
  for (const { ex } of exercises) {
    test(`${ex.id}`, () => {
      if (ex.kind === 'quiz') {
        assert.ok(ex.options.length >= 3 && Number.isInteger(ex.answer) && ex.answer >= 0 && ex.answer < ex.options.length);
        return;
      }
      const chess = new Chess(ex.fen); // lanza si la posición es ilegal
      assert.equal(chess.isGameOver(), false, 'la posición no puede estar terminada');
      const moves = chess.moves({ verbose: true });
      assert.ok(moves.length > 0);

      if (ex.kind === 'play') {
        assert.ok(QUICK_LEVELS.some((l) => l.id === ex.ai), 'nivel de IA válido');
        assert.ok(ex.limitMoves >= 10 && ex.limitMoves <= 60);
        assert.equal(ex.goal.type, 'win');
        return;
      }
      assert.equal(ex.kind, 'board');
      const g = ex.goal;
      const sans = moves.map((m) => normSan(m.san));
      const some = (fn) => moves.some(fn);
      switch (g.type) {
        case 'san':
          for (const s of g.moves) assert.ok(sans.includes(normSan(s)), `${s} no es legal en ${ex.fen}`);
          break;
        case 'capture': assert.ok(some((m) => m.captured)); break;
        case 'captureOf': assert.ok(some((m) => m.captured && m.to === g.square)); break;
        case 'check': assert.ok(some((m) => /[+#]/.test(m.san))); break;
        case 'mate': assert.ok(some((m) => m.san.endsWith('#'))); break;
        case 'castle': assert.ok(some((m) => m.flags.includes(g.side))); break;
        case 'enpassant': assert.ok(some((m) => m.flags.includes('e'))); break;
        case 'promote': assert.ok(some((m) => m.promotion && (!g.piece || m.promotion === g.piece))); break;
        case 'piece': assert.ok(some((m) => m.piece === g.piece)); break;
        case 'moveTo': assert.ok(g.squares.every((sq) => /^[a-h][1-8]$/.test(sq)) && some((m) => g.squares.includes(m.to))); break;
        case 'mateIn':
          assert.ok(canMateIn(ex.fen, g.n), `no hay mate en ${g.n}`);
          if (g.n > 1) assert.ok(!canMateIn(ex.fen, g.n - 1), `ya hay un mate más corto que ${g.n}`);
          break;
        case 'line': {
          const c = new Chess(ex.fen);
          for (const san of g.moves) assert.ok(c.move(san), `jugada ilegal en la línea: ${san}`);
          assert.equal(g.moves.length % 2, 1, 'la línea empieza y termina con una jugada del alumno');
          break;
        }
        default:
          assert.fail(`tipo de objetivo desconocido: ${g.type}`);
      }
      // Las jugadas «típicas del error» que explica el ejercicio existen y NO cumplen el objetivo.
      for (const wrong of Object.keys(ex.wrong ?? {})) {
        const m = moves.find((x) => normSan(x.san) === wrong);
        assert.ok(m, `la jugada errónea ${wrong} debe ser legal`);
        const after = new Chess(ex.fen);
        const played = after.move(m);
        assert.equal(judge(ex, played, after, 0).ok, false, `${wrong} no debería aceptarse`);
      }
    });
  }
});

describe('el juez acepta las soluciones y rechaza lo demás', () => {
  test('goals de una jugada: la solución se acepta y una jugada cualquiera que no cumple se rechaza', () => {
    for (const { ex } of exercises) {
      if (ex.kind !== 'board' || ['line', 'mateIn'].includes(ex.goal.type)) continue;
      const results = legal(ex.fen).map((m) => {
        const c = new Chess(ex.fen);
        const played = c.move(m);
        return { san: m.san, ok: judge(ex, played, c, 0).ok };
      });
      assert.ok(results.some((r) => r.ok), `${ex.id}: ninguna jugada se acepta`);
      if (!['piece', 'capture'].includes(ex.goal.type)) assert.ok(results.some((r) => !r.ok), `${ex.id}: todo se acepta`);
    }
  });

  test('línea guiada: se exige cada jugada del alumno y el profesor responde con la suya', () => {
    const ex = exercises.find(({ ex: e }) => e.id === 'op-italian').ex;
    const c = new Chess(ex.fen);
    const plies = ex.goal.moves;
    for (let step = 0; step * 2 < plies.length; step += 1) {
      const wrongTry = new Chess(c.fen());
      const wm = wrongTry.moves().find((s) => normSan(s) !== normSan(plies[step * 2]));
      const wrongPlayed = wrongTry.move(wm);
      assert.equal(judge(ex, wrongPlayed, wrongTry, step).ok, false);
      const played = c.move(plies[step * 2]);
      const r = judge(ex, played, c, step);
      assert.equal(r.ok, true);
      if (plies[step * 2 + 1]) {
        assert.equal(r.done, false);
        assert.equal(r.reply, plies[step * 2 + 1]);
        c.move(r.reply);
      } else {
        assert.equal(r.done, true);
      }
    }
  });

  test('mate en 2: solo vale una primera jugada que fuerza el mate; el rival responde y el alumno remata', () => {
    for (const { ex } of exercises.filter(({ ex: e }) => e.goal?.type === 'mateIn' && e.goal.n === 2)) {
      const first = legal(ex.fen).filter((m) => {
        const c = new Chess(ex.fen);
        const p = c.move(m);
        return judge(ex, p, c, 0).ok;
      });
      assert.ok(first.length >= 1, `${ex.id}: sin primera jugada válida`);
      assert.ok(first.length < legal(ex.fen).length, `${ex.id}: demasiadas jugadas válidas`);
      const c = new Chess(ex.fen);
      const p = c.move(first[0]);
      const r = judge(ex, p, c, 0);
      assert.equal(r.done, false);
      assert.ok(r.reply, 'el profesor responde');
      c.move(r.reply);
      const second = legal(c.fen()).filter((m) => {
        const cc = new Chess(c.fen());
        const pp = cc.move(m);
        return judge(ex, pp, cc, 1).done;
      });
      assert.ok(second.length >= 1, `${ex.id}: tras la respuesta existe el mate`);
    }
  });

  test('utilidades de mate: mateForced y pickReply son coherentes', () => {
    const c = new Chess('7k/8/8/8/8/8/R7/1R4K1 w - - 0 1');
    c.move('Ra7'); // deja al rey sin salida: solo le queda Rg8
    assert.equal(mateForced(c, 2), true, 'tras Ta7 (1.ª jugada de un mate en 2) las negras ya no lo evitan');
    assert.equal(mateForced(c, 1), false, 'todavía no es mate');
    assert.equal(pickReply(c).san, 'Kg8');
    assert.equal(canMateIn('6k1/5ppp/8/8/8/8/8/3RK3 w - - 0 1', 1), true);
    assert.equal(canMateIn('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 2), false);
  });
});
