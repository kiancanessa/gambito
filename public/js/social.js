// Social (Fase 5, flag `social`): amigos por código, presencia, invitaciones a partida, bloqueos y reportes.
// Sin chat libre: las invitaciones y los reportes usan solo identificadores y motivos de una lista.
import { api, ensureOnline, net, socket } from './net.js';
import { createRoom, getTc, joinRoom } from './online.js';
import { flags } from './flags.js';
import { $, app, choice, confirmModal, copyText, esc, showScreen, toast } from './ui.js';

const POLL_MS = 15_000;
const INVITE_TTL = 2 * 60_000;
const PRESENCE = { online: ['En línea', 'on'], queue: ['Buscando partida', 'queue'], playing: ['Jugando', 'play'], offline: ['Desconectado', 'off'] };
const REASONS = { abuso: '🤬 Comportamiento abusivo', trampas: '🤖 Trampas', nombre: '✏️ Nombre inapropiado', otro: '❓ Otro motivo' };

const so = { data: null, invites: [], timer: null, listeners: new Set(), rivals: [], privacy: null, results: [], query: '', searching: false, searchTimer: null };
const REL_TEXT = { friends: '✔ Amigos', pending_out: '📨 Solicitud enviada', pending_in: '↩ Te ha enviado una solicitud' };

export const socialData = () => so.data;
export const onSocial = (fn) => so.listeners.add(fn);
const changed = () => so.listeners.forEach((fn) => fn(so.data));

async function connect() {
  if (!(await ensureOnline())) {
    toast('Sin conexión con el servidor');
    return false;
  }
  try {
    await socket.connect();
    return true;
  } catch {
    toast('No se pudo conectar al servidor');
    return false;
  }
}

export async function refreshSocial() {
  if (!net.user) return null;
  const [res, priv, riv] = await Promise.all([api('/api/social'), api('/api/me/privacy'), api('/api/me/rivals')]);
  if (priv.ok) so.privacy = priv.json.privacy;
  if (riv.ok) so.rivals = riv.json.rivals;
  if (res.ok) {
    so.data = res.json;
    changed();
    if (app.screen === 'social') render();
  }
  return so.data;
}

const post = (path, body) => api(path, { method: 'POST', body });
const errText = (res, fallback) => res.json?.error ?? fallback;

// ---------- Búsqueda, rivalidades y privacidad ----------
function searchHtml() {
  if (so.searching) return '<li><span class="muted">Buscando…</span></li>';
  if (!so.query || so.query.length < 2) return '<li><span class="muted">Escribe al menos 2 letras. No se muestran cuentas que han elegido no aparecer.</span></li>';
  if (!so.results.length) return '<li><span class="muted">Nadie coincide con esa búsqueda.</span></li>';
  return so.results
    .map((u) => `<li><span class="fr-name"><b>${esc(u.name)}</b> <small class="muted">${u.rating} pts${REL_TEXT[u.relation] ? ` · ${REL_TEXT[u.relation]}` : ''}</small></span>
      <span class="row-actions"><button class="btn" data-so="profile" data-id="${esc(u.id)}">Ver perfil</button>${u.relation === 'none' || u.relation === 'pending_in' ? `<button class="btn" data-so="add" data-id="${esc(u.id)}" data-name="${esc(u.name)}">${u.relation === 'pending_in' ? 'Aceptar' : 'Añadir'}</button>` : ''}</span></li>`)
    .join('');
}

function rivalsHtml() {
  if (!so.rivals.length) return '';
  return `<section class="lb-card"><p class="eyebrow">Rivalidades</p><p class="muted">Con quién más has jugado.</p><ul class="fr-list">${so.rivals
    .map((r) => `<li><span class="fr-name"><b>${esc(r.name)}</b> <small class="muted">${r.games} partidas · <b class="win">${r.wins}</b>-<b class="draw">${r.draws}</b>-<b class="loss">${r.losses}</b></small></span><span class="row-actions"><button class="btn" data-so="profile" data-id="${esc(r.id)}">Ver perfil</button></span></li>`)
    .join('')}</ul></section>`;
}

