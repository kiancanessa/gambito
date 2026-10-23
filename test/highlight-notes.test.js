// Comentarios de «World-class moves»: cada afirmación de cada nota se comprueba contra el tablero con las reglas del ajedrez.
// Si un comentario dice «jaque», «captura una dama», «la única jugada legal» o «el alfil clava el caballo», la posición debe cumplirlo.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Chess } from 'chess.js';
import { PIECE_VALUE } from '../public/js/moments.js';
import { WORLD_HIGHLIGHTS } from '../public/js/world-highlights.js';

const FILES = 'abcdefgh';
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const at = (sq) => [FILES.indexOf(sq[0]), Number(sq[1]) - 1];
const name = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? `${FILES[f]}${r + 1}` : null);

// Casillas que una pieza «cubre» (ataca o protege), sin importar qué haya en ellas. Se calcula a mano para no depender del turno.
function covered(chess, sq) {
  const p = chess.get(sq);
  if (!p) return [];
  const [f, r] = at(sq);
  const out = [];
  const slide = (dirs) => {
    for (const [df, dr] of dirs) {
      for (let k = 1; k < 8; k += 1) {
        const t = name(f + df * k, r + dr * k);
        if (!t) break;
        out.push(t);
        if (chess.get(t)) break;
      }
    }
  };
  const jump = (offs) => offs.forEach(([df, dr]) => name(f + df, r + dr) && out.push(name(f + df, r + dr)));
  if (p.type === 'n') jump(KNIGHT);
  else if (p.type === 'k') jump(KING);
  else if (p.type === 'r') slide(ROOK);
  else if (p.type === 'b') slide(BISHOP);
  else if (p.type === 'q') slide([...ROOK, ...BISHOP]);
  else if (p.type === 'p') {
    const dir = p.color === 'w' ? 1 : -1;
    for (const df of [-1, 1]) name(f + df, r + dir) && out.push(name(f + df, r + dir));
  }
  return out;
}

// Casillas entre dos casillas alineadas (sin incluirlas); null si no están alineadas.
function between(a, b) {
  const [fa, ra] = at(a);
  const [fb, rb] = at(b);
  const df = Math.sign(fb - fa);
  const dr = Math.sign(rb - ra);
  if (!((fa === fb) || (ra === rb) || Math.abs(fb - fa) === Math.abs(rb - ra))) return null;
  const out = [];
  for (let k = 1; fa + df * k !== fb || ra + dr * k !== rb; k += 1) out.push(name(fa + df * k, ra + dr * k));
  return out;
}

// Posición antes y después de la jugada `ply` (1 = primera de las blancas).
function at_ply(h, ply) {
  const c = new Chess();
  const sans = h.san.split(' ');
  sans.slice(0, ply - 1).forEach((s) => c.move(s));
  const before = c.fen();
  const mover = c.turn();
  const move = c.move(sans[ply - 1]);
  const reply = sans[ply] ? new Chess(c.fen()).move(sans[ply]) : null;
  const after = new Chess(c.fen());
  return { before: new Chess(before), after, move, mover, reply, sansAfter: sans.slice(ply - 1) };
}

const material = (c, color) => c.board().flat().filter((p) => p && p.color === color).reduce((n, p) => n + PIECE_VALUE[p.type], 0);

