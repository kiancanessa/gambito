// Feedback de juego: un único punto de entrada para los acontecimientos importantes.
//  - Durante la partida: avisos discretos (una píldora pequeña), un sonido y, en móviles, una vibración corta.
//  - Resultado, logros y momentos destacados: tarjetas más grandes (las animaciones cinematográficas del resultado
//    viven en los diálogos de fin de partida; aquí solo se anuncian).
// Respeta las preferencias («Avisos de juego», sonido, vibración, movimiento reducido) y nunca bloquea ni retrasa nada.
import { sfx } from './fx.js';
import { buzz, prefs } from './prefs.js';

const KINDS = {
  capture: { icon: '✕', cls: 'capture', sound: null, buzz: 14 },
  check: { icon: '♚', cls: 'check', sound: null, buzz: [18, 40, 18] },
  mate: { icon: '♚', cls: 'check', sound: null, buzz: [30, 50, 60] },
  promotion: { icon: '♛', cls: 'promo', sound: null, buzz: [12, 30, 12] },
  mission: { icon: '🎯', cls: 'mission', sound: 'coin', buzz: [14, 40, 14], card: true },
  record: { icon: '🏅', cls: 'record', sound: 'record', buzz: [20, 50, 20, 50, 40], card: true },
  advance: { icon: '🏆', cls: 'advance', sound: 'advance', buzz: [20, 40, 20], card: true },
  reconnected: { icon: '⇄', cls: 'info', sound: null, buzz: 0 },
  lost: { icon: '⚠', cls: 'warn', sound: null, buzz: 0 },
};

let stack = null;
const host = () => {
  if (stack) return stack;
  stack = document.createElement('div');
  stack.className = 'fb-stack';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  document.body.append(stack);
  return stack;
};

/**
 * @param {keyof KINDS} kind
 * @param {{ title?: string, text?: string, ms?: number, silent?: boolean }} [o]
 */
export function feedback(kind, { title = '', text = '', ms, silent = false, pop = true } = {}) {
  const k = KINDS[kind];
  if (!k) return;
  if (!silent) {
    if (k.sound) sfx[k.sound]?.();
    if (k.buzz) buzz(k.buzz);
  }
  // Las tarjetas de logro se muestran siempre; los avisos discretos se pueden apagar en preferencias.
  if (!pop || (!k.card && !prefs.popups)) return;
  const el = document.createElement('div');
  el.className = `fb-item ${k.card ? 'fb-card' : 'fb-pop'} ${k.cls}`;
  el.innerHTML = `<i aria-hidden="true">${k.icon}</i><span>${title ? `<b></b>` : ''}${text ? '<small></small>' : ''}</span>`;
  if (title) el.querySelector('b').textContent = title;
  if (text) el.querySelector('small').textContent = text;
  if (!title && text) {
    el.querySelector('span').innerHTML = '<b></b>';
    el.querySelector('b').textContent = text;
  }
  const root = host();
  root.append(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  const life = ms ?? (k.card ? 3600 : 1300);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, life);
}
