// Personalización: catálogo por categorías, inventario, vista previa, equipar y comprar (con oros).
// Se carga de forma diferida (import()) la primera vez que se abre. Lo que posee cada jugador y lo que lleva equipado lo decide
// el servidor: aquí solo se muestra, se previsualiza y se pide equipar (`POST /api/cosmetics/equip`) o comprar (monedero).
import { ACHIEVEMENTS } from './progression-data.js';
import { CATEGORIES, RARITY, itemKey, itemsOf, priceOf, unlockInfo } from './cosmetics-data.js';
import { decorClass, identityHtml, titleOf } from './cosmetics-art.js';
import { burst, sfx, victoryFx } from './fx.js';
import { GLYPH } from './data.js';
import { api, ensureOnline, net } from './net.js';
import { thumbFor } from './stage.js';
import { applyWallet, state } from './store.js';
import { $, $$, app, esc, toast, VS } from './ui.js';
import { syncWallet } from './wallet.js';

const NAMES = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a.name]));
const FILTERS = [['all', 'Todos'], ['unlocked', 'Desbloqueados'], ['locked', 'Bloqueados']];
const cz = { cat: 'avatar', filter: 'all', sel: null, inv: new Set(), loading: true, error: null, busy: false, just: null, io: null, wired: false };
const IDENTITY = new Set(['avatar', 'frame', 'badge', 'title', 'decor']);

const owned = (it) => cz.inv.has(itemKey(it.category, it.id));
const equipped = (it) => state.equipped[it.category] === it.id;
const info = (it) => unlockInfo(it, { achievementNames: NAMES, level: state.level });
const live = (msg) => {
  const el = $('#czLive');
  if (el) el.textContent = msg;
};

// ---------- Datos ----------
async function load() {
  cz.loading = true;
  cz.error = null;
  render();
  if (!(await ensureOnline())) {
    cz.loading = false;
    cz.error = 'Sin conexión con el servidor. Tu inventario se guarda allí para que nadie pueda falsearlo.';
    return render();
  }
  const res = await api('/api/cosmetics');
  cz.loading = false;
  if (!res.ok) {
    cz.error = res.status === 0 ? 'No se pudo conectar con el servidor.' : 'No se pudo cargar tu colección. Inténtalo de nuevo.';
    return render();
  }
  const d = res.json;
  cz.inv = new Set(d.owned);
  applyWallet({ coins: d.coins, xp: state.xp, level: d.level, owned: d.owned, equipped: d.equipped });
  if (d.newly?.length) toast(`🎁 ${d.newly.length} desbloqueo${d.newly.length > 1 ? 's' : ''} nuevo${d.newly.length > 1 ? 's' : ''}: ${d.newly.slice(0, 3).map((n) => n.name).join(', ')}${d.newly.length > 3 ? ` y ${d.newly.length - 3} más` : ''}`, 4500);
  app.applySkins?.();
  return render();
}

async function equip(it) {
  if (cz.busy || !owned(it) || equipped(it)) return;
  cz.busy = true;
  render();
  const res = await api('/api/cosmetics/equip', { method: 'POST', body: { category: it.category, id: it.id } });
  cz.busy = false;
  if (!res.ok) {
    sfx.error();
    toast(res.json?.error ?? 'No se pudo equipar', 3500);
    live(`No se pudo equipar ${it.name}`);
    return render();
  }
  state.equipped = { ...state.equipped, ...res.json.equipped };
  applyWallet({ coins: state.coins, xp: state.xp, level: state.level, owned: [...cz.inv], equipped: state.equipped });
  app.applySkins?.();
  cz.just = itemKey(it.category, it.id);
  sfx.select();
  toast(`✔ ${it.name} equipado`, 2200);
  live(`${it.name} equipado`);
  render();
  setTimeout(() => {
    cz.just = null;
    $$('.cz-card.just').forEach((c) => c.classList.remove('just'));
  }, 1400);
  return undefined;
}

