// Estructura común de CHECKPOINT: navegación principal (barra superior y barra inferior móvil), flags y tarjeta de cuenta del inicio.
import { GLYPH, leagueOf } from './data.js';
import { flags } from './flags.js';
import { bootstrap, net, onNet } from './net.js';
import { onScreen } from './ui.js';
import { $, $$, esc, VS } from './ui.js';

// Qué pestaña de la navegación se ilumina en cada pantalla.
const SECTION = {
  home: 'home',
  lobby: 'play', quick: 'play', online: 'play', daily: 'play', game: 'play',
  academy: 'academy',
  circuit: 'circuit',
  ranking: 'ranking',
  missions: 'rewards', season: 'rewards', shop: 'rewards',
  social: 'friends',
  profile: 'me', history: 'me', settings: 'me',
};

function paintNav(screen) {
  const section = SECTION[screen] ?? 'home';
  // La barra inferior solo tiene "Perfil"; las secciones sin pestaña propia iluminan la más cercana.
  const tabFor = { rewards: 'play', friends: 'me' }[section] ?? section;
  $$('.nav-link').forEach((b) => b.classList.toggle('on', b.dataset.nav === section));
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.nav === tabFor));
}

function renderAccount() {
  const box = $('#homeAccount');
  if (!box) return;
  const u = net.user;
  if (!u && !net.booted) {
    box.innerHTML = '<div class="acc-main"><span class="acc-dot wait"></span><span><b>Conectando…</b><small>Buscando tu cuenta en el servidor</small></span></div>';
    return;
  }
  if (!u) {
    box.innerHTML = `<div class="acc-main"><span class="acc-dot off"></span><span><b>Sin conexión</b><small>Puedes seguir la Academia, el tutorial y partidas contra la IA; tu progreso se guarda en este dispositivo.</small></span></div>
      <button class="btn" data-acc="retry">Reintentar</button>`;
    return;
  }
  const lg = leagueOf(u.rating);
  box.innerHTML = `<button class="acc-main acc-open" data-go="profile" aria-label="Abrir tu perfil">
      <span class="emblem" style="--c:${lg.color}"><i>${GLYPH[lg.glyph]}${VS}</i></span>
      <span><b>${esc(u.name)}</b><small>Liga ${lg.name} · ${u.rating} pts · ${u.wins}V ${u.losses}D ${u.draws}T</small></span>
    </button>
    <button class="btn" data-go="profile">Perfil</button>`;
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

  renderAccount();
  onNet(renderAccount);
  $('#homeAccount')?.addEventListener('click', async (e) => {
    if (e.target.closest('[data-acc="retry"]')) {
      await bootstrap();
      renderAccount();
    }
  });

  // Preferencias de pantalla guardadas.
  try {
    if (localStorage.getItem('checkpoint.reduce') === '1') document.documentElement.classList.add('reduce-motion');
  } catch {
    /* sin almacenamiento */
  }
}
