// Tablero 2D ligero para los highlights (no juega: solo enseña posiciones y reproduce una secuencia ya conocida).
// Usa las mismas clases de pieza y de skin que el tablero de partida, así que los cosméticos equipados se ven igual.
import { Chess } from '../vendor/chess.js';
import { GLYPH } from './data.js';
import { state } from './store.js';
import { esc, VS } from './ui.js';

const FILES = 'abcdefgh';
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');
const uciOf = (m) => `${m.from}${m.to}${m.promotion ?? ''}`;

/** HTML de una posición. `mark`: { from, to } de la última jugada; `key`: true si esa jugada es la destacada. */
export function boardHtml(fen, { flip = false, mark = null, key = false, coords = true, label = '' } = {}) {
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
  return `<div class="mb ${skins}" role="img" aria-label="${esc(label || 'Posición de ajedrez')}">${html}</div>`;
}

/**
 * Reproductor de una secuencia sobre un tablero 2D. `sans`: la partida entera en SAN; muestra desde `from` hasta `to`
 * (índices de jugada, 0 = posición inicial) y marca la jugada `key` (1 = primera jugada de las blancas).
 */
export function createPlayer(root, { sans, from, to, key, flip = false, label = '', onChange = null }) {
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
  const board = root.querySelector('[data-mb="board"]');
  const notes = root.querySelector('[data-mb="notes"]');

  const paint = () => {
    const m = i > 0 ? moves[i - 1] : null;
    board.innerHTML = boardHtml(fens[i], { flip, mark: m && { from: m.from, to: m.to }, key: i === key, label });
    if (notes) {
      let out = '';
      for (let k = Math.max(1, from + 1); k <= to; k += 1) {
        const num = k % 2 === 1 ? `<em>${Math.ceil(k / 2)}.</em>` : k === Math.max(1, from + 1) ? `<em>${Math.ceil(k / 2)}…</em>` : '';
        out += `${num}<button type="button" class="mb-san${k === i ? ' on' : ''}${k === key ? ' key' : ''}" data-mb-ply="${k}" ${k === i ? 'aria-current="true"' : ''}>${esc(moves[k - 1].san)}</button>`;
      }
      notes.innerHTML = out;
    }
    root.querySelector('[data-mb="play"]')?.setAttribute('aria-pressed', String(!!timer));
    const playBtn = root.querySelector('[data-mb="play"]');
    if (playBtn) playBtn.textContent = timer ? '❚❚' : '▶';
    onChange?.(i);
  };

  // Mueve la pieza deslizándola hasta su casilla y después repinta la posición nueva.
  const animateTo = (next) => {
    const m = moves[next - 1];
    const el = board.querySelector(`[data-sq="${m.from}"] .piece`);
    const target = board.querySelector(`[data-sq="${m.to}"]`);
    if (!el || !target || reduced()) {
      i = next;
      return paint();
    }
    const a = el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    el.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1)';
    el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
    el.style.zIndex = '2';
    setTimeout(() => {
      i = next;
      paint();
    }, 190);
    return undefined;
  };

  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const step = (n) => {
    const next = Math.max(from, Math.min(to, n));
    if (next === i + 1) animateTo(next);
    else {
      i = next;
      paint();
    }
  };
  const play = () => {
    if (i >= to) i = from;
    const tick = () => {
      if (!root.isConnected) return stop();
      if (i >= to) {
        stop();
        return paint();
      }
      step(i + 1);
      timer = setTimeout(tick, i + 1 === key ? 1500 : 900);
      return undefined;
    };
    timer = setTimeout(tick, 350);
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
    <button type="button" class="btn ghost sm" data-mb="key">★ ${esc(keyLabel)}</button>
  </div>`;
