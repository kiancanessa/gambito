// Clip 2D de un momento destacado (PROMPT 08, primera versión): una secuencia de jugadas animada sobre un canvas, con los nombres
// públicos, el resultado, el contexto del torneo y la marca de CHECKPOINT. Se ejecuta en el navegador de quien lo mira: no se genera
// ningún vídeo en el servidor. Exportar a vídeo (MediaRecorder sobre este mismo canvas) queda como mejora posterior.
import { Chess } from '../vendor/chess.js';
import { tcName } from './replay.js';
import { $, choice, esc } from './ui.js';

const W = 540;
const H = 700;
const BOARD = 480;
const OX = (W - BOARD) / 2;
const OY = 150;
const SQ = BOARD / 8;
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const COLORS = { bg: '#0b0f17', light: '#33445f', dark: '#1b2638', cyan: '#22e1ff', text: '#e9eef7', muted: '#8a96ab', white: '#f4f7ff', black: '#0b0f17' };
const SLIDE_MS = 520;
const HOLD_MS = 620;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const clipRange = (moment, total) => (moment ? { from: Math.max(0, moment.ply - 4), to: Math.min(total, moment.ply + 1) } : { from: Math.max(0, total - 6), to: total });

function contextLine(d) {
  if (d.tournament) return `🏆 ${d.tournament.name}${d.tournament.roundLabel ? ` · ${d.tournament.roundLabel}` : ''}`;
  return `${d.rated ? 'Clasificatoria' : 'Partida amistosa'} · ${tcName(d.tc)}`;
}

export function resultLine(d) {
  if (d.reason === 'abortada') return 'Partida abortada';
  if (!d.winner) return `Tablas · ${d.reason}`;
  return `Gana ${d.winner === 'w' ? d.white.name : d.black.name} · ${d.reason}`;
}

function drawFrame(g, d, chess, caption, flip, anim, mark) {
  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, W, H);
  // Marca y cabecera
  g.fillStyle = COLORS.cyan;
  g.save();
  g.translate(34, 34);
  g.rotate(Math.PI / 4);
  g.fillRect(-9, -9, 18, 18);
  g.restore();
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = '700 20px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.text;
  g.fillText('CHECKPOINT', 56, 34);
  g.font = '600 15px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.cyan;
  g.textAlign = 'right';
  g.fillText(contextLine(d), W - 24, 34);
  g.textAlign = 'center';
  g.font = '700 24px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.text;
  g.fillText(`${d.white.name}  vs  ${d.black.name}`, W / 2, 86, W - 40);
  g.font = '500 15px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.muted;
  g.fillText(resultLine(d), W / 2, 118, W - 40);

  // Tablero
  const pos = (sq) => {
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]) - 1;
    return { x: OX + (flip ? 7 - f : f) * SQ, y: OY + (flip ? r : 7 - r) * SQ };
  };
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      g.fillStyle = (r + f) % 2 === 0 ? COLORS.light : COLORS.dark;
      g.fillRect(OX + f * SQ, OY + r * SQ, SQ, SQ);
    }
  }
  if (mark) {
    g.fillStyle = 'rgba(34, 225, 255, 0.28)';
    for (const sq of [mark.from, mark.to]) {
      const p = pos(sq);
      g.fillRect(p.x, p.y, SQ, SQ);
    }
  }
  const piece = (p, x, y) => {
    g.font = `${Math.round(SQ * 0.82)}px "Segoe UI Symbol", "Noto Sans Symbols 2", serif`;
    g.textAlign = 'center';
    g.lineWidth = 2;
    g.strokeStyle = p.color === 'w' ? COLORS.black : COLORS.white;
    g.fillStyle = p.color === 'w' ? COLORS.white : COLORS.black;
    const t = `${GLYPH[p.type]}︎`;
    g.strokeText(t, x + SQ / 2, y + SQ / 2 + 3);
    g.fillText(t, x + SQ / 2, y + SQ / 2 + 3);
  };
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || (anim && (p.square === anim.to || p.square === anim.from))) continue;
      const q = pos(p.square);
      piece(p, q.x, q.y);
    }
  }
  if (anim) {
    const a = pos(anim.from);
    const b = pos(anim.to);
    const e = 1 - (1 - anim.t) ** 3; // sale rápido y frena al llegar
    piece(anim.piece, a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e);
  }

  // Pie
  g.textAlign = 'center';
  g.font = '700 22px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.cyan;
  g.fillText(caption.title, W / 2, OY + BOARD + 36, W - 40);
  g.font = '500 16px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.muted;
  g.fillText(caption.sub, W / 2, OY + BOARD + 62, W - 40);
}

