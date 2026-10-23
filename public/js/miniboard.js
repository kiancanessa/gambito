// Tablero 2D ligero para los highlights (no juega: solo enseña posiciones y reproduce una secuencia ya conocida).
// Usa las mismas clases de pieza y de skin que el tablero de partida, así que los cosméticos equipados se ven igual.
import { Chess } from '../vendor/chess.js';
import { GLYPH, PIECE_NAME } from './data.js';
import { state } from './store.js';
import { esc, VS } from './ui.js';

const FILES = 'abcdefgh';
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');
const uciOf = (m) => `${m.from}${m.to}${m.promotion ?? ''}`;

// Flecha de la última jugada (coordenadas en casillas: el tablero mide 8×8). Acaba un poco antes del centro para no tapar la pieza.
function arrowSvg({ from, to }, flip) {
  const c = (sq) => {
    const f = sq.charCodeAt(0) - 97;
    const rk = Number(sq[1]) - 1;
    return { x: (flip ? 7 - f : f) + 0.5, y: flip ? rk + 0.5 : 7 - rk + 0.5 };
  };
  const a = c(from);
  const b = c(to);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const k = 0.3 / len; // el último tramo lo cubre la punta
  const end = { x: b.x - (b.x - a.x) * k, y: b.y - (b.y - a.y) * k };
  return `<svg class="mb-arrow" viewBox="0 0 8 8" aria-hidden="true"><defs><marker id="mbHead" viewBox="0 0 4 4" refX="2.6" refY="2" markerWidth="1.4" markerHeight="1.4" orient="auto"><path d="M0 0 4 2 0 4z" fill="currentColor"/></marker></defs><line x1="${a.x}" y1="${a.y}" x2="${end.x}" y2="${end.y}" stroke="currentColor" stroke-width=".13" stroke-linecap="round" marker-end="url(#mbHead)"/></svg>`;
}

/** HTML de una posición. `mark`: { from, to } de la última jugada; `key`: true si esa jugada es la destacada; `arrow`: dibuja la jugada. */
export function boardHtml(fen, { flip = false, mark = null, key = false, coords = true, label = '', arrow = false } = {}) {
  const c = new Chess(fen);
  const rows = c.board();
  const check = c.inCheck() ? rows.flat().find((p) => p && p.type === 'k' && p.color === c.turn())?.square : null;
  const mate = c.isCheckmate();
  let html = '';
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      const rr = flip ? 7 - r : r;
      const ff = flip ? 7 - f : f;
      const sq = `${FILES[ff]}${8 - rr}`;
      const p = rows[rr][ff];
      const cls = ['sq', 'mb-sq', (rr + ff) % 2 ? 'dark' : 'light'];
      if (mark && (sq === mark.from || sq === mark.to)) cls.push(key ? 'key' : 'last');
      if (sq === check) cls.push(mate ? 'mate' : 'check');
      const fileLbl = coords && r === 7 ? `<i class="mb-f">${FILES[ff]}</i>` : '';
      const rankLbl = coords && f === 0 ? `<i class="mb-r">${8 - rr}</i>` : '';
      html += `<div class="${cls.join(' ')}" data-sq="${sq}">${rankLbl}${fileLbl}${p ? `<span class="piece ${p.color} t-${p.type}">${GLYPH[p.type]}${VS}</span>` : ''}</div>`;
    }
  }
  const skins = `set-${state.equipped?.set ?? 'classic'} board-${state.equipped?.board ?? 'wood'}`;
  return `<div class="mb ${skins}" role="img" aria-label="${esc(label || 'Posición de ajedrez')}">${html}${arrow && mark ? arrowSvg(mark, flip) : ''}</div>`;
}

const SPEEDS = [1, 1.5, 2, 0.6];
const plain = (m) => `${PIECE_NAME[m.piece]}${m.captured ? ` captura ${PIECE_NAME[m.captured].toLowerCase()}` : ` a ${m.to}`}${m.san.endsWith('#') ? ' · jaque mate' : m.san.includes('+') ? ' · jaque' : ''}`;

/**
 * Reproductor de una secuencia sobre un tablero 2D. `sans`: la partida entera en SAN; muestra desde `from` hasta `to`
 * (índices de jugada, 0 = posición inicial) y marca la jugada `key` (1 = primera jugada de las blancas).
 * `comments`: { [jugada]: { text, tag? } } con la explicación de cada jugada; la reproducción se detiene el tiempo que lleva leerla.
 */
