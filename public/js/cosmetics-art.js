// Arte de los cosméticos de identidad (avatares, marcos, insignias, títulos y decoración): todo generado con SVG y CSS, sin
// archivos de imagen, así que pesa casi nada, escala sin pérdida y no copia ningún personaje ni marca de terceros.
// Es de solo presentación: lo que el jugador lleva puesto lo decide el inventario del servidor (state.equipped).
import { findItem } from './cosmetics-data.js';
import { state } from './store.js';
import { esc } from './ui.js';

let uid = 0;

// Siluetas de pieza dibujadas en un lienzo de 64×64, centradas en x = 32. (Antes eran glifos de texto: cada fuente los desplazaba
// de una forma distinta y quedaban descentrados. Un SVG se ve igual en todas partes.)
const PIECES = {
  p: '<circle cx="32" cy="19" r="8.5"/><path d="M24.5 28h15l-2.5 7c4.5 3 7.500 8.500 7.500 14.500h-25c0-6 3-11.500 7.500-14.500z"/><rect x="15" y="49" width="34" height="7" rx="3.500"/>',
  r: '<path d="M19 9h7v6h4V9h4v6h4V9h7v15H19z"/><path d="M22.500 25h19l2 22h-23z"/><rect x="14" y="47" width="36" height="9" rx="3.500"/>',
  b: '<path d="M32 7c8 5.500 12 12.500 12 20 0 4.500-2.500 7.500-5.500 9.500h-13C22.500 34.500 20 31.500 20 27c0-7.500 4-14.500 12-20z"/><circle cx="32" cy="6.500" r="3"/><rect x="21" y="36" width="22" height="5.500" rx="2.500"/><path d="M25 41.500h14l3.500 8h-21z"/><rect x="15" y="49" width="34" height="7" rx="3.500"/>',
  n: '<path d="M16 56c0-9 3-15 9-21-5 0-9-3-11-8l6-8c3-5 8-9 15-11l2 5 4-3c8 4 13 12 13 24 0 8-2 15-4 22z"/>',
  q: '<circle cx="12" cy="17" r="3.500"/><circle cx="22" cy="12" r="3.500"/><circle cx="32" cy="10" r="3.500"/><circle cx="42" cy="12" r="3.500"/><circle cx="52" cy="17" r="3.500"/><path d="M10 22l9 17 3-18 6 16 4-18 4 18 6-16 3 18 9-17-4 29H14z"/><rect x="13" y="49" width="38" height="8" rx="3.500"/>',
  k: '<path d="M29.500 4h5v6h6v5h-6v5h-5v-5h-6v-5h6z"/><path d="M21 27c4-6 18-6 22 0 3.500 5 3 11 1.500 15l4 9H15.500l4-9C18 38 17.500 32 21 27z"/><rect x="14" y="50" width="36" height="7" rx="3.500"/>',
};
// Detalles que se «recortan» de la silueta (ojo del caballo, ranura del alfil...).
const CUTS = {
  n: '<circle cx="31" cy="21" r="2.100" fill="#0a0d13"/>',
  b: '<path d="M32 15v9M28 19.500h8" stroke="#0a0d13" stroke-width="2.600" stroke-linecap="round" opacity=".55"/>',
  q: '<path d="M22 44h20" stroke="#0a0d13" stroke-width="2" opacity=".35"/>',
  k: '<path d="M25 40h14" stroke="#0a0d13" stroke-width="2" opacity=".35"/>',
};

// Escenas de fondo del avatar: le dan un ambiente propio a cada uno.
const SCENES = {
  rays: (g) => [0, 30, 60, 90, 120, 150].map((r) => `<rect x="30" y="-4" width="4" height="72" fill="url(#${g})" opacity=".18" transform="rotate(${r} 32 32)"/>`).join(''),
  stars: (g) => '<circle cx="12" cy="14" r="1.500" fill="#fff" opacity=".8"/><circle cx="52" cy="10" r="1.200" fill="#fff" opacity=".6"/><circle cx="54" cy="44" r="1.800" fill="#fff" opacity=".7"/><circle cx="9" cy="48" r="1.200" fill="#fff" opacity=".5"/><circle cx="46" cy="24" r="1" fill="#fff" opacity=".6"/>' + `<path d="M16 8l1.200 3 3 1.200-3 1.200L16 16.500l-1.200-3-3-1.200 3-1.200z" fill="url(#${g})" opacity=".8"/>`,
  grid: (g) => `<g stroke="url(#${g})" stroke-width="1" opacity=".28">${[8, 20, 32, 44, 56].map((v) => `<path d="M${v} 0V64M0 ${v}H64"/>`).join('')}</g>`,
  waves: (g) => `<g fill="none" stroke="url(#${g})" stroke-width="2" opacity=".3"><path d="M0 44q8-6 16 0t16 0 16 0 16 0"/><path d="M0 52q8-6 16 0t16 0 16 0 16 0"/><path d="M0 36q8-6 16 0t16 0 16 0 16 0"/></g>`,
  flames: (g) => `<path d="M0 64V50c6-8 8 0 14-8 4 8 8 0 12 6 4-10 8-6 12 2 4-8 8-4 12 4 4-4 6-2 14 0v10z" fill="url(#${g})" opacity=".35"/>`,
  petals: (g) => [20, 100, 190, 260, 320].map((r, i) => `<ellipse cx="${12 + i * 11}" cy="${12 + ((i * 17) % 40)}" rx="3.500" ry="1.800" fill="url(#${g})" opacity=".4" transform="rotate(${r} ${12 + i * 11} ${12 + ((i * 17) % 40)})"/>`).join(''),
  halo: (g) => `<circle cx="32" cy="32" r="26" fill="none" stroke="url(#${g})" stroke-width="2" opacity=".35"/><circle cx="32" cy="32" r="20" fill="none" stroke="url(#${g})" stroke-width="1" opacity=".25" stroke-dasharray="3 4"/>`,
};

