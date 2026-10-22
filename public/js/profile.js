// Perfil: identidad y rango arriba; debajo, por pestañas, el resumen (estadísticas y trofeos), los logros y la cuenta.
import { CAMPAIGN, GLYPH, LEAGUES, leagueOf } from './data.js';
import { api, net, newRecoveryCode, onNet, recoverAccount, renameUser, syncDown, pushNow } from './net.js';
import { decorClass, identityHtml, titleOf } from './cosmetics-art.js';
import { state } from './store.js';
import { $, app, copyText, esc, showScreen, toast, VS } from './ui.js';

const ago = (t) => {
  if (!t) return 'aún no';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'hace un momento' : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`;
};

// Insignias: todas se calculan con datos reales del jugador (progreso local y servidor).
function badges(extra) {
  const st = state.stats;
  const list = [
    { id: 'first', name: 'Primera sangre', text: 'Gana tu primera partida', have: st.wins, need: 1 },
    { id: 'wins10', name: 'En racha', text: 'Gana 10 partidas', have: st.wins, need: 10 },
    { id: 'online5', name: 'Competidor', text: 'Gana 5 partidas online', have: st.onlineWins, need: 5 },
    { id: 'promo', name: 'Corona', text: 'Corona un peón', have: st.promotions, need: 1 },
    { id: 'checks50', name: 'Acosador', text: 'Da 50 jaques', have: st.checks, need: 50 },
    { id: 'daily7', name: 'Mente aguda', text: 'Resuelve 7 desafíos diarios', have: st.dailySolved, need: 7 },
    { id: 'campaign', name: 'Graduado', text: 'Supera las pruebas finales de la Academia', have: state.campaign.cleared, need: CAMPAIGN.length },
    { id: 'academy', name: 'Estudiante', text: 'Completa 5 lecciones de la Academia', have: Object.keys(state.academy?.lessons ?? {}).length, need: 5 },
    { id: 'tutorial', name: 'Aprendiz', text: 'Completa el tutorial', have: state.tutorialDone ? 1 : 0, need: 1 },
    { id: 'circuit', name: 'Finalista', text: 'Llega a la final del Circuit', have: extra.circuitFinals, need: 1 },
  ];
  return list.map((b) => ({ ...b, done: b.have >= b.need }));
}

function leagueProgress(rating) {
  const i = LEAGUES.findIndex((l) => l.id === leagueOf(rating).id);
  const cur = LEAGUES[i];
  const next = LEAGUES[i + 1];
  if (!next) return { cur, next: null, pct: 100, left: 0 };
  return { cur, next, pct: Math.min(100, ((rating - cur.min) / (next.min - cur.min)) * 100), left: next.min - rating };
}

// Pestañas del perfil: lo importante (identidad y rango) siempre arriba; el resto, a un clic.
const TABS = [['summary', 'Resumen'], ['badges', 'Logros'], ['account', 'Cuenta']];
let tab = 'summary';

function render(extra) {
  const body = $('#profileBody');
  const u = net.user;
  if (!body) return;
  if (!u) {
    body.innerHTML = `<section class="lb-card"><p class="eyebrow">Sin conexión</p><h3>No se pudo cargar tu perfil</h3>
      <p class="muted">Tu progreso local sigue a salvo en este dispositivo. Conéctate para ver tu liga y gestionar tu cuenta.</p>
      <button class="btn primary" data-pf="retry">Reintentar</button></section>`;
    return;
  }
  const lg = leagueOf(u.rating);
  const pr = leagueProgress(u.rating);
  const st = state.stats;
  const bs = badges(extra);
  const earned = bs.filter((b) => b.done).length;
  const head = `
    <section class="pf-hero ${decorClass()}">
      <div class="pf-emblem" style="--c:${lg.color}">${identityHtml(state.equipped, { size: 76, label: `Avatar de ${esc(u.name)}` })}</div>
      <div class="pf-id">
        <h3 class="pf-name">${esc(u.name)}</h3>
        ${titleOf() ? `<p class="pf-title">${esc(titleOf())}</p>` : ''}
        <p class="pf-rating"><span class="pf-league" style="--c:${lg.color}">${GLYPH[lg.glyph]}${VS} Liga ${esc(lg.name)}</span><b>${u.rating}</b> pts${extra.rank && u.games > 0 ? ` · puesto #${extra.rank}` : ''} · nivel ${state.level}</p>
        <div class="lg-bar" role="progressbar" aria-label="Progreso de liga" aria-valuenow="${Math.round(pr.pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pr.pct}%"></i></div>
        <small class="muted">${pr.next ? `${pr.left} pts para la liga ${pr.next.name}` : 'Liga máxima alcanzada'}</small>
      </div>
    </section>
    <nav class="pf-links" aria-label="Tu cuenta">
      <button class="btn" data-go="history">Historial</button>
      <button class="btn" data-go="progress">Progreso y misiones</button>
      <button class="btn" data-go="shop">Personalizar</button>
      <button class="btn" data-go="social">Amigos</button>
    </nav>
    <div class="seg pf-tabs" role="tablist" aria-label="Secciones del perfil">${TABS.map(([id, l]) => `<button role="tab" data-pft="${id}" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}">${l}${id === 'badges' ? ` <small>${earned}/${bs.length}</small>` : ''}</button>`).join('')}</div>`;

  let section;
  if (tab === 'badges') {
    section = `<section class="lb-card">
        <p class="muted fine">Insignias calculadas con tus datos. Los logros que verifica el servidor (y sus premios) están en <button class="link-btn" data-go="progress">Progreso</button>.</p>
        <ul class="badge-grid">${bs.map((b) => `<li class="${b.done ? 'done' : ''}" title="${esc(b.text)}"><i>${b.done ? '✔' : ''}</i><b>${esc(b.name)}</b><small>${b.done ? esc(b.text) : `${Math.min(b.have, b.need)}/${b.need} · ${esc(b.text)}`}</small></li>`).join('')}</ul>
      </section>`;
  } else if (tab === 'account') {
    section = `<section class="lb-card pf-account">
        <label class="pf-field">Nombre público
          <span class="pf-row"><input id="pfName" value="${esc(u.name)}" maxlength="16" autocomplete="off"><button class="btn primary" data-pf="rename">Guardar</button></span>
        </label>
        <div class="pf-field">Código de recuperación
          <span class="pf-row"><code id="pfCode">${esc(net.auth?.recovery ?? '—')}</code><button class="btn" data-pf="copy">Copiar</button></span>
          <small>Guárdalo: con él recuperas tu cuenta y tu progreso en otro dispositivo.</small>
          <button class="link-btn" data-pf="regen">Generar un código nuevo</button>
        </div>
        <div class="pf-field">Usar otra cuenta
          <span class="pf-row"><input id="pfRecover" placeholder="XXXX-XXXX-XXXX" maxlength="14" autocomplete="off"><button class="btn" data-pf="recover">Recuperar</button></span>
        </div>
        <p class="pf-sync">Progreso sincronizado: ${ago(net.lastSync)} · <button class="link-btn" data-pf="sync">Sincronizar ahora</button></p>
      </section>`;
  } else {
    const main = [[u.wins, 'Victorias'], [u.losses, 'Derrotas'], [u.draws, 'Tablas'], [u.games, 'Clasificatorias']];
    const more = [[st.games, 'Partidas en total'], [st.checks, 'Jaques'], [st.captures, 'Capturas'], [st.promotions, 'Coronaciones'], [st.dailySolved, 'Desafíos resueltos']];
    section = `<section class="lb-card">
        <ul class="pf-stats">${main.map(([n, l]) => `<li><b>${n}</b><small>${l}</small></li>`).join('')}</ul>
        <p class="pf-more">${more.map(([n, l]) => `<span><b>${n}</b> ${l.toLowerCase()}</span>`).join('')}</p>
      </section>
      <section class="lb-card">
        <div class="card-head"><p class="eyebrow">Trofeos</p></div>
        ${extra.trophies.length
          ? `<ul class="trophy-list">${extra.trophies.map((t) => `<li class="${t.placement}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-trophy"/></svg><span><b>${t.label}</b><small>${new Date(t.at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}</small></span></li>`).join('')}</ul>`
          : '<p class="muted">Aún no tienes trofeos. Se consiguen llegando a semifinales en el Royale Circuit.</p>'}
      </section>`;
  }
  body.innerHTML = `<div class="pf">${head}${section}</div>`;
}

// Datos extra del servidor: puesto en la clasificación y trofeos del Circuit.
async function loadExtra() {
  const extra = { rank: null, trophies: [], circuitFinals: 0 };
  if (!net.user) return extra;
  const [me, circuit] = await Promise.all([api('/api/me'), api('/api/circuit/me')]);
  if (me.ok) extra.rank = me.json.rank;
  if (circuit.ok) {
    const label = { champion: 'Campeón del Royale Circuit', final: 'Finalista del Royale Circuit', semi: 'Semifinalista del Royale Circuit', quarter: 'Cuartos del Royale Circuit' };
    extra.trophies = circuit.json.results.filter((r) => label[r.placement] && r.placement !== 'quarter').map((r) => ({ placement: r.placement, label: label[r.placement], at: r.at }));
    extra.circuitFinals = circuit.json.results.filter((r) => r.placement === 'final' || r.placement === 'champion').length;
  }
  return extra;
}

let current = { rank: null, trophies: [], circuitFinals: 0 };

export async function enterProfile() {
  showScreen('profile');
  render(current);
  current = await loadExtra();
  if (app.screen === 'profile') render(current);
}

async function onAction(e) {
  const t = e.target.closest('[data-pft]');
  if (t) {
    tab = t.dataset.pft;
    return render(current);
  }
  const b = e.target.closest('[data-pf]');
  if (!b) return undefined;
  const act = b.dataset.pf;
  if (act === 'retry') return enterProfile();
  if (act === 'rename') {
    const res = await renameUser($('#pfName').value);
    toast(res.ok ? '✓ Nombre actualizado' : res.json?.error ?? 'No se pudo cambiar el nombre');
  } else if (act === 'copy') {
    toast((await copyText(net.auth?.recovery ?? '')) ? '📋 Código copiado' : 'No se pudo copiar');
  } else if (act === 'regen') {
    const res = await newRecoveryCode();
    toast(res.ok ? 'Nuevo código generado: guárdalo' : 'No se pudo generar');
  } else if (act === 'recover') {
    const code = $('#pfRecover').value.trim();
    if (code.replace(/[^A-Za-z0-9]/g, '').length !== 12) return toast('El código tiene 12 caracteres (XXXX-XXXX-XXXX)');
    const res = await recoverAccount(code);
    toast(res.ok ? `✓ Sesión de ${res.json.user.name} recuperada` : res.json?.error ?? 'No se pudo recuperar');
    if (res.ok) {
      current = await loadExtra();
      app.refreshHome();
    }
  } else if (act === 'sync') {
    await pushNow();
    await syncDown();
    toast('☁ Sincronizado');
  }
  render(current);
  return undefined;
}

// Pone al día el avatar de la barra superior cuando cambia el equipamiento.
let idKey = '';
export function refreshIdentity() {
  const el = $('#profileGlyph');
  if (!el) return;
  const e = state.equipped;
  const key = `${e.avatar}|${e.frame}`;
  if (key === idKey) return;
  idKey = key;
  el.innerHTML = identityHtml(e, { size: 28, badge: false });
}

export function initProfile() {
  $('#profileChip').addEventListener('click', () => app.go('profile'));
  $('#profileBody').addEventListener('click', onAction);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open="profile"]')) app.go('profile');
  });
  onNet(() => {
    const chip = $('#profileChip');
    chip.hidden = !net.user;
    if (net.user) {
      const lg = leagueOf(net.user.rating);
      void lg;
      $('#profileGlyph').innerHTML = identityHtml(state.equipped, { size: 28, badge: false });
      $('#profileName').textContent = net.user.name;
      if (app.screen === 'profile') render(current);
    }
  });

  // Instalación como app (PWA).
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#installBtn').hidden = true;
  });
}

// Compatibilidad: otras pantallas llaman a openProfile().
export const openProfile = () => app.go('profile');
