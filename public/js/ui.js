// Utilidades de interfaz compartidas por todos los módulos (sin dependencias circulares con main.js).
import { GLYPH } from './data.js';
import { burst } from './fx.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const VS = '︎'; // fuerza glifo de texto en las piezas
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Todo lo que viene del servidor o de otros jugadores se escapa antes de entrar en innerHTML.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Registro de funciones que main.js rellena al arrancar (evita importaciones circulares).
export const app = {
  screen: 'home',
  go: async () => {},
  beginGame: async () => {},
  stage: null,
  engine: null,
  game: null,
  refreshHome: () => {},
};

const modal = $('#modal');
const modalCard = $('#modalCard');

// Muestra un modal y resuelve con el `data-choice` del botón pulsado.
export function choice(html, cls = '') {
  return new Promise((resolve) => {
    modalCard.className = `modal-card ${cls}`;
    modalCard.innerHTML = html;
    modal.hidden = false;
    const onClick = (e) => {
      const b = e.target.closest('[data-choice]');
      if (!b) return;
      modalCard.removeEventListener('click', onClick);
      modal.hidden = true;
      resolve(b.dataset.choice);
    };
    modalCard.addEventListener('click', onClick);
  });
}

export const closeModal = () => {
  modal.hidden = true;
};

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export const avatar = (glyph, color) => `<div class="avatar" style="--c:${esc(color)}">${GLYPH[glyph]}${VS}</div>`;

export function celebrate() {
  const layer = $('#celebrate');
  const w = window.innerWidth;
  [0.2, 0.5, 0.8].forEach((fx, i) => {
    setTimeout(() => burst(layer, w * fx, window.innerHeight * 0.35, 'confetti', 2.6), i * 220);
  });
}

export const stars = (n) => [1, 2, 3].map((i) => `<span class="${i <= n ? 'on' : ''}">★</span>`).join('');

// Reloj de partida: m:ss (con décimas por debajo de 10 s).
export function fmtClock(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `0:0${s.toFixed(1)}`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  }
}

export const confirmModal = (title, text, yes = 'Aceptar', no = 'Cancelar') =>
  choice(`<h3>${title}</h3><p>${text}</p>
    <div class="modal-actions"><button class="btn" data-choice="no">${no}</button><button class="btn danger" data-choice="yes">${yes}</button></div>`).then((r) => r === 'yes');

export function showScreen(name) {
  app.screen = name;
  $$('.screen').forEach((s) => (s.hidden = s.id !== `screen-${name}`));
  window.scrollTo(0, 0);
}
