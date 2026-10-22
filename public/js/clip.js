// Clip 2D de un momento destacado: una secuencia de jugadas animada sobre un canvas, con los nombres públicos, el resultado,
// el contexto del torneo y la marca de CHECKPOINT. Todo ocurre en el navegador de quien lo mira; no se genera nada en el servidor.
// El mismo dibujo sirve para exportar un vídeo WebM (MediaRecorder) y para la imagen del tablero de la tarjeta de compartir.
import { Chess } from '../vendor/chess.js';
import { tcName } from './replay.js';
import { $, choice, esc, toast } from './ui.js';

const W = 540;
const H = 700;
const BOARD = 480;
const OX = (W - BOARD) / 2;
const OY = 150;
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const COLORS = { bg: '#080a0e', light: '#e9e4d8', dark: '#8f9aa8', mark: 'rgba(32, 221, 243, 0.32)', cyan: '#20ddf3', text: '#f5f7fa', muted: '#929baa', white: '#f8f9fb', black: '#11151c' };
const SLIDE_MS = 520;
const HOLD_MS = 620;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const applyUci = (c, u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

export const clipRange = (moment, total) => (moment ? { from: Math.max(0, moment.ply - 4), to: Math.min(total, moment.ply + 1) } : { from: Math.max(0, total - 6), to: total });

function contextLine(d) {
  if (d.context) return d.context;
  if (d.historic) return `${d.historic.event}, ${d.historic.year}`;
  if (d.tournament) return `🏆 ${d.tournament.name}${d.tournament.roundLabel ? ` · ${d.tournament.roundLabel}` : ''}`;
  return `${d.rated ? 'Clasificatoria' : 'Partida amistosa'} · ${tcName(d.tc)}`;
}

export function resultLine(d) {
  if (d.resultText) return d.resultText;
  if (d.reason === 'abortada') return 'Partida abortada';
  if (!d.winner) return `Tablas · ${d.reason}`;
  return `Gana ${d.winner === 'w' ? d.white.name : d.black.name} · ${d.reason}`;
}

/** Dibuja un tablero (y una pieza en movimiento, si `anim`) en `g` a partir de (ox, oy) con lado `size`. */
export function drawBoard(g, chess, { ox = 0, oy = 0, size = BOARD, flip = false, anim = null, mark = null } = {}) {
  const sq = size / 8;
  const pos = (s) => {
    const f = s.charCodeAt(0) - 97;
    const r = Number(s[1]) - 1;
    return { x: ox + (flip ? 7 - f : f) * sq, y: oy + (flip ? r : 7 - r) * sq };
  };
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      g.fillStyle = (r + f) % 2 === 0 ? COLORS.light : COLORS.dark;
      g.fillRect(ox + f * sq, oy + r * sq, sq, sq);
    }
  }
  if (mark) {
    g.fillStyle = COLORS.mark;
    for (const s of [mark.from, mark.to]) {
      const p = pos(s);
      g.fillRect(p.x, p.y, sq, sq);
    }
  }
  const piece = (p, x, y) => {
    g.font = `${Math.round(sq * 0.82)}px "Segoe UI Symbol", "Noto Sans Symbols 2", serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(1.5, sq / 30);
    g.strokeStyle = p.color === 'w' ? COLORS.black : COLORS.white;
    g.fillStyle = p.color === 'w' ? COLORS.white : COLORS.black;
    const t = `${GLYPH[p.type]}︎`;
    g.strokeText(t, x + sq / 2, y + sq / 2 + sq * 0.05);
    g.fillText(t, x + sq / 2, y + sq / 2 + sq * 0.05);
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
}

/** Imagen (canvas) de una posición, para la tarjeta de compartir. */
export function boardCanvas(fen, { size = 880, flip = false, mark = null } = {}) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  drawBoard(c.getContext('2d'), new Chess(fen), { size, flip, mark });
  return c;
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
  g.fillStyle = COLORS.muted;
  g.textAlign = 'right';
  g.fillText(contextLine(d), W - 24, 34, W - 220);
  g.textAlign = 'center';
  g.font = '700 24px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.text;
  g.fillText(`${d.white.name}  vs  ${d.black.name}`, W / 2, 86, W - 40);
  g.font = '500 15px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.muted;
  g.fillText(resultLine(d), W / 2, 118, W - 40);
  drawBoard(g, chess, { ox: OX, oy: OY, size: BOARD, flip, anim, mark });
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 22px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.cyan;
  g.fillText(caption.title, W / 2, OY + BOARD + 36, W - 40);
  g.font = '500 16px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = COLORS.muted;
  g.fillText(caption.sub, W / 2, OY + BOARD + 62, W - 40);
}

// Texto bajo el tablero: el título del momento y la jugada que se está viendo.
function captionFor(d, title) {
  const sans = [];
  const c = new Chess(d.fen ?? undefined);
  for (const u of d.moves) sans.push(applyUci(c, u).san);
  return (ply) => ({ title, sub: ply ? `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '...'} ${sans[ply - 1]}` : 'Posición inicial' });
}

// Anima las jugadas [from, to) en el canvas. `alive()` devuelve false para cortar (otra animación empezó o se cerró).
async function animate(g, d, range, caption, flip, alive) {
  const chess = new Chess(d.fen ?? undefined);
  for (const u of d.moves.slice(0, range.from)) applyUci(chess, u);
  drawFrame(g, d, chess, caption(range.from), flip, null, null);
  await wait(450);
  for (let k = range.from; k < range.to; k += 1) {
    if (!alive()) return;
    const u = d.moves[k];
    const from = u.slice(0, 2);
    const mover = chess.get(from);
    const mv = applyUci(chess, u);
    const before = new Chess(mv.before);
    const ms = reduced() ? 0 : SLIDE_MS;
    const start = performance.now();
    await new Promise((resolve) => {
      const step = (now) => {
        if (!alive()) return resolve();
        const t = ms ? Math.min(1, (now - start) / ms) : 1;
        drawFrame(g, d, before, caption(k + 1), flip, { piece: mover, from, to: mv.to, t }, { from: mv.from, to: mv.to });
        return t < 1 ? requestAnimationFrame(step) : resolve();
      };
      requestAnimationFrame(step);
    });
    if (!alive()) return;
    drawFrame(g, d, chess, caption(k + 1), flip, null, { from: mv.from, to: mv.to });
    await wait(reduced() ? 300 : HOLD_MS);
  }
}

/** Graba en WebM las jugadas [from, to) con el mismo dibujo del clip. null si el navegador no puede grabar un canvas. */
export async function recordClipVideo(d, { from, to, title }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  if (!window.MediaRecorder || !canvas.captureStream) return null;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) return null;
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start();
  await animate(canvas.getContext('2d'), d, { from, to }, captionFor(d, title), d.you === 'b', () => true);
  await wait(900);
  rec.stop();
  await stopped;
  return chunks.length ? new Blob(chunks, { type: mime.split(';')[0] }) : null;
}

/**
 * Abre el clip. `moments`: los destacados (cada uno con `ply`, `title`, `detail`). Resuelve cuando se cierra.
 * Lo que se anima son las jugadas ya guardadas: no hay nada editable.
 */
export async function openClip({ data, moments, onOpenAt, onCopyLink }) {
  const total = data.moves.length;
  const shown = moments.slice(0, 5);
  let current = shown[0] ?? null;
  const chips = shown.map((m, k) => `<button class="chip" data-clip="${k}">${esc(m.title)} · ${Math.ceil(m.ply / 2)}</button>`).join('');
  const done = choice(
    `<h3>Clip 2D</h3>
     <div class="clip-wrap"><canvas id="clipCanvas" width="${W}" height="${H}" aria-label="Animación de las jugadas destacadas"></canvas></div>
     ${chips ? `<div class="clip-chips" role="group" aria-label="Momentos">${chips}<button class="chip" data-clip="end">Final</button></div>` : ''}
     <div class="share-options">
       <button class="btn primary" data-clip="replay">▶ Repetir</button>
       <button class="btn" data-clip="video">Descargar vídeo</button>
       ${onCopyLink ? '<button class="btn" data-clip="link">Copiar enlace</button>' : ''}
       <button class="btn" data-clip="open">Ver en la repetición</button>
       <button class="btn ghost" data-choice="close">Cerrar</button>
     </div>
     <p class="muted clip-note">Se dibuja y se graba en tu navegador; no se sube nada.</p>`,
    'clip-modal',
  );
  const canvas = $('#clipCanvas');
  const g = canvas.getContext('2d');
  const flip = data.you === 'b';
  let run = 0;

  const start = () => {
    const id = ++run;
    return animate(g, data, clipRange(current, total), captionFor(data, current?.title ?? 'Final de la partida'), flip, () => id === run);
  };

  const modal = canvas.closest('.modal-card');
  const off = new AbortController();
  modal.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-clip]');
    if (!b) return;
    const a = b.dataset.clip;
    if (a === 'replay') start();
    else if (a === 'end') {
      current = null;
      start();
    } else if (a === 'link') onCopyLink?.(current?.ply ?? total);
    else if (a === 'video') {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      b.textContent = 'Grabando…';
      const range = clipRange(current, total);
      const blob = await recordClipVideo(data, { ...range, title: current?.title ?? 'Final de la partida' }).catch(() => null);
      b.disabled = false;
      b.removeAttribute('aria-busy');
      b.textContent = 'Descargar vídeo';
      if (!blob) return toast('Tu navegador no puede grabar el vídeo');
      const { shareBlob } = await import('./share.js');
      shareBlob(blob, 'checkpoint-clip.webm', 'Un momento de mi partida en CHECKPOINT');
    } else if (a === 'open') {
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
