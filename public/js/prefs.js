// Preferencias de juego (sonido, animaciones, resaltados, avisos y controles). Se guardan solo en este dispositivo.
// Ninguna afecta a la lógica ni al reloj: el servidor decide jugadas y tiempo; esto solo cambia cómo se ve y se oye.
const KEY = 'checkpoint.prefs';

export const DEFAULTS = {
  volume: 0.7, // 0-1, volumen general de los efectos (el interruptor de sonido de Ajustes sigue silenciando todo)
  lowTimeSound: true, // pitido en los últimos 10 s de tu reloj
  animations: 'full', // full | fast | off: velocidad de las animaciones de las piezas
  showLegal: true, // puntos y aros en los destinos legales
  showLast: true, // resalte de la última jugada
  popups: true, // avisos discretos (captura, jaque, misión…)
  haptics: true, // vibración en móviles
  drag: true, // arrastrar y soltar (seleccionar y tocar destino funciona siempre)
};

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
};

const clean = (raw) => ({
  volume: Math.min(1, Math.max(0, Number(raw.volume ?? DEFAULTS.volume))),
  lowTimeSound: raw.lowTimeSound ?? DEFAULTS.lowTimeSound,
  animations: ['full', 'fast', 'off'].includes(raw.animations) ? raw.animations : DEFAULTS.animations,
  showLegal: raw.showLegal ?? DEFAULTS.showLegal,
  showLast: raw.showLast ?? DEFAULTS.showLast,
  popups: raw.popups ?? DEFAULTS.popups,
  haptics: raw.haptics ?? DEFAULTS.haptics,
  drag: raw.drag ?? DEFAULTS.drag,
});

export const prefs = clean(read());
const listeners = new Set();
export const onPrefs = (fn) => listeners.add(fn);

export function setPref(key, value) {
  Object.assign(prefs, clean({ ...prefs, [key]: value }));
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* sin almacenamiento */
  }
  listeners.forEach((fn) => fn(prefs, key));
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

// Factor de duración de las animaciones de las piezas (0 = instantáneo). «Reducir movimiento» nunca da más de «rápidas».
export function animScale() {
  const base = { full: 1, fast: 0.5, off: 0 }[prefs.animations];
  return reduced() ? Math.min(base, 0.5) : base;
}

// Vibración breve en móviles (si el usuario no la ha desactivado).
export function buzz(pattern = 12) {
  if (prefs.haptics && !reduced()) navigator.vibrate?.(pattern);
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sw = (key, label, hint) => `<div class="set-row"><span><b>${esc(label)}</b><small>${esc(hint)}</small></span><button class="switch ${prefs[key] ? 'on' : ''}" data-pref-switch="${key}" role="switch" aria-checked="${prefs[key]}" aria-label="${esc(label)}"><i></i></button></div>`;

// Panel de preferencias reutilizable (Ajustes y diálogo de la partida). Los eventos se enlazan con `bindPrefsPanel`.
export function prefsPanelHtml() {
  return `
    <div class="set-row"><span><b>Volumen de efectos</b><small>${Math.round(prefs.volume * 100)} %</small></span><input class="pref-range" type="range" min="0" max="100" step="5" value="${Math.round(prefs.volume * 100)}" data-pref-volume aria-label="Volumen de efectos"></div>
    ${sw('lowTimeSound', 'Alerta de poco tiempo', 'Pitido en los últimos 10 segundos de tu reloj')}
    <div class="set-row"><span><b>Animaciones de las piezas</b><small>No afectan al reloj: puedes mover mientras se animan</small></span>
      <select data-pref-anim aria-label="Animaciones de las piezas">${[['full', 'Completas'], ['fast', 'Rápidas'], ['off', 'Sin animación']].map(([v, l]) => `<option value="${v}" ${prefs.animations === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${sw('showLegal', 'Mostrar movimientos legales', 'Puntos y aros en los destinos de la pieza elegida')}
    ${sw('showLast', 'Resaltar la última jugada', 'Marca el origen y el destino del último movimiento')}
    ${sw('popups', 'Avisos de juego', 'Capturas, jaque, misiones y avances de torneo')}
    ${sw('drag', 'Arrastrar y soltar', 'Además de tocar la pieza y después su destino')}
    ${sw('haptics', 'Vibración', 'En móviles, al capturar o dar jaque')}`;
}

export function bindPrefsPanel(root, rerender) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pref-switch]');
    if (!b) return;
    setPref(b.dataset.prefSwitch, !prefs[b.dataset.prefSwitch]);
    rerender();
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches('[data-pref-volume]')) {
      setPref('volume', Number(e.target.value) / 100);
      const small = e.target.closest('.set-row')?.querySelector('small');
      if (small) small.textContent = `${Math.round(prefs.volume * 100)} %`;
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-pref-anim]')) setPref('animations', e.target.value);
    if (e.target.matches('[data-pref-volume]')) document.dispatchEvent(new CustomEvent('checkpoint:test-sound')); // al soltar, se oye un ejemplo
  });
}
