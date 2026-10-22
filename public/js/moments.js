// Momentos destacados de una partida (PROMPT 08). Módulo puro: recibe datos, no toca el DOM ni el motor, y se prueba en Node.
//
// Dos fuentes, y cada momento dice cuál usó (`source`):
//   · 'moves'  → se deduce solo de las jugadas guardadas (mate, coronación, victoria de torneo, material cedido).
//   · 'engine' → necesita la evaluación de Stockfish de cada posición. Con ella se separan los errores de los sacrificios de verdad.
// Una captura nunca basta para llamar «brillante» a una jugada. Los umbrales están aquí, con nombre, para poder auditarlos.

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME = { p: 'peón', n: 'caballo', b: 'alfil', r: 'torre', q: 'dama', k: 'rey' };

// Pérdida de probabilidad de ganar (puntos porcentuales) que hace una jugada: mismas bandas que usa Lichess.
export const THRESHOLDS = {
  inaccuracy: 10,
  mistake: 20,
  blunder: 30,
  sacrificeMaterial: 2, // material neto cedido (en peones) tras la respuesta rival
  brilliantLoss: 3, // una jugada brillante no puede empeorar la posición más de esto
  brilliantMaxWinBefore: 85, // ... ni ocurrir cuando la partida ya estaba ganada
  brilliantMinWinAfter: 40, // ... y debe dejar al menos una posición jugable
  brilliantGain: 5, // ... y dos jugadas después la ventaja debe haber crecido
  opportunityWin: 65, // tras un error rival, aprovecharlo es llegar al menos aquí
  missedWinBefore: 60, // oportunidad perdida: se tenía esto y se tiró...
  turnaroundLow: 25, // remontada: de esta probabilidad...
  turnaroundHigh: 60, // ... a esta
};

const MATE_CP = 10_000;

/** Evaluación del motor → centipeones desde el punto de vista de las blancas. `v` es `{cp}` o `{mate}` desde quien mueve. */
export function whiteCp(v, turn) {
  if (!v) return 0;
  const sign = turn === 'w' ? 1 : -1;
  if (typeof v.mate === 'number') return sign * (v.mate === 0 ? -MATE_CP : Math.sign(v.mate) * (MATE_CP - Math.abs(v.mate) * 10));
  return sign * (v.cp ?? 0);
}

/** Probabilidad de ganar (0-100) para las blancas con una evaluación en centipeones. */
export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-MATE_CP, Math.min(MATE_CP, cp)))) - 1);

const povWin = (cp, color) => (color === 'w' ? winPct(cp) : 100 - winPct(cp));

/** Material (en peones) de un FEN: blancas menos negras. */
export function materialBalance(fen) {
  let bal = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = PIECE_VALUE[ch.toLowerCase()];
    if (v) bal += ch === ch.toUpperCase() ? v : -v;
  }
  return bal;
}

const pov = (balance, color) => (color === 'w' ? balance : -balance);