// Avatares ilustrados (no son una pieza). Mismo lienzo de 64×64.
const ART = {
  comet: (g) => `<circle cx="42" cy="22" r="9" fill="url(#${g})"/><path d="M36 28 10 54M38 31 18 56M33 25 6 46" stroke="url(#${g})" stroke-width="4" stroke-linecap="round" fill="none" opacity=".75"/>`,
  orbit: (g) => `<circle cx="32" cy="32" r="8" fill="url(#${g})"/><ellipse cx="32" cy="32" rx="25" ry="10" fill="none" stroke="url(#${g})" stroke-width="3" transform="rotate(-25 32 32)"/><circle cx="54" cy="24" r="4" fill="url(#${g})"/>`,
  prism: (g) => `<path d="M32 8 56 52H8Z" fill="none" stroke="url(#${g})" stroke-width="4" stroke-linejoin="round"/><path d="M32 8 32 52M20 30 44 30" stroke="url(#${g})" stroke-width="2.500" opacity=".7"/>`,
  ember: (g) => `<path d="M32 6C40 20 50 26 50 40a18 18 0 0 1-36 0c0-8 5-12 8-18 3 6 6 7 8-2 1-6 1-10 2-14Z" fill="url(#${g})"/><path d="M32 30c4 7 8 9 8 16a8 8 0 0 1-16 0c0-5 4-8 8-16Z" fill="#fff" opacity=".55"/>`,
  lotus: (g) => [0, 60, 120, 180, 240, 300].map((r) => `<ellipse cx="32" cy="18" rx="7" ry="14" fill="url(#${g})" opacity=".85" transform="rotate(${r} 32 32)"/>`).join('') + '<circle cx="32" cy="32" r="5" fill="#fff" opacity=".8"/>',
};

/**
 * Interior del avatar (sin marco). `locked`: silueta oscura con el brillo de su rareza, para enseñar qué se puede conseguir sin
 * regalar el aspecto completo.
 */
export function avatarInner(item) {
  const a = item?.asset ?? { piece: 'p', a: '#22e1ff', b: '#8b5cf6' };
  uid += 1;
  const g = `av${uid}`;
  const scene = SCENES[a.scene] ?? null;
  let figure;
  if (a.art && ART[a.art]) figure = ART[a.art](g);
  else {
    const piece = a.piece ?? 'p';
    figure = `<g fill="url(#${g})" stroke="rgba(255,255,255,.35)" stroke-width=".8" stroke-linejoin="round">${PIECES[piece] ?? PIECES.p}</g>${CUTS[piece] ?? ''}`;
  }
  return `<svg class="av" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a.a}"/><stop offset="1" stop-color="${a.b}"/></linearGradient>
      <radialGradient id="${g}b" cx=".35" cy=".25" r=".95"><stop offset="0" stop-color="${a.a}" stop-opacity=".30"/><stop offset=".6" stop-color="${a.b}" stop-opacity=".14"/><stop offset="1" stop-color="#0a0d13" stop-opacity="0"/></radialGradient></defs>
    <circle cx="32" cy="32" r="32" fill="url(#${g}b)"/>${scene ? scene(g) : ''}${figure}</svg>`;
}

/** Avatar + marco + insignia, con un tamaño en píxeles. `eq` por defecto es lo que el jugador lleva equipado. */
export function identityHtml(eq = state.equipped, { size = 44, badge = true, label = '', locked = false } = {}) {
  const av = findItem('avatar', eq.avatar) ?? findItem('avatar', 'pawn');
  const fr = findItem('frame', eq.frame) ?? findItem('frame', 'none');
  const bd = badge ? findItem('badge', eq.badge) : null;
  const showBadge = bd && bd.id !== 'none';
  return `<span class="idn ${locked ? 'locked' : ''}" style="--s:${size}px;--fc:${fr.asset.color}" data-fs="${fr.asset.style}" data-r="${av.rarity}" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${avatarInner(av)}${showBadge ? `<i class="idn-badge" title="${esc(bd.name)}" style="--bc:${bd.asset.color}">${bd.asset.icon}</i>` : ''}</span>`;
}

export const titleOf = (eq = state.equipped) => {
  const t = findItem('title', eq.title);
  return t && t.id !== 'none' ? t.name : '';
};
export const decorClass = (eq = state.equipped) => findItem('decor', eq.decor)?.asset.css ?? 'decor-plain';