function privacyHtml() {
  const p = so.privacy;
  if (!p) return '';
  const sw = (key, label, hint) => `<label class="set-row"><span><b>${label}</b><small>${hint}</small></span><input type="checkbox" data-priv="${key}" ${p[key] ? 'checked' : ''}></label>`;
  return `<section class="lb-card"><p class="eyebrow">Privacidad</p>
    <label class="set-row"><span><b>Quién ve tu perfil</b><small>Tu enlace de perfil respeta esta elección.</small></span>
      <select data-priv="profile" aria-label="Quién ve tu perfil">${[['public', 'Todo el mundo'], ['friends', 'Solo mis amigos'], ['private', 'Nadie (solo mi nombre)']].map(([v, l]) => `<option value="${v}" ${p.profile === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${sw('searchable', 'Aparecer en la búsqueda', 'Si lo apagas, solo te encuentran con tu código de amigo.')}
    ${sw('showOnline', 'Mostrar si estoy en línea', 'Solo lo ven tus amigos.')}
    ${sw('acceptRequests', 'Aceptar solicitudes de amistad', 'Si lo apagas, nadie nuevo puede añadirte.')}
    <label class="set-row"><span><b>Invitaciones a partida</b><small>Quién puede invitarte a una partida amistosa.</small></span>
      <select data-priv="acceptInvites" aria-label="Quién puede invitarte">${[['friends', 'Mis amigos'], ['nobody', 'Nadie']].map(([v, l]) => `<option value="${v}" ${p.acceptInvites === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <button class="btn" data-so="myprofile">Ver mi perfil público</button></section>`;
}

async function runSearch(q) {
  so.query = q;
  so.searching = q.length >= 2;
  const box = $('#searchResults');
  if (box) box.innerHTML = searchHtml();
  if (q.length < 2) return;
  const res = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
  if (so.query !== q) return; // llegó tarde: ya se buscó otra cosa
  so.searching = false;
  so.results = res.ok ? res.json.users : [];
  if (!res.ok) toast(res.json?.error ?? 'No se pudo buscar', 3000);
  const again = $('#searchResults');
  if (again) again.innerHTML = searchHtml();
}

async function savePrivacy(key, value) {
  const res = await api('/api/me/privacy', { method: 'PATCH', body: { [key]: value } });
  if (res.ok) {
    so.privacy = res.json.privacy;
    toast('🔒 Privacidad actualizada', 1800);
  } else {
    toast(res.json?.error ?? 'No se pudo guardar', 3000);
  }
  render();
}

// ---------- Pantalla de amigos ----------
function render() {
  const body = $('#socialBody');
  if (!body || document.activeElement?.id === 'searchInput') return;
  const d = so.data;
  if (!d) {
    body.innerHTML = '<section class="lb-card"><p class="muted">Cargando…</p></section>';
    return;
  }
  const now = Date.now();
  so.invites = so.invites.filter((i) => now - i.at < INVITE_TTL);
  const invites = so.invites
    .map((i) => `<li><span><b>${esc(i.from.name)}</b> te invita a jugar</span><button class="btn primary" data-so="join" data-code="${esc(i.code)}">Unirme</button></li>`)
    .join('');
  const incoming = d.incoming
    .map((r) => `<li><span><b>${esc(r.name)}</b> <small class="muted">${r.rating} pts</small></span><span class="row-actions"><button class="btn primary" data-so="accept" data-id="${esc(r.id)}">Aceptar</button><button class="btn" data-so="decline" data-id="${esc(r.id)}">Rechazar</button></span></li>`)
    .join('');
  const online = d.friends.filter((f) => f.presence !== 'offline').length;
  const friends = [...d.friends]
    .sort((a, b) => (a.presence === 'offline') - (b.presence === 'offline') || a.name.localeCompare(b.name))
    .map((f) => {
      const [label, cls] = PRESENCE[f.presence] ?? PRESENCE.offline;
      return `<li><span class="fr-name"><i class="pdot ${cls}" title="${label}"></i><b>${esc(f.name)}</b> <small class="muted">${f.rating} pts · ${label}</small></span>
        <span class="row-actions"><button class="btn" data-so="profile" data-id="${esc(f.id)}" aria-label="Ver el perfil de ${esc(f.name)}">Perfil</button>${f.presence === 'offline' ? '' : `<button class="btn" data-so="challenge" data-id="${esc(f.id)}" data-name="${esc(f.name)}">Retar</button>`}
        <button class="btn" data-so="remove" data-id="${esc(f.id)}" data-name="${esc(f.name)}" aria-label="Quitar a ${esc(f.name)}">✖</button>
        <button class="btn" data-so="block" data-id="${esc(f.id)}" data-name="${esc(f.name)}" aria-label="Bloquear a ${esc(f.name)}">🚫</button></span></li>`;
    })
    .join('');
  const outgoing = d.outgoing.map((r) => `<li><span>${esc(r.name)} <small class="muted">pendiente</small></span><button class="btn" data-so="cancel" data-id="${esc(r.id)}">Cancelar</button></li>`).join('');
  const blocked = d.blocked.map((b) => `<li><span>${esc(b.name)}</span><button class="btn" data-so="unblock" data-id="${esc(b.id)}">Desbloquear</button></li>`).join('');
  body.innerHTML = `
    <section class="lb-card"><p class="eyebrow">Tu código de amigo</p>
      <div class="friend-code"><b id="myFriendCode">${esc(d.code)}</b><button class="btn" data-so="copy">📋 Copiar</button></div>
      <p class="muted">Compártelo con quien quieras como amigo. Solo se usa para enviarte solicitudes.</p>
      <form class="join-form" id="addFriendForm"><input id="addFriendCode" placeholder="Código de un amigo (ABCD-EFGH)" autocomplete="off" maxlength="12" aria-label="Código de amigo"><button class="btn primary" type="submit">Añadir</button></form></section>
    <section class="lb-card"><p class="eyebrow">Buscar jugadores</p>
      <form class="join-form" id="searchForm" role="search"><input id="searchInput" type="search" value="${esc(so.query)}" placeholder="Busca por nombre (mínimo 2 letras)" autocomplete="off" maxlength="16" aria-label="Buscar jugadores por nombre"><button class="btn" type="submit">Buscar</button></form>
      <ul class="fr-list" id="searchResults" aria-live="polite">${searchHtml()}</ul></section>
    ${invites ? `<section class="lb-card"><p class="eyebrow">Invitaciones</p><ul class="fr-list">${invites}</ul></section>` : ''}
    ${incoming ? `<section class="lb-card"><p class="eyebrow">Solicitudes recibidas</p><ul class="fr-list">${incoming}</ul></section>` : ''}
    <section class="lb-card"><div class="card-head"><p class="eyebrow">Amigos</p><span class="pill ${online ? 'ok' : ''}">${online} en línea</span></div>
      ${friends ? `<ul class="fr-list">${friends}</ul>` : '<p class="muted">Aún no tienes amigos. Pide su código o comparte el tuyo.</p>'}</section>
    ${rivalsHtml()}
    ${outgoing ? `<section class="lb-card"><p class="eyebrow">Solicitudes enviadas</p><ul class="fr-list">${outgoing}</ul></section>` : ''}
    ${blocked ? `<section class="lb-card"><p class="eyebrow">Bloqueados</p><ul class="fr-list">${blocked}</ul></section>` : ''}
    ${privacyHtml()}`;
}

export async function enterSocial() {
  showScreen('social');
  render();
  if (!(await connect())) return;
  await refreshSocial();
  clearInterval(so.timer);
  so.timer = setInterval(() => (app.screen === 'social' ? !document.hidden && refreshSocial() : clearInterval(so.timer)), POLL_MS);
}

// ---------- Acciones ----------
async function addByCode(code) {
  const res = await post('/api/social/request', { code });
  if (!res.ok) return toast(errText(res, 'No se pudo enviar la solicitud'));
  toast(res.json.status === 'friends' ? `🎉 Ahora eres amigo de ${res.json.user.name}` : `📨 Solicitud enviada a ${res.json.user.name}`);
  return refreshSocial();
}

async function challenge(id, name) {
  if (!(await connect())) return;
  // Crea una sala con el control elegido y, en cuanto exista, invita a ese amigo.
  const off = socket.on('created', () => {
    off();
    socket.send({ t: 'invite', to: id });
    toast(`⚔ Invitación enviada a ${name}`);
  });
  await createRoom({ tc: getTc(), color: 'r' });
}

async function act(el) {
  const { so: action, id, name, code } = el.dataset;
  if (action === 'copy') {
    await copyText($('#myFriendCode').textContent);
    return toast('Código copiado');
  }
  if (action === 'join') return joinRoom(code);
  if (action === 'profile') return app.openUser?.(id);
  if (action === 'myprofile') return app.openUser?.(net.user.id);
  if (action === 'add') {
    const res = await post('/api/social/request', { id });
    toast(res.ok ? (res.json.status === 'friends' ? `🎉 Ahora eres amigo de ${name}` : `📨 Solicitud enviada a ${name}`) : errText(res, 'No se pudo enviar la solicitud'), 3500);
    so.results = so.results.map((u) => (u.id === id && res.ok ? { ...u, relation: res.json.status === 'friends' ? 'friends' : 'pending_out' } : u));
    const box = $('#searchResults');
    if (box) box.innerHTML = searchHtml();
    return refreshSocial();
  }
  if (action === 'challenge') return challenge(id, name);
  if (action === 'accept' || action === 'decline') {
    const res = await post('/api/social/respond', { id, accept: action === 'accept' });
    if (!res.ok) toast(errText(res, 'No se pudo responder'));
    return refreshSocial();
  }
  if (action === 'remove' || action === 'cancel') {
    if (action === 'remove' && !(await confirmModal(`¿Quitar a ${name}?`, 'Dejaréis de ser amigos.', 'Quitar', 'Cancelar'))) return undefined;
    await post('/api/social/remove', { id });
    return refreshSocial();
  }
  if (action === 'block') return blockPlayer(id, name);
  if (action === 'unblock') {
    await post('/api/social/unblock', { id });
    return refreshSocial();
  }
  return undefined;
}

async function blockPlayer(id, name) {
  if (!(await confirmModal(`¿Bloquear a ${name}?`, 'No podrá enviarte solicitudes ni invitaciones y no os emparejaremos. Puedes desbloquearlo después.', 'Bloquear', 'Cancelar'))) return;
  const res = await post('/api/social/block', { id });
  toast(res.ok ? `🚫 ${name} bloqueado` : errText(res, 'No se pudo bloquear'));
  refreshSocial();
}

// Menú sobre un jugador con quien estás jugando (o has jugado): añadir amigo, reportar o bloquear.
export async function openPlayerMenu({ id, name }) {
  if (!id || id.startsWith('bot-')) return;
  const pick = await choice(`<h3>${esc(name)}</h3>
    <div class="share-options">
      <button class="btn primary" data-choice="friend">➕ Añadir a amigos</button>
      <button class="btn" data-choice="report">🚩 Reportar</button>
      <button class="btn danger" data-choice="block">🚫 Bloquear</button>
      <button class="btn" data-choice="close">Cerrar</button>
    </div>`);
  if (pick === 'friend') {
    const res = await post('/api/social/request', { id });
    toast(res.ok ? (res.json.status === 'friends' ? `🎉 Ahora eres amigo de ${name}` : `📨 Solicitud enviada a ${name}`) : errText(res, 'No se pudo enviar la solicitud'));
  } else if (pick === 'block') {
    await blockPlayer(id, name);
  } else if (pick === 'report') {
    const reason = await choice(`<h3>Reportar a ${esc(name)}</h3><p class="muted">Revisamos los reportes. Elige el motivo:</p>
      <div class="share-options">${Object.entries(REASONS).map(([k, v]) => `<button class="btn" data-choice="${k}">${v}</button>`).join('')}<button class="btn" data-choice="close">Cancelar</button></div>`);
    if (reason !== 'close') {
      const res = await post('/api/report', { id, reason });
      toast(res.ok ? '✅ Reporte enviado. ¡Gracias!' : errText(res, 'No se pudo enviar el reporte'), 3500);
    }
  }
}

// Desde la sala de espera: elegir a qué amigo en línea invitar.
export async function pickFriendToInvite() {
  const d = (await refreshSocial()) ?? so.data;
  const online = d?.friends.filter((f) => f.presence !== 'offline') ?? [];
  if (!online.length) return toast(d?.friends.length ? 'Ningún amigo está conectado ahora mismo' : 'Aún no tienes amigos: añade uno con su código en Amigos');
  const pick = await choice(`<h3>Invitar a un amigo</h3><div class="share-options">${online
    .map((f) => `<button class="btn" data-choice="${esc(f.id)}">${esc(f.name)} <small class="muted">${PRESENCE[f.presence][0]}</small></button>`)
    .join('')}<button class="btn" data-choice="close">Cancelar</button></div>`);
  if (pick && pick !== 'close') socket.send({ t: 'invite', to: pick });
  return undefined;
}

export const challengeFriend = challenge;

// ---------- Arranque ----------
async function onInvite(m) {
  const busy = app.screen === 'game' && app.game && !app.game.over;
  so.invites = [...so.invites.filter((i) => i.from.id !== m.from.id), { ...m, at: Date.now() }];
  if (app.screen === 'social') render();
  if (busy) return toast(`⚔ ${m.from.name} te invita a jugar (míralo en Amigos al terminar)`, 4500);
  const pick = await choice(`<div class="result win"><p class="eyebrow">Invitación</p><h2>${esc(m.from.name)}</h2>
    <p>Te invita a una partida amistosa.</p>
    <div class="modal-actions"><button class="btn primary" data-choice="join">⚔ Aceptar</button><button class="btn" data-choice="no">Ahora no</button></div></div>`, 'result-card');
  if (pick === 'join') {
    so.invites = so.invites.filter((i) => i.code !== m.code);
    return joinRoom(m.code);
  }
  return undefined;
}

export function initSocial() {
  if (!flags.social) return;
  $('[data-wait="invite"]').hidden = false;
  socket.on('invite', onInvite);
  socket.on('invited', () => toast('📨 Invitación enviada'));
  socket.on('friend_request', (m) => {
    toast(`👥 ${m.from.name} quiere ser tu amigo`, 4000);
    refreshSocial();
  });
  socket.on('friends_changed', () => refreshSocial());

  $('#screen-social').addEventListener('click', (e) => {
    const el = e.target.closest('[data-so]');
    if (el) act(el);
  });
  $('#screen-social').addEventListener('input', (e) => {
    if (e.target.id !== 'searchInput') return;
    clearTimeout(so.searchTimer);
    const q = e.target.value.trim();
    so.searchTimer = setTimeout(() => runSearch(q), 350);
  });
  $('#screen-social').addEventListener('change', (e) => {
    const key = e.target.dataset?.priv;
    if (key) savePrivacy(key, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
  });
  $('#screen-social').addEventListener('submit', (e) => {
    if (e.target.id === 'searchForm') {
      e.preventDefault();
      clearTimeout(so.searchTimer);
      runSearch($('#searchInput').value.trim());
      return;
    }
    if (e.target.id !== 'addFriendForm') return;
    e.preventDefault();
    const code = $('#addFriendCode').value.trim();
    if (code.replace(/[^A-Za-z0-9]/g, '').length < 8) return toast('Escribe el código completo (8 caracteres)');
    $('#addFriendCode').value = '';
    return addByCode(code);
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-wait="invite"]')) pickFriendToInvite();
    const menu = e.target.closest('#oppMenuBtn');
    if (menu) openPlayerMenu({ id: menu.dataset.id, name: menu.dataset.name });
  });
}
