// Ajustes y personalización: cuenta, sonido, pantalla (movimiento reducido, tablero 2D) y piezas/tablero/efectos equipados.
import { RARITY, SHOP } from './data.js';
import { net } from './net.js';
import { equip, owns, save, state } from './store.js';
import { $, $$, app, esc, showScreen } from './ui.js';

const PREF_REDUCE = 'checkpoint.reduce';
const PREF_2D = 'checkpoint.2d';
const KINDS = [
  { kind: 'set', group: 'sets', label: 'Piezas' },
  { kind: 'board', group: 'boards', label: 'Tablero' },
  { kind: 'fx', group: 'fx', label: 'Efecto de captura' },
];

const readPref = (key) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};
const writePref = (key, on) => {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* sin almacenamiento */
  }
};

const setSwitch = (el, on) => {
  el.setAttribute('aria-checked', String(on));
  el.classList.toggle('on', on);
};

function renderAccount() {
  const u = net.user;
  $('#setAccount').innerHTML = u
    ? `<p class="eyebrow">Cuenta</p><div class="set-row"><span><b>${esc(u.name)}</b><small>Cuenta de invitado · el progreso se guarda en la nube con tu código de recuperación</small></span><button class="btn" data-go="profile">Abrir perfil</button></div>`
    : '<p class="eyebrow">Cuenta</p><div class="set-row"><span><b>Sin conexión</b><small>Tu progreso se guarda en este dispositivo hasta que vuelva el servidor</small></span></div>';
}

function renderLook() {
  const rows = KINDS.map(({ kind, group, label }) => {
    const owned = SHOP[group].filter((i) => owns(kind, i.id));
    const total = SHOP[group].filter((i) => !i.exclusive).length;
    return `<label class="set-row"><span><b>${label}</b><small>${owned.length} de ${total + SHOP[group].filter((i) => i.exclusive && owns(kind, i.id)).length} desbloqueados</small></span>
      <select data-equip="${kind}" aria-label="${label}">${owned.map((i) => `<option value="${i.id}" ${state.equipped[kind] === i.id ? 'selected' : ''}>${esc(i.name)} · ${RARITY[i.rarity].label}</option>`).join('')}</select></label>`;
  }).join('');
  $('#setLook').innerHTML = `<p class="eyebrow">Personalización</p>${rows}
    <button class="btn primary" data-go="shop">Abrir la tienda de skins</button>`;
}

function renderSwitches() {
  setSwitch($('#setSound'), !state.muted);
  setSwitch($('#setMotion'), readPref(PREF_REDUCE));
  setSwitch($('#set2d'), readPref(PREF_2D));
}

export function enterSettings() {
  showScreen('settings');
  renderAccount();
  renderLook();
  renderSwitches();
}

export function initSettings() {
  $('#setSound').addEventListener('click', () => {
    state.muted = !state.muted;
    save();
    renderSwitches();
  });
  $('#setMotion').addEventListener('click', () => {
    const on = !readPref(PREF_REDUCE);
    writePref(PREF_REDUCE, on);
    document.documentElement.classList.toggle('reduce-motion', on);
    renderSwitches();
  });
  $('#set2d').addEventListener('click', () => {
    writePref(PREF_2D, !readPref(PREF_2D));
    location.reload(); // el modo del tablero se decide al arrancar
  });
  $('#screen-settings').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-equip]');
    if (!sel) return;
    equip(sel.dataset.equip, sel.value);
    app.applySkins?.();
  });
  void $$;
}