async function buy(it) {
  const price = priceOf(it);
  if (cz.busy || price === null || owned(it)) return;
  if (state.coins < price) {
    sfx.error();
    toast(`Te faltan ${price - state.coins} oros.`);
    return;
  }
  cz.busy = true;
  render();
  const res = await api('/api/wallet/ops', { method: 'POST', body: { ops: [{ oid: `buy-${it.category}-${it.id}-${Date.now()}`, t: 'buy', kind: it.category, id: it.id }] } });
  cz.busy = false;
  const r = res.json?.results?.[0];
  if (!res.ok || !r?.ok) {
    sfx.error();
    toast({ coins: 'No tienes oros suficientes.', owned: 'Ya lo tienes.', exclusive: 'Ese artículo no se vende.', unknown: 'Ese artículo no se puede comprar.' }[r?.reason] ?? 'No se pudo completar la compra.', 3500);
    return render();
  }
  applyWallet(res.json.wallet);
  cz.inv = new Set(res.json.wallet.owned);
  sfx.coin();
  toast(`🛍 ${it.name} desbloqueado`);
  live(`${it.name} desbloqueado`);
  render();
  return equip(it);
}

// ---------- Vistas previas ----------
function setFallback(it) {
  const sq = (cls, c, p) => `<div class="sq ${cls}"><span class="piece ${c} t-${p}">${GLYPH[p]}${VS}</span></div>`;
  if (it.category === 'set') return `<div class="pv pv-set set-${it.id} board-${state.equipped.board}">${sq('light', 'w', 'n')}${sq('dark', 'b', 'q')}${sq('dark', 'w', 'b')}${sq('light', 'b', 'r')}</div>`;
  return `<div class="pv pv-board board-${it.id} set-${state.equipped.set}">${['light', 'dark', 'dark', 'light', 'light', 'dark', 'dark', 'light', 'light'].map((c, i) => `<div class="sq ${c}">${i === 4 ? `<span class="piece w t-k">${GLYPH.k}${VS}</span>` : ''}</div>`).join('')}</div>`;
}

function previewHtml(it, big = false, locked = false) {
  const eq = { ...state.equipped, [it.category]: it.id };
  switch (it.category) {
    case 'avatar':
    case 'frame':
    case 'badge':
      return `<div class="cz-id">${identityHtml(eq, { size: big ? 96 : 56, locked: locked && it.category === 'avatar' })}</div>`;
    case 'title':
      return `<div class="cz-text"><b>${esc(it.name)}</b><small>Título de perfil</small></div>`;
    case 'decor':
      return `<div class="cz-decor ${it.asset.css}"><span>${esc(it.name)}</span></div>`;
    case 'board':
    case 'set':
      return `<div class="cz-thumb" data-thumb="${it.category}:${it.id}">${setFallback(it)}</div>`;
    case 'fx':
      return `<div class="pv pv-fx" data-fx="${it.id}"><span class="try">✨ Probar</span><div class="fx-layer"></div></div>`;
    case 'victory':
      return `<div class="cz-try" data-victory="${it.id}"><span class="try">▶ Probar</span></div>`;
    case 'crown':
      return `<div class="cz-crown crown-${it.id}" data-crown="${it.id}"><span class="p">♟${VS}</span><span class="q">♛${VS}</span></div>`;
    default:
      return '';
  }
}

// Las miniaturas 3D (caras de generar) se crean solo cuando la tarjeta entra en pantalla.
function observe() {
  cz.io?.disconnect();
  const targets = $$('#screen-shop .cz-thumb[data-thumb]');
  if (!targets.length) return;
  cz.io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        cz.io.unobserve(e.target);
        const [kind, id] = e.target.dataset.thumb.split(':');
        const url = thumbFor(kind, id);
        if (url) e.target.innerHTML = `<img class="pv pv-img" alt="" loading="lazy" src="${url}">`;
      }
    },
    { rootMargin: '120px' },
  );
  targets.forEach((t) => cz.io.observe(t));
}

// ---------- Interfaz ----------
function counts() {
  return Object.fromEntries(CATEGORIES.map((c) => {
    const list = itemsOf(c.id).filter((i) => i.status === 'active');
    return [c.id, [list.filter(owned).length, list.length]];
  }));
}