export function createPlayer(root, { sans, from, to, key, flip = false, label = '', comments = {}, onChange = null }) {
  const chess = new Chess();
  const fens = [chess.fen()];
  const moves = [];
  for (const s of sans) {
    const m = chess.move(s);
    moves.push(m);
    fens.push(chess.fen());
  }
  let i = Math.max(from, 0);
  let timer = null;
  let speed = 1;
  let busy = false; // hay una pieza deslizándose
  const board = root.querySelector('[data-mb="board"]');
  const notes = root.querySelector('[data-mb="notes"]');
  const box = root.querySelector('[data-mb="comment"]');

  const commentFor = (k) => {
    if (k <= from) return { kicker: 'Posición de partida', text: 'Pulsa ▶ para ver la secuencia jugada a jugada.' };
    const m = moves[k - 1];
    const c = comments[k];
    const num = `${Math.ceil(k / 2)}${k % 2 ? '.' : '…'} ${m.san}`;
    return { kicker: c?.tag ? `${num} · ${c.tag}` : num, text: c?.text ?? plain(m), key: k === key, explained: !!c };
  };

  const paint = () => {
    const m = i > 0 ? moves[i - 1] : null;
    board.innerHTML = boardHtml(fens[i], { flip, mark: m && { from: m.from, to: m.to }, key: i === key, label, arrow: !!m && i > from });
    if (notes) {
      let out = '';
      for (let k = Math.max(1, from + 1); k <= to; k += 1) {
        const num = k % 2 === 1 ? `<em>${Math.ceil(k / 2)}.</em>` : k === Math.max(1, from + 1) ? `<em>${Math.ceil(k / 2)}…</em>` : '';
        out += `${num}<button type="button" class="mb-san${k === i ? ' on' : ''}${k === key ? ' key' : ''}${comments[k] ? ' has-note' : ''}" data-mb-ply="${k}" ${k === i ? 'aria-current="true"' : ''}>${esc(moves[k - 1].san)}</button>`;
      }
      notes.innerHTML = out;
    }
    if (box) {
      const c = commentFor(i);
      box.className = `mb-comment${c.key ? ' key' : ''}${c.explained ? ' explained' : ''}`;
      box.innerHTML = `${c.kicker ? `<b>${esc(c.kicker)}</b>` : ''}<span>${esc(c.text)}</span>`;
    }
    const playBtn = root.querySelector('[data-mb="play"]');
    if (playBtn) {
      playBtn.setAttribute('aria-pressed', String(!!timer));
      playBtn.textContent = timer ? '❚❚' : '▶';
    }
    const sp = root.querySelector('[data-mb="speed"]');
    if (sp) sp.textContent = `${speed}×`;
    onChange?.(i);
  };

  // Desliza la pieza hasta su casilla (la capturada se desvanece) y luego pinta la posición nueva.
  const animateTo = (next) => {
    const m = moves[next - 1];
    const el = board.querySelector(`[data-sq="${m.from}"] .piece`);
    const target = board.querySelector(`[data-sq="${m.to}"]`);
    if (!el || !target || reduced()) {
      i = next;
      paint();
      return 0;
    }
    const ms = Math.max(140, Math.round(340 / speed));
    const a = el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    busy = true;
    el.style.transition = `transform ${ms}ms cubic-bezier(.3,.7,.2,1)`;
    el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
    el.style.zIndex = '3';
    target.querySelector('.piece')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
    setTimeout(() => {
      busy = false;
      i = next;
      paint();
    }, ms + 10);
    return ms + 10;
  };

  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const step = (n) => {
    const next = Math.max(from, Math.min(to, n));
    if (busy) return 0;
    if (next === i + 1) return animateTo(next);
    i = next;
    paint();
    return 0;
  };
  // Cuánto se queda cada jugada en pantalla: breve si no hay comentario; el tiempo de leerlo si lo hay.
  const dwell = (k) => {
    const c = comments[k];
    const base = c ? Math.min(6000, 1200 + c.text.length * 34) : 650;
    return Math.round((k === key ? base + 600 : base) / speed);
  };
  const play = () => {
    if (i >= to) {
      i = from;
      paint();
    }
    const tick = () => {
      if (!root.isConnected) return stop();
      if (i >= to) {
        stop();
        return paint();
      }
      const slide = step(i + 1);
      timer = setTimeout(tick, slide + dwell(i + 1));
      return undefined;
    };
    timer = setTimeout(tick, 400);
    paint();
  };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mb], [data-mb-ply]');
    if (!b) return;
    if (b.dataset.mbPly) {
      stop();
      return step(Number(b.dataset.mbPly));
    }
    const a = b.dataset.mb;
    if (a === 'play') return timer ? (stop(), paint()) : play();
    if (a === 'speed') {
      speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
      return paint();
    }
    stop();
    if (a === 'restart') return step(from);
    if (a === 'prev') return step(i - 1);
    if (a === 'next') return step(i + 1);
    if (a === 'key') {
      i = key - 1;
      paint();
      return setTimeout(() => step(key), 120);
    }
    return undefined;
  });
  paint();
  return {
    play,
    stop,
    get ply() {
      return i;
    },
    fenAt: (k) => fens[k],
    uci: () => moves.map(uciOf),
    move: (k) => moves[k - 1],
  };
}

/** Controles estándar del reproductor (los mismos en todos los highlights). */
export const playerControls = (keyLabel = 'Ir a la jugada') => `
  <div class="mb-controls" role="group" aria-label="Controles de la reproducción">
    <button type="button" class="icon-ctl" data-mb="restart" aria-label="Reiniciar la secuencia">⟲</button>
    <button type="button" class="icon-ctl" data-mb="prev" aria-label="Jugada anterior">‹</button>
    <button type="button" class="icon-ctl primary" data-mb="play" aria-label="Reproducir o pausar" aria-pressed="false">▶</button>
    <button type="button" class="icon-ctl" data-mb="next" aria-label="Jugada siguiente">›</button>
    <button type="button" class="icon-ctl txt" data-mb="speed" aria-label="Velocidad de reproducción">1×</button>
    <button type="button" class="btn ghost sm" data-mb="key">★ ${esc(keyLabel)}</button>
  </div>
  <p class="mb-comment" data-mb="comment" role="status" aria-live="polite"></p>`;
