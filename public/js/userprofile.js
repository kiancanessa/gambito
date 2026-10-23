// Perfil público de un jugador (se carga a demanda): lo que esa persona decidió mostrar, el historial entre tú y ella,
// y las acciones sociales (añadir, retar, bloquear, reportar, copiar enlace). Todo lo valida el servidor: aquí solo se muestra.
import { decorClass, identityHtml, titleOf } from './cosmetics-art.js';
import { GLYPH, leagueOf } from './data.js';
import { api, net } from './net.js';
import { openReplay, tcName } from './replay.js';
import { challengeFriend } from './social.js';
import { $, app, choice, confirmModal, copyText, esc, showScreen, toast, VS } from './ui.js';

const REASONS = { abuso: '🤬 Comportamiento abusivo', trampas: '🤖 Trampas', nombre: '✏️ Nombre inapropiado', otro: '❓ Otro motivo' };
const PRESENCE = { online: 'En línea', queue: 'Buscando partida', playing: 'Jugando', offline: 'Desconectado' };
const PLACE = { champion: '🏆 Campeón', final: '🥈 Subcampeón', semi: '🥉 Semifinalista' };
const RESULT = { win: ['Victoria', 'win'], loss: ['Derrota', 'loss'], draw: ['Tablas', 'draw'] };
const date = (t) => new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'short' });

const us = { id: null, profile: null, error: null, busy: false };

async function load(id) {
  us.id = id;
  us.profile = null;
  us.error = null;
  render();
  const res = await api(`/api/users/${encodeURIComponent(id)}`, { auth: !!net.user });
  if (us.id !== id) return;
  if (res.ok) us.profile = res.json.profile;
  else us.error = res.status === 404 ? 'Este jugador no existe o no está disponible.' : res.status === 429 ? 'Demasiadas peticiones: espera un momento.' : 'No se pudo cargar el perfil. Inténtalo de nuevo.';
  render();
}

function gameRow(g, mine = false) {
  const [label, cls] = RESULT[g.result] ?? RESULT.draw;
  const who = g.white ? `${esc(g.white)} vs ${esc(g.black)}` : esc(tcName(g.tc));
  return `<li><span class="us-res ${cls}">${label}</span><span><b>${who}</b><small class="muted">${esc(g.kind === 'circuit' ? '🏆 Torneo · ' : '')}${esc(tcName(g.tc))} · ${Math.ceil(g.plies / 2)} jugadas · ${date(g.at)}</small></span>
    <button class="btn" ${mine ? `data-us="replay" data-id="${esc(g.id)}"` : `data-us="public-replay" data-id="${esc(g.id)}"`}>▶ Repetir</button></li>`;
}

