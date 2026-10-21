// Sonidos sintetizados (WebAudio) y partículas visuales. Todo sin archivos externos.
import { animScale, prefs } from './prefs.js';
import { state } from './store.js';

let ctx = null;

function audio() {
  if (state.muted) return null;
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq, { dur = 0.12, type = 'sine', vol = 0.15, delay = 0, slide = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * prefs.volume), t + 0.01); // volumen general de Ajustes
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  move: () => tone(220, { dur: 0.08, type: 'triangle', vol: 0.18, slide: -60 }),
  capture: () => {
    tone(150, { dur: 0.16, type: 'sawtooth', vol: 0.16, slide: -90 });
    tone(520, { dur: 0.06, type: 'square', vol: 0.06 });
  },
  check: () => {
    tone(660, { dur: 0.1, type: 'square', vol: 0.1 });
    tone(880, { dur: 0.16, type: 'square', vol: 0.1, delay: 0.1 });
  },
  select: () => tone(480, { dur: 0.04, type: 'sine', vol: 0.07 }),
  coin: () => {
    tone(988, { dur: 0.07, type: 'square', vol: 0.07 });
    tone(1319, { dur: 0.18, type: 'square', vol: 0.07, delay: 0.07 });
  },
  promote: () => [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, { dur: 0.16, type: 'triangle', vol: 0.12, delay: i * 0.07 })),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, { dur: 0.22, type: 'triangle', vol: 0.13, delay: i * 0.12 })),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, { dur: 0.3, type: 'sawtooth', vol: 0.09, delay: i * 0.18 })),
  error: () => tone(120, { dur: 0.12, type: 'square', vol: 0.08 }),
  // Alerta de poco tiempo: un clic seco por segundo; cada vez más agudo en los últimos 3.
  tick: (urgent = false) => tone(urgent ? 1180 : 880, { dur: 0.05, type: 'square', vol: urgent ? 0.1 : 0.06 }),
  record: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, { dur: 0.2, type: 'triangle', vol: 0.11, delay: i * 0.08 })),
  advance: () => [440, 554, 659, 880].forEach((f, i) => tone(f, { dur: 0.18, type: 'sawtooth', vol: 0.07, delay: i * 0.09 })),
  confirm: () => tone(740, { dur: 0.04, type: 'sine', vol: 0.05 }),
};

// Al soltar el control de volumen se oye un ejemplo.
if (typeof document !== 'undefined') document.addEventListener('checkpoint:test-sound', () => sfx.move());

// ---- Partículas ----
const FX = {
  sparks: { colors: ['#ffd54f', '#ff9800', '#fff59d'], count: 14, dist: [24, 70], size: [3, 6], life: 520, shape: 'circle' },
  confetti: { colors: ['#ff4081', '#40c4ff', '#ffd740', '#69f0ae', '#b388ff'], count: 20, dist: [30, 90], size: [5, 9], life: 900, shape: 'rect', gravity: 40 },
  embers: { colors: ['#ff5722', '#ff9800', '#ffccbc'], count: 16, dist: [10, 50], size: [3, 7], life: 1000, shape: 'circle', rise: -50 },
  frost: { colors: ['#e1f5fe', '#81d4fa', '#ffffff'], count: 16, dist: [20, 70], size: [3, 8], life: 800, shape: 'diamond' },
  // Efectos de victoria (cosméticos): solo decoran, no cambian nada de la partida.
  firework: { colors: ['#ffd24a', '#ff8a98', '#22e1ff', '#34e3a0', '#b9a1ff'], count: 34, dist: [80, 230], size: [4, 8], life: 1150, shape: 'circle', gravity: 60 },
  laurel: { colors: ['#ffd24a', '#e8b923', '#9bd35a'], count: 24, dist: [20, 140], size: [9, 15], life: 2300, shape: 'leaf', gravity: 430 },
  nova: { colors: ['#ffffff', '#22e1ff', '#b9a1ff'], count: 30, dist: [60, 260], size: [3, 7], life: 1000, shape: 'circle' },
};

const rand = (a, b) => a + Math.random() * (b - a);

// Genera partículas centradas en (x, y) dentro del contenedor `layer`.
export function burst(layer, x, y, fxId = 'sparks', scale = 1) {
  const fx = FX[fxId] || FX.sparks;
  for (let i = 0; i < fx.count * scale; i += 1) {
    const el = document.createElement('i');
    const size = rand(...fx.size);
    el.className = `particle ${fx.shape}`;
    el.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${fx.shape === 'rect' ? size * 0.5 : size}px;background:${fx.colors[i % fx.colors.length]}`;
    layer.appendChild(el);
    const ang = rand(0, Math.PI * 2);
    const dist = rand(...fx.dist) * scale;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist + (fx.rise || 0) + (fx.gravity || 0);
    const anim = el.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1) rotate(0)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.2) rotate(${rand(-360, 360)}deg)`, opacity: 0 },
      ],
      { duration: fx.life * rand(0.8, 1.2), easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
    anim.onfinish = () => el.remove();
  }
}

// ---- Efectos de victoria ----
// `layer` es el contenedor a pantalla completa (#celebrate). Todos respetan «animaciones: desactivadas».
export function victoryFx(layer, id = 'confetti') {
  if (!layer || animScale() <= 0) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const at = (fn, ms) => setTimeout(fn, ms);
  switch (id) {
    case 'fireworks':
      for (let i = 0; i < 6; i += 1) at(() => burst(layer, w * rand(0.15, 0.85), h * rand(0.15, 0.5), 'firework', 1.6), i * 260);
      break;
    case 'laurel':
      for (let i = 0; i < 4; i += 1) at(() => burst(layer, w * rand(0.1, 0.9), -10, 'laurel', 3.2), i * 300);
      break;
    case 'aurora': {
      const veil = document.createElement('div');
      veil.className = 'aurora-veil';
      layer.appendChild(veil);
      veil.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], { duration: 3200, easing: 'ease-in-out' }).onfinish = () => veil.remove();
      burst(layer, w * 0.5, h * 0.35, 'frost', 2.4);
      break;
    }
    case 'nova':
      for (let i = 0; i < 3; i += 1) {
        at(() => {
          const ring = document.createElement('i');
          ring.className = 'nova-ring';
          ring.style.cssText = `left:${w / 2}px;top:${h * 0.38}px`;
          layer.appendChild(ring);
          ring.animate([{ transform: 'translate(-50%,-50%) scale(0.05)', opacity: 0.95 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 }], { duration: 1500, easing: 'cubic-bezier(.15,.7,.3,1)' }).onfinish = () => ring.remove();
        }, i * 260);
      }
      at(() => burst(layer, w * 0.5, h * 0.38, 'nova', 2.6), 120);
      break;
    default:
      [0.2, 0.5, 0.8].forEach((fx, i) => at(() => burst(layer, w * fx, h * 0.35, 'confetti', 2.6), i * 220));
  }
}
