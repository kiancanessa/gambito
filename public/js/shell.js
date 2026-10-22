// Estructura común de CHECKPOINT: navegación principal (barra superior y barra inferior móvil) y flags.
import { flags } from './flags.js';
import { $$, onScreen } from './ui.js';

// Qué pestaña de la navegación se ilumina en cada pantalla.
const SECTION = {
  home: 'home',
  lobby: 'play', quick: 'play', online: 'play', daily: 'play', game: 'play',
  academy: 'play', watch: 'play',
  circuit: 'circuit',
  ranking: 'ranking',
  // Todo lo personal cuelga de «Perfil»: progreso, personalización, amigos, historial y ajustes.
  progress: 'me', shop: 'me', social: 'me', user: 'me', profile: 'me', history: 'me', settings: 'me',
};

function paintNav(screen) {
  const section = SECTION[screen] ?? 'home';
  // Las mismas cinco secciones arriba (escritorio) y abajo (móvil).
  for (const b of [...$$('.nav-link'), ...$$('.tab')]) {
    const on = b.dataset.nav === section;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}

export function initShell() {
  // Elementos que dependen de qué funciones están activas.
  $$('[data-flag]').forEach((el) => (el.hidden = !flags[el.dataset.flag]));
  // "Jugar" va al lobby competitivo, o al hub online si el lobby está desactivado.
  $$('[data-play]').forEach((el) => (el.dataset.go = flags.lobby ? 'lobby' : 'online'));
  onScreen((name) => {
    document.body.dataset.screen = name;
    paintNav(name);
  });
  paintNav('home');
  document.body.dataset.screen = 'home';

  // Preferencias de pantalla guardadas.
  try {
    if (localStorage.getItem('checkpoint.reduce') === '1') document.documentElement.classList.add('reduce-motion');
  } catch {
    /* sin almacenamiento */
  }
}