function cardHtml(it) {
  const own = owned(it);
  const eq = equipped(it);
  const r = RARITY[it.rarity];
  const u = info(it);
  const price = priceOf(it);
  const soon = it.status !== 'active';
  let action;
  if (eq) action = '<button class="btn" disabled>✔ Equipado</button>';
  else if (own) action = `<button class="btn primary" data-act="equip" ${cz.busy ? 'disabled' : ''}>Equipar</button>`;
  else if (price !== null) action = `<button class="btn buy ${state.coins < price ? 'cant' : ''}" data-act="buy" ${cz.busy ? 'disabled' : ''}>🪙 ${price}</button>`;
  else action = `<button class="btn" disabled>${soon ? '⏳ Próximamente' : '🔒 Bloqueado'}</button>`;
  const key = itemKey(it.category, it.id);
  return `<article class="cz-card ${eq ? 'equipped' : ''} ${own ? '' : 'locked'} ${cz.sel === key ? 'selected' : ''} ${cz.just === key ? 'just' : ''}" data-key="${key}" tabindex="0" role="button" aria-pressed="${cz.sel === key}" aria-label="${esc(it.name)}: ${own ? (eq ? 'equipado' : 'desbloqueado') : 'bloqueado'}" style="--r:${r.color}">
    <div class="cz-pv">${previewHtml(it, false, !own)}${own ? '' : '<span class="cz-lock" aria-hidden="true">🔒</span>'}</div>
    <div class="cz-info"><b>${esc(it.name)}</b><span class="rarity">${r.label}</span></div>
    <p class="cz-unlock ${own ? 'ok' : ''}" title="${esc(u.long)}"><i aria-hidden="true">${own ? '✔' : u.icon}</i>${own ? 'Desbloqueado' : esc(u.short)}</p>
    ${action}
  </article>`;
}

function previewPanel(list) {
  const it = list.find((i) => itemKey(i.category, i.id) === cz.sel) ?? list.find(equipped) ?? list[0];
  if (!it) return '';
  const own = owned(it);
  const eq = { ...state.equipped, ...(IDENTITY.has(it.category) ? { [it.category]: it.id } : {}) };
  const u = info(it);
  const price = priceOf(it);
  const name = net.user?.name ?? 'Jugador';
  const title = titleOf(eq);
  let action = '';
  if (equipped(it)) action = '<button class="btn" disabled>✔ Equipado</button>';
  else if (own) action = '<button class="btn primary" data-act="equip-sel">Equipar</button>';
  else if (price !== null) action = `<button class="btn buy ${state.coins < price ? 'cant' : ''}" data-act="buy-sel">Comprar · 🪙 ${price}</button>`;
  return `<div class="cz-idcard ${decorClass(eq)}">${identityHtml(eq, { size: 96, label: `Vista previa de ${name}` })}
      <div class="cz-idtext"><b>${esc(name)}</b>${title ? `<small>${esc(title)}</small>` : '<small class="muted">Sin título</small>'}</div></div>
    <div class="cz-sel"><p class="eyebrow">Vista previa · ${esc(CATEGORIES.find((c) => c.id === it.category).one)}</p>
      <h3>${esc(it.name)} <span class="rarity" style="--r:${RARITY[it.rarity].color}">${RARITY[it.rarity].label}</span></h3>
      <p class="muted">${esc(it.desc)}</p>
      ${['board', 'set', 'fx', 'victory', 'crown'].includes(it.category) ? `<div class="cz-big">${previewHtml(it, true)}</div>` : ''}
      <p class="cz-how ${own ? 'ok' : ''}"><i aria-hidden="true">${own ? '✔' : u.icon}</i><span>${own ? 'Lo tienes. ' : ''}${esc(u.long)}</span></p>
      ${action}</div>`;
}