function render() {
  const body = $('#userBody');
  if (!body) return;
  if (us.error) {
    body.innerHTML = `<section class="lb-card" role="alert"><p class="eyebrow">No disponible</p><h3>${esc(us.error)}</h3><button class="btn" data-go="social">Volver a Amigos</button></section>`;
    return;
  }
  const p = us.profile;
  if (!p) {
    body.innerHTML = '<section class="lb-card" aria-busy="true"><p class="muted">Cargando perfil…</p></section>';
    return;
  }
  const lg = leagueOf(p.rating ?? 1000);
  const eq = p.identity ?? {};
  const title = titleOf(eq);
  const can = p.viewerCan ?? {};
  const rel = p.relation;
  const actions = [
    can.request ? '<button class="btn primary" data-us="add">➕ Añadir a amigos</button>' : '',
    rel === 'pending_out' ? '<button class="btn" disabled>📨 Solicitud enviada</button>' : '',
    rel === 'pending_in' ? '<button class="btn primary" data-us="add">✔ Aceptar solicitud</button>' : '',
    can.invite ? '<button class="btn primary" data-us="challenge">⚔ Retar</button>' : '',
    rel === 'friends' ? '<button class="btn" data-us="remove">Quitar amigo</button>' : '',
    '<button class="btn" data-us="copy">🔗 Copiar enlace</button>',
    can.report ? '<button class="btn" data-us="report">🚩 Reportar</button>' : '',
    can.block ? '<button class="btn danger" data-us="block">🚫 Bloquear</button>' : '',
    rel === 'self' ? '<button class="btn" data-go="social">⚙ Privacidad</button>' : '',
  ].join('');
  const head = `<section class="lb-card us-hero ${decorClass(eq)}">
    <div class="us-id">${identityHtml(eq, { size: 96, label: `Avatar de ${esc(p.name)}` })}</div>
    <div class="us-name"><p class="eyebrow">${p.rating !== undefined && p.ranked ? `Liga ${esc(lg.name)} · ${GLYPH[lg.glyph]}${VS}` : 'Jugador'}</p><h3>${esc(p.name)}</h3>
      ${title ? `<p class="pf-title">${esc(title)}</p>` : ''}
      <p class="muted">${p.level ? `Nivel ${p.level}` : ''}${p.rating !== undefined ? (p.ranked ? ` · ${p.rating} pts` : ' · Sin clasificar') : ''}${p.rank ? ` · puesto #${p.rank}` : ''}${p.presence && p.presence !== 'offline' ? ` · <b class="ok">${PRESENCE[p.presence]}</b>` : ''}</p></div>
    <div class="us-actions">${actions}</div></section>`;
  let rest = '';
  if (p.limited) {
    const why = p.visibility === 'friends' ? 'Esta persona solo comparte su perfil completo con sus amigos.' : 'Esta persona ha elegido mantener su perfil privado.';
    rest = `<section class="lb-card"><p class="eyebrow">Perfil reservado</p><p class="muted">${why}</p></section>`;
  } else {
    const st = p.stats;
    const stats = [[st.games, 'Partidas clasificatorias'], [st.wins, 'Victorias'], [st.losses, 'Derrotas'], [st.draws, 'Tablas'], [`${p.achievements.done}/${p.achievements.total}`, 'Logros'], [p.champion, 'Torneos ganados']];
    const h2h = p.h2h && p.h2h.games
      ? `<section class="lb-card"><div class="card-head"><p class="eyebrow">Tú contra ${esc(p.name)}</p><span class="pill">${p.h2h.games} partida${p.h2h.games > 1 ? 's' : ''}</span></div>
          <p class="us-h2h"><b class="win">${p.h2h.wins}</b> ganadas · <b class="draw">${p.h2h.draws}</b> tablas · <b class="loss">${p.h2h.losses}</b> perdidas</p>
          <ul class="us-games">${p.h2h.recent.map((g) => gameRow({ ...g, at: g.at }, true)).join('')}</ul></section>`
      : p.h2h
        ? `<section class="lb-card"><p class="eyebrow">Tú contra ${esc(p.name)}</p><p class="muted">Todavía no habéis jugado una partida.</p></section>`
        : '';
    rest = `<section class="lb-card"><p class="eyebrow">Estadísticas</p><ul class="stat-grid">${stats.map(([n, l]) => `<li><b>${n}</b><small>${l}</small></li>`).join('')}</ul>
        ${p.season ? `<p class="muted">Temporada ${p.season.id}: rating ${p.season.rating} · ${p.season.games} partidas</p>` : ''}</section>
      ${h2h}
      ${p.trophies.length ? `<section class="lb-card"><p class="eyebrow">Trofeos</p><ul class="trophy-list">${p.trophies.map((t) => `<li><span><b>${PLACE[t.placement] ?? t.placement}</b><small>${date(t.at)}</small></span></li>`).join('')}</ul></section>` : ''}
      <section class="lb-card"><p class="eyebrow">Partidas públicas recientes</p>${p.recent.length ? `<ul class="us-games">${p.recent.map((g) => gameRow(g)).join('')}</ul>` : '<p class="muted">Aún no hay partidas públicas (clasificatorias o de torneo).</p>'}</section>`;
  }
  body.innerHTML = `${head}${rest}`;
}

async function act(action) {
  const p = us.profile;
  if (!p || us.busy) return;
  us.busy = true;
  try {
    if (action === 'copy') {
      await copyText(`${location.origin}${p.link}`);
      toast('🔗 Enlace del perfil copiado');
    } else if (action === 'add') {
      const res = await api('/api/social/request', { method: 'POST', body: { id: p.id } });
      toast(res.ok ? (res.json.status === 'friends' ? `🎉 Ahora eres amigo de ${p.name}` : `📨 Solicitud enviada a ${p.name}`) : (res.json?.error ?? 'No se pudo enviar la solicitud'), 3500);
      await load(p.id);
    } else if (action === 'remove') {
      if (await confirmModal(`¿Quitar a ${p.name}?`, 'Dejaréis de ser amigos.', 'Quitar', 'Cancelar')) {
        await api('/api/social/remove', { method: 'POST', body: { id: p.id } });
        await load(p.id);
      }
    } else if (action === 'challenge') {
      await challengeFriend(p.id, p.name);
    } else if (action === 'block') {
      if (await confirmModal(`¿Bloquear a ${p.name}?`, 'No podrá enviarte solicitudes ni invitaciones y no veréis el perfil del otro. Puedes desbloquearlo después.', 'Bloquear', 'Cancelar')) {
        const res = await api('/api/social/block', { method: 'POST', body: { id: p.id } });
        toast(res.ok ? `🚫 ${p.name} bloqueado` : (res.json?.error ?? 'No se pudo bloquear'));
        if (res.ok) app.go('social');
      }
    } else if (action === 'report') {
      const reason = await choice(`<h3>Reportar a ${esc(p.name)}</h3><p class="muted">Revisamos los reportes; no hay sanciones automáticas. Elige el motivo:</p>
        <div class="share-options">${Object.entries(REASONS).map(([k, v]) => `<button class="btn" data-choice="${k}">${v}</button>`).join('')}<button class="btn" data-choice="close">Cancelar</button></div>`);
      if (reason && reason !== 'close') {
        const res = await api('/api/report', { method: 'POST', body: { id: p.id, reason, ctx: 'profile' } });
        toast(res.ok ? '✅ Reporte enviado. ¡Gracias!' : (res.json?.error ?? 'No se pudo enviar el reporte'), 3500);
      }
    }
  } finally {
    us.busy = false;
  }
}

let wired = false;
export async function enterUser(id) {
  showScreen('user');
  if (!wired) {
    wired = true;
    $('#screen-user').addEventListener('click', (e) => {
      const b = e.target.closest('[data-us]');
      if (!b) return;
      if (b.dataset.us === 'replay') return openReplay(b.dataset.id);
      if (b.dataset.us === 'public-replay') return openReplay(b.dataset.id, { publicGame: true });
      return act(b.dataset.us);
    });
  }
  await load(id);
}
