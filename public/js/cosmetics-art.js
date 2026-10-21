// Arte de los cosméticos de identidad (avatares, marcos, insignias, títulos y decoración): todo generado con SVG y CSS, sin
// archivos de imagen, así que pesa casi nada, escala sin pérdida y no copia ningún personaje ni marca de terceros.
// Es de solo presentación: lo que el jugador lleva puesto lo decide el inventario del servidor (state.equipped).
import { findItem } from './cosmetics-data.js';
import { state } from './store.js';
import { esc, VS } from './ui.js';

let uid = 0;

// Avatares abstractos (viewBox 64×64). Los de «glifo» usan una pieza de ajedrez.
const ART = {
  comet: (g) => `<circle cx="42" cy="22" r="9" fill="url(#${g})"/><path d="M36 28 10 54M38 31 18 56M33 25 6 46" stroke="url(#${g})" stroke-width="4" stroke-linecap="round" fill="none" opacity=".75"/>`,
  orbit: (g) => `<circle cx="32" cy="32" r="8" fill="url(#${g})"/><ellipse cx="32" cy="32" rx="25" ry="10" fill="none" stroke="url(#${g})" stroke-width="3" transform="rotate(-25 32 32)"/><circle cx="54" cy="24" r="4" fill="url(#${g})"/>`,
  prism: (g) => `<path d="M32 8 56 52H8Z" fill="none" stroke="url(#${g})" stroke-width="4" stroke-linejoin="round"/><path d="M32 8 32 52M20 30 44 30" stroke="url(#${g})" stroke-width="2.5" opacity=".7"/>`,
  ember: (g) => `<path d="M32 6C40 20 50 26 50 40a18 18 0 0 1-36 0c0-8 5-12 8-18 3 6 6 7 8-2 1-6 1-10 2-14Z" fill="url(#${g})"/><path d="M32 30c4 7 8 9 8 16a8 8 0 0 1-16 0c0-5 4-8 8-16Z" fill="#fff" opacity=".55"/>`,
  lotus: (g) => [0, 60, 120, 180, 240, 300].map((r) => `<ellipse cx="32" cy="18" rx="7" ry="14" fill="url(#${g})" opacity=".85" transform="rotate(${r} 32 32)"/>`).join('') + `<circle cx="32" cy="32" r="5" fill="#fff" opacity=".8"/>`,
};

/** Interior del avatar (sin marco): glifo de pieza o ilustración SVG. */
export function avatarInner(item) {
  const a = item?.asset ?? { glyph: '♟', a: '#22e1ff', b: '#8b5cf6' };
  if (a.art && ART[a.art]) {
    uid += 1;
    const g = `av${uid}`;
    return `<svg class="av" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a.a}"/><stop offset="1" stop-color="${a.b}"/></linearGradient></defs>${ART[a.art](g)}</svg>`;
  }
  return `<span class="av av-glyph" style="--a:${a.a};--b:${a.b}">${a.glyph}${VS}</span>`;
}

/** Avatar + marco + insignia, con un tamaño en píxeles. `eq` por defecto es lo que el jugador lleva equipado. */
export function identityHtml(eq = state.equipped, { size = 44, badge = true, label = '' } = {}) {
  const av = findItem('avatar', eq.avatar) ?? findItem('avatar', 'pawn');
  const fr = findItem('frame', eq.frame) ?? findItem('frame', 'none');
  const bd = badge ? findItem('badge', eq.badge) : null;
  const showBadge = bd && bd.id !== 'none';
  return `<span class="idn" style="--s:${size}px;--fc:${fr.asset.color}" data-fs="${fr.asset.style}" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${avatarInner(av)}${showBadge ? `<i class="idn-badge" title="${esc(bd.name)}" style="--bc:${bd.asset.color}">${bd.asset.icon}</i>` : ''}</span>`;
}

export const titleOf = (eq = state.equipped) => {
  const t = findItem('title', eq.title);
  return t && t.id !== 'none' ? t.name : '';
};
export const decorClass = (eq = state.equipped) => findItem('decor', eq.decor)?.asset.css ?? 'decor-plain';