/** «12. Cf3» / «12... Cf6» para la jugada número `ply` (1 = primera de las blancas). */
export const moveLabel = (ply, san) => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '...'} ${san}`;

const KIND_SCORE = { 'champion': 100, 'tournament-win': 90, 'checkmate': 95, 'brilliant': 85, 'blunder': 70, 'turnaround': 65, 'opportunity': 60, 'missed': 58, 'mistake': 50, 'sacrifice': 55, 'promotion': 45, 'sacrifice-candidate': 30, 'inaccuracy': 20 };

const make = (m) => ({ score: KIND_SCORE[m.kind] ?? 10, ...m, id: `${m.kind}-${m.ply}` });

/**
 * Detecta lo que se puede afirmar solo con las jugadas.
 * `plies[i]`: `{ san, color, piece, captured?, promotion?, before, after }` (lo que da `chess.history({ verbose: true })`).
 * `ctx`: `{ winner, tournament? }` con `tournament = { name, roundLabel?, final?, champion? }`.
 */
export function structuralMoments(plies, ctx = {}) {
  const out = [];
  const last = plies.length;
  plies.forEach((m, i) => {
    const ply = i + 1;
    if (/#$/.test(m.san)) out.push(make({ kind: 'checkmate', ply, side: m.color, tone: 'epic', source: 'moves', title: 'Jaque mate', detail: `${moveLabel(ply, m.san)} termina la partida.` }));
    if (m.promotion) {
      const to = PIECE_NAME[m.promotion];
      out.push(make({ kind: 'promotion', ply, side: m.color, tone: 'good', source: 'moves', title: `Coronación${to ? ` a ${to}` : ''}`, detail: `${moveLabel(ply, m.san)}${m.captured ? ` (capturando ${PIECE_NAME[m.captured] ?? 'pieza'})` : ''}.` }));
    }
    // Material cedido y no recuperado: candidato a sacrificio. Sin motor no se sabe si fue genio o descuido, y así se dice.
    const drop = sacrificeDrop(plies, i);
    if (drop >= THRESHOLDS.sacrificeMaterial && !m.promotion) {
      out.push(make({ kind: 'sacrifice-candidate', ply, side: m.color, tone: 'info', source: 'moves', drop, title: 'Material cedido', detail: `${moveLabel(ply, m.san)} deja ${drop} punto${drop > 1 ? 's' : ''} de material sin recuperar enseguida. Analiza la partida para saber si fue un sacrificio o un error.` }));
    }
  });
  if (ctx.tournament && ctx.winner && last > 0) {
    const t = ctx.tournament;
    const label = `${t.name}${t.roundLabel ? ` · ${t.roundLabel}` : ''}`;
    out.push(make({ kind: t.champion ? 'champion' : 'tournament-win', ply: last, side: ctx.winner, tone: 'epic', source: 'moves', title: t.champion ? 'Campeón del torneo' : 'Victoria en torneo', detail: label }));
  }
  return out;
}

// Material neto que pierde quien mueve en `i` tras la respuesta rival, si dos jugadas más tarde sigue sin recuperarlo.
function sacrificeDrop(plies, i) {
  const m = plies[i];
  const reply = plies[i + 1];
  const later = plies[i + 3];
  if (!reply || !later) return 0;
  const before = pov(materialBalance(m.before), m.color);
  const afterReply = pov(materialBalance(reply.after), m.color);
  const afterLater = pov(materialBalance(later.after), m.color);
  const drop = before - afterReply;
  return drop >= THRESHOLDS.sacrificeMaterial && before - afterLater >= THRESHOLDS.sacrificeMaterial ? drop : 0;
}

/**
 * Momentos que dependen de la evaluación. `evals[k]` es la evaluación (blancas, en centipeones) de la posición tras `k` jugadas,
 * así que `evals.length === plies.length + 1`. `best[k]` es la mejor jugada UCI del motor en esa posición (opcional).
 */
export function engineMoments(plies, evals, best = []) {
  const out = [];
  if (evals.length !== plies.length + 1) return out;
  const loss = (i) => povWin(evals[i], plies[i].color) - povWin(evals[i + 1], plies[i].color); // jugada i (0-based)
  const prevWasError = new Map();
  plies.forEach((m, i) => {
    const ply = i + 1;
    const l = loss(i);
    const winBefore = povWin(evals[i], m.color);
    const winAfter = povWin(evals[i + 1], m.color);
    const hint = best[i] ? { bestUci: best[i] } : {};
    const swing = Math.round(l);
    if (l >= THRESHOLDS.blunder) out.push(make({ kind: 'blunder', ply, side: m.color, tone: 'bad', source: 'engine', swing, ...hint, title: 'Error grave', detail: `${moveLabel(ply, m.san)} cambia la evaluación en ${swing} puntos de probabilidad de ganar.` }));
    else if (l >= THRESHOLDS.mistake) out.push(make({ kind: 'mistake', ply, side: m.color, tone: 'bad', source: 'engine', swing, ...hint, title: 'Error', detail: `${moveLabel(ply, m.san)} empeora la posición (${swing} puntos).` }));
    else if (l >= THRESHOLDS.inaccuracy) out.push(make({ kind: 'inaccuracy', ply, side: m.color, tone: 'info', source: 'engine', swing, ...hint, title: 'Imprecisión', detail: `${moveLabel(ply, m.san)} no era lo más fuerte.` }));
    if (l >= THRESHOLDS.mistake) prevWasError.set(ply, true);

    // Oportunidad: el rival se equivocó en la jugada anterior y esta la aprovecha; o se tenía y se dejó escapar.
    if (prevWasError.get(ply - 1)) {
      if (l <= 5 && winAfter >= THRESHOLDS.opportunityWin) out.push(make({ kind: 'opportunity', ply, side: m.color, tone: 'good', source: 'engine', title: 'Error aprovechado', detail: `${moveLabel(ply, m.san)} castiga el error anterior y mantiene la ventaja.` }));
      else if (l >= THRESHOLDS.mistake && winBefore >= THRESHOLDS.missedWinBefore) out.push(make({ kind: 'missed', ply, side: m.color, tone: 'info', source: 'engine', ...hint, title: 'Oportunidad perdida', detail: `${moveLabel(ply, m.san)} dejó escapar una ventaja clara.` }));
    }

    // Sacrificio de verdad: cede material, no empeora la posición, no ocurre con la partida ya ganada y la ventaja crece después.
    const drop = sacrificeDrop(plies, i);
    if (drop >= THRESHOLDS.sacrificeMaterial && l <= THRESHOLDS.brilliantLoss && winAfter >= THRESHOLDS.brilliantMinWinAfter && winBefore <= THRESHOLDS.brilliantMaxWinBefore) {
      const later = povWin(evals[Math.min(i + 3, plies.length)], m.color);
      const grows = later >= winBefore + THRESHOLDS.brilliantGain;
      out.push(make({ kind: grows ? 'brilliant' : 'sacrifice', ply, side: m.color, tone: 'epic', source: 'engine', drop, title: grows ? 'Sacrificio brillante' : 'Sacrificio sólido', detail: `${moveLabel(ply, m.san)} cede ${drop} punto${drop > 1 ? 's' : ''} de material y el motor confirma que ${grows ? 'la ventaja crece' : 'la posición se mantiene'}.` }));
    }
  });

  // Remontada: primera vez que quien iba claramente perdiendo pasa a ir claramente ganando.
  for (const color of ['w', 'b']) {
    let low = -1;
    for (let k = 0; k < evals.length; k += 1) {
      const w = povWin(evals[k], color);
      if (low < 0 && w <= THRESHOLDS.turnaroundLow) low = k;
      if (low >= 0 && w >= THRESHOLDS.turnaroundHigh && k > 0) {
        const ply = k;
        out.push(make({ kind: 'turnaround', ply, side: color, tone: 'epic', source: 'engine', title: 'Remontada', detail: `${color === 'w' ? 'Las blancas' : 'Las negras'} pasan de estar mal a estar claramente mejor.` }));
        break;
      }
    }
  }
  return out;
}

/** Une las dos fuentes y las devuelve por orden de jugada. Con análisis, el motor manda sobre las sospechas por material. */
export function mergeMoments(structural, engine = []) {
  const analysed = engine.length > 0;
  const byPly = new Map();
  for (const m of [...structural, ...engine]) {
    // Con análisis, «material cedido» ya no se muestra: el motor lo confirma como sacrificio, lo marca como error o era un cambio normal.
    if (analysed && m.kind === 'sacrifice-candidate') continue;
    const list = byPly.get(m.ply) ?? [];
    list.push(m);
    byPly.set(m.ply, list);
  }
  return [...byPly.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, list]) => list.sort((a, b) => b.score - a.score));
}

/** Los `n` momentos con más peso, un máximo de uno por jugada, por orden de partida. */
export function topMoments(moments, n = 5) {
  const seen = new Set();
  const best = [...moments]
    .sort((a, b) => b.score - a.score)
    .filter((m) => (seen.has(m.ply) ? false : (seen.add(m.ply), true)))
    .filter((m) => m.kind !== 'inaccuracy')
    .slice(0, n);
  return best.sort((a, b) => a.ply - b.ply);
}

/** Precisión estimada por bando (0-100) y recuento de errores a partir de las evaluaciones. */
export function summarize(plies, evals) {
  const out = { w: { n: 0, loss: 0, inaccuracies: 0, mistakes: 0, blunders: 0 }, b: { n: 0, loss: 0, inaccuracies: 0, mistakes: 0, blunders: 0 } };
  if (evals.length !== plies.length + 1) return null;
  plies.forEach((m, i) => {
    const l = Math.max(0, povWin(evals[i], m.color) - povWin(evals[i + 1], m.color));
    const s = out[m.color];
    s.n += 1;
    s.loss += l;
    if (l >= THRESHOLDS.blunder) s.blunders += 1;
    else if (l >= THRESHOLDS.mistake) s.mistakes += 1;
    else if (l >= THRESHOLDS.inaccuracy) s.inaccuracies += 1;
  });
  const acc = (s) => (s.n ? Math.round(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * (s.loss / s.n)) - 3.1669))) : null);
  return { w: { ...out.w, accuracy: acc(out.w) }, b: { ...out.b, accuracy: acc(out.b) } };
}