describe('los comentarios de las partidas históricas se cumplen en el tablero', () => {
  for (const h of WORLD_HIGHLIGHTS) {
    test(`${h.id}: hay comentarios, bien ordenados, breves y con hechos que comprobar`, () => {
      assert.ok(h.notes?.length >= 5, 'al menos 5 comentarios por partida');
      const plies = h.notes.map((n) => n.ply);
      assert.deepEqual(plies, [...plies].sort((a, b) => a - b), 'por orden de jugada');
      assert.equal(new Set(plies).size, plies.length, 'una nota por jugada');
      assert.ok(plies.includes(h.ply), 'la jugada destacada tiene su comentario');
      for (const n of h.notes) {
        assert.ok(n.text.length > 40 && n.text.length <= 220, `ply ${n.ply}: el texto debe ser breve (entre 40 y 220 caracteres)`);
        assert.ok(n.tag && n.tag.length <= 32, `ply ${n.ply}: falta la etiqueta`);
        assert.ok(n.facts && Object.keys(n.facts).length >= 1, `ply ${n.ply}: una nota sin hechos verificables no se publica`);
        assert.ok(n.ply >= 1 && n.ply <= h.san.split(' ').length);
      }
    });

    test(`${h.id}: cada hecho de cada comentario es cierto en la partida`, () => {
      for (const n of h.notes) {
        const where = `${h.id} ply ${n.ply}`;
        const { before, after, move, mover, reply, sansAfter } = at_ply(h, n.ply);
        const f = n.facts;
        if (f.check) assert.match(move.san, /[+#]/, `${where}: dice «jaque» y la jugada ${move.san} no lo da`);
        if (f.mate) assert.ok(after.isCheckmate(), `${where}: dice «mate» y no lo es`);
        if (f.capture) assert.equal(move.captured, f.capture, `${where}: dice que captura «${f.capture}» y captura «${move.captured}»`);
        if (f.forced) assert.equal(after.moves().length, 1, `${where}: dice «única jugada legal» y hay ${after.moves().length}`);
        if (f.replies) assert.equal(after.moves().length, f.replies, `${where}: dice que hay ${f.replies} respuestas legales y hay ${after.moves().length}`);
        if (f.mateNext) assert.ok(sansAfter[2]?.endsWith('#'), `${where}: dice «mate en la jugada siguiente» y la partida sigue con ${sansAfter.slice(0, 3).join(' ')}`);
        if (f.checksTo) {
          // Todas las jugadas de quien mueve, desde la siguiente suya hasta `checksTo`, dan jaque (o mate).
          const sans = h.san.split(' ');
          for (let p = n.ply + 2; p <= f.checksTo; p += 2) assert.match(sans[p - 1], /[+#]/, `${where}: la jugada ${p} (${sans[p - 1]}) no es jaque`);
          assert.match(sans[f.checksTo - 1], /#/, `${where}: la jugada ${f.checksTo} debería ser mate`);
        }
        if (f.gives) {
          // Material neto que pierde quien mueve tras la respuesta rival (lo que realmente «entrega»).
          const start = material(before, mover) - material(before, mover === 'w' ? 'b' : 'w');
          const end = reply ? (() => { const c = new Chess(after.fen()); c.move(reply.san); return material(c, mover) - material(c, mover === 'w' ? 'b' : 'w'); })() : start;
          assert.ok(start - end >= f.gives, `${where}: dice que entrega ${f.gives} y entrega ${start - end}`);
        }
        if (f.attacks) {
          const cov = covered(after, f.attacks.by);
          assert.ok(after.get(f.attacks.by)?.color === mover, `${where}: en ${f.attacks.by} no hay una pieza de quien mueve`);
          for (const sq of f.attacks.squares) assert.ok(cov.includes(sq), `${where}: ${f.attacks.by} no cubre ${sq}`);
        }
        if (f.defends) {
          const p = after.get(f.defends.square);
          assert.ok(p && p.color === mover, `${where}: en ${f.defends.square} no hay una pieza propia que proteger`);
          assert.ok(covered(after, f.defends.by).includes(f.defends.square), `${where}: ${f.defends.by} no protege ${f.defends.square}`);
        }
        if (f.pin) {
          const { from, pinned, behind } = f.pin;
          const [a, b, c] = [after.get(from), after.get(pinned), after.get(behind)];
          assert.ok(a && b && c, `${where}: faltan piezas en la clavada`);
          assert.ok(a.color === mover && b.color !== mover && c.color !== mover, `${where}: colores de la clavada`);
          assert.ok(['b', 'r', 'q'].includes(a.type), `${where}: solo clavan alfiles, torres y damas`);
          const ray = between(from, behind);
          assert.ok(ray?.includes(pinned), `${where}: ${pinned} no está entre ${from} y ${behind}`);
          assert.ok(ray.filter((s) => s !== pinned).every((s) => !after.get(s)), `${where}: hay otra pieza en la línea de la clavada`);
          const diag = Math.abs(at(from)[0] - at(behind)[0]) === Math.abs(at(from)[1] - at(behind)[1]);
          assert.ok(a.type === 'q' || (a.type === 'b') === diag, `${where}: la pieza no puede clavar por esa línea`);
          assert.ok(c.type === 'k' || PIECE_VALUE[c.type] > PIECE_VALUE[b.type], `${where}: la pieza de detrás debe valer más que la clavada`);
        }
        if (f.clear) assert.ok(between(f.clear.from, f.clear.to).every((s) => !after.get(s)), `${where}: la línea ${f.clear.from}-${f.clear.to} no está libre`);
        if (f.canCapture) {
          for (const sq of f.canCapture) assert.ok(after.moves({ verbose: true }).some((m) => m.to === sq && m.captured), `${where}: no se puede capturar en ${sq}`);
        }
        if (f.material) {
          for (const [color, want] of Object.entries(f.material)) {
            const have = { q: 0, r: 0, b: 0, n: 0 };
            after.board().flat().filter((p) => p && p.color === color[0]).forEach((p) => p.type in have && (have[p.type] += 1));
            for (const [t, k] of Object.entries(want)) assert.equal(have[t], k, `${where}: material ${color} ${t}: hay ${have[t]} y la nota dice ${k}`);
          }
        }
      }
    });
  }

  test('las comprobaciones detectan comentarios falsos (mutación)', () => {
    const h = WORLD_HIGHLIGHTS[0];
    const { after, move } = at_ply(h, 31);
    assert.match(move.san, /\+/);
    assert.notEqual(move.captured, 'q', 'Qb8+ no captura una dama: un comentario que lo dijera sería falso');
    assert.notEqual(after.moves().length, 2);
    const wrong = at_ply(h, 13);
    assert.ok(!covered(wrong.after, 'b3').includes('h7'), 'la dama de b3 no cubre h7');
    assert.equal(between('g5', 'e7').length, 1);
    assert.equal(between('a1', 'b3'), null, 'casillas no alineadas');
  });
});