/**
 * Abre el clip. `moments`: los destacados (cada uno con `ply`, `title`, `detail`). `onLink(ply)` devuelve el enlace a esa jugada o null.
 * Resuelve cuando se cierra. Lo que se anima son las jugadas ya guardadas: no hay nada editable.
 */
export async function openClip({ data, moments, onOpenAt, onCopyLink }) {
  const total = data.moves.length;
  const shown = moments.slice(0, 5);
  let current = shown[0] ?? null;
  const chips = shown.map((m, k) => `<button class="chip" data-clip="${k}">${esc(m.title)} · ${Math.ceil(m.ply / 2)}</button>`).join('');
  const done = choice(
    `<h3>🎞 Clip 2D</h3>
     <div class="clip-wrap"><canvas id="clipCanvas" width="${W}" height="${H}" aria-label="Animación de las jugadas destacadas"></canvas></div>
     ${chips ? `<div class="clip-chips" role="group" aria-label="Momentos">${chips}<button class="chip" data-clip="end">Final</button></div>` : ''}
     <div class="share-options">
       <button class="btn primary" data-clip="replay">▶ Repetir</button>
       <button class="btn" data-clip="link">🔗 Copiar enlace</button>
       <button class="btn" data-clip="open">Ver en la repetición</button>
       <button class="btn" data-choice="close">Cerrar</button>
     </div>
     <p class="muted clip-note">Es una animación en tu navegador; no se sube nada. La exportación a vídeo llegará más adelante.</p>`,
    'clip-modal',
  );
  const canvas = $('#clipCanvas');
  const g = canvas.getContext('2d');
  const flip = data.you === 'b';
  let run = 0;

  const play = async (range, caption) => {
    const id = ++run;
    const chess = new Chess();
    for (const u of data.moves.slice(0, range.from)) chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    drawFrame(g, data, chess, caption(range.from), flip, null, null);
    await new Promise((r) => setTimeout(r, 450));
    for (let k = range.from; k < range.to; k += 1) {
      if (id !== run) return;
      const u = data.moves[k];
      const from = u.slice(0, 2);
      const mover = chess.get(from);
      const mv = chess.move({ from, to: u.slice(2, 4), promotion: u[4] });
      const before = new Chess(mv.before);
      const ms = reduced() ? 0 : SLIDE_MS;
      const start = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          if (id !== run) return resolve();
          const t = ms ? Math.min(1, (now - start) / ms) : 1;
          drawFrame(g, data, before, caption(k + 1), flip, { piece: mover, from, to: mv.to, t }, { from: mv.from, to: mv.to });
          return t < 1 ? requestAnimationFrame(step) : resolve();
        };
        requestAnimationFrame(step);
      });
      if (id !== run) return;
      drawFrame(g, data, chess, caption(k + 1), flip, null, { from: mv.from, to: mv.to });
      await new Promise((r) => setTimeout(r, reduced() ? 300 : HOLD_MS));
    }
  };

  const start = () => {
    const range = clipRange(current, total);
    const title = current?.title ?? 'Final de la partida';
    const san = (ply) => {
      const c = new Chess();
      let last = '';
      data.moves.slice(0, ply).forEach((u) => (last = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san));
      return last;
    };
    const caption = (ply) => ({ title, sub: ply ? `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '...'} ${san(ply)}` : 'Posición inicial' });
    return play(range, caption);
  };

  const modal = canvas.closest('.modal-card');
  const off = new AbortController();
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-clip]');
    if (!b) return;
    const a = b.dataset.clip;
    if (a === 'replay') start();
    else if (a === 'end') {
      current = null;
      start();
    } else if (a === 'link') onCopyLink?.(current?.ply ?? total);
    else if (a === 'open') {
      run += 1;
      document.querySelector('[data-choice="close"]')?.click();
      onOpenAt?.(current?.ply ?? total);
    } else if (shown[Number(a)]) {
      current = shown[Number(a)];
      start();
    }
  }, { signal: off.signal });
  start();
  await done;
  run += 1;
  off.abort();
}