function render() {
  const body = $('#customBody');
  if (!body) return;
  if (cz.loading && !cz.inv.size) {
    body.innerHTML = '<div class="cz-skeleton" aria-busy="true"><span></span><span></span><span></span><span></span><span></span><span></span></div>';
    return;
  }
  if (cz.error) {
    body.innerHTML = `<section class="lb-card" role="alert"><p class="eyebrow">No disponible</p><h3>No se pudo abrir tu colección</h3><p class="muted">${esc(cz.error)}</p><button class="btn primary" data-cz="retry">Reintentar</button></section>`;
    return;
  }
  const cnt = counts();
  const all = itemsOf(cz.cat);
  const shown = all.filter((i) => (cz.filter === 'unlocked' ? owned(i) : cz.filter === 'locked' ? !owned(i) : true));
  const cat = CATEGORIES.find((c) => c.id === cz.cat);
  body.innerHTML = `<div class="cz-layout">
    <aside class="lb-card cz-preview" aria-label="Vista previa">${previewPanel(all)}</aside>
    <section class="cz-catalog">
      <div class="seg cz-cats" role="tablist" aria-label="Categorías">${CATEGORIES.map((c) => `<button role="tab" aria-selected="${c.id === cz.cat}" data-cat="${c.id}" class="${c.id === cz.cat ? 'on' : ''}">${c.label} <small>${cnt[c.id][0]}/${cnt[c.id][1]}</small></button>`).join('')}</div>
      <div class="cz-bar"><p class="muted">${esc(cat.hint)}</p>
        <div class="seg cz-filters" role="group" aria-label="Filtrar">${FILTERS.map(([id, label]) => `<button data-filter="${id}" aria-pressed="${cz.filter === id}" class="${cz.filter === id ? 'on' : ''}">${label}</button>`).join('')}</div></div>
      ${shown.length ? `<div class="cz-grid">${shown.map(cardHtml).join('')}</div>` : `<p class="muted cz-empty">${cz.filter === 'locked' ? '¡Lo tienes todo en esta categoría!' : 'Todavía no tienes nada aquí: cambia el filtro para ver cómo conseguirlo.'}</p>`}
    </section></div>`;
  observe();
}

export async function enterCustomize() {
  wire();
  $('#shopCoins').textContent = state.coins;
  await load();
}

function wire() {
  if (cz.wired) return;
  cz.wired = true;
  const root = $('#screen-shop');
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-cz="retry"]')) return load();
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      cz.cat = cat.dataset.cat;
      cz.sel = null;
      return render();
    }
    const f = e.target.closest('[data-filter]');
    if (f) {
      cz.filter = f.dataset.filter;
      return render();
    }
    const act = e.target.closest('[data-act]');
    const card = e.target.closest('.cz-card');
    const sel = card ? itemsOf(cz.cat).find((i) => itemKey(i.category, i.id) === card.dataset.key) : itemsOf(cz.cat).find((i) => itemKey(i.category, i.id) === cz.sel);
    if (act && (card || cz.sel)) {
      const it = act.dataset.act.endsWith('-sel') ? itemsOf(cz.cat).find((i) => itemKey(i.category, i.id) === cz.sel) ?? sel : sel;
      return act.dataset.act.startsWith('buy') ? buy(it) : equip(it);
    }
    // Probar efectos (captura, victoria)
    const fx = e.target.closest('.pv-fx');
    if (fx) {
      const r = fx.getBoundingClientRect();
      burst($('.fx-layer', fx), r.width / 2, r.height / 2, fx.dataset.fx, 1.2);
      return sfx.capture();
    }
    const vic = e.target.closest('[data-victory]');
    if (vic) return victoryFx($('#celebrate'), vic.dataset.victory);
    const crown = e.target.closest('[data-crown]');
    if (crown) {
      crown.classList.remove('play');
      void crown.offsetWidth;
      crown.classList.add('play');
      return undefined;
    }
    if (card) {
      cz.sel = card.dataset.key;
      render();
      $(`.cz-card[data-key="${cz.sel}"]`)?.focus();
    }
    return undefined;
  });
  root.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('cz-card')) {
      e.preventDefault();
      cz.sel = e.target.dataset.key;
      render();
      $(`.cz-card[data-key="${cz.sel}"]`)?.focus();
    }
  });
  // Un desbloqueo concedido por el servidor mientras la página está abierta aparece sin recargar (el aviso lo da progress.js).
  document.addEventListener('checkpoint:cosmetics', () => app.screen === 'shop' && load());
  syncWallet();
}
