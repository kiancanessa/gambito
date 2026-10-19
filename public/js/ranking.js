// Clasificaciones: liga (Elo), desafío diario y campeones del Royale Circuit.
import { GLYPH, LEAGUES, leagueOf } from './data.js';
import { api, ensureOnline, net } from './net.js';
import { $, $$, app, esc, fmtDuration, showScreen, VS } from './ui.js';

let tab = 'elo';
const medal = (rank) => (rank <= 3 ? `<i class="medal m${rank}" aria-label="Puesto ${rank}">${rank}</i>` : `<i class="rk">${rank}</i>`);
const offline = '<section class="lb-card"><p class="eyebrow">Sin conexión</p><h3>No se pudo cargar</h3><p class="muted">Las clasificaciones se calculan en el servidor. Comprueba tu conexión.</p><button class="btn primary" data-rk="retry">Reintentar</button></section>';

async function renderElo() {
  const res = await api('/api/leaderboard?limit=50');
  if (!res.ok) return offline;
  const { top, me } = res.json;
  const meId = net.user?.id;
  const rows = top.map((r) => {
    const lg = leagueOf(r.rating);
    return `<li class="rk-row ${r.id === meId ? 'me' : ''}">${medal(r.rank)}<span class="emblem sm" style="--c:${lg.color}"><i>${GLYPH[lg.glyph]}${VS}</i></span><span class="rk-name"><b>${esc(r.name)}</b><small>Liga ${lg.name} · ${r.games} partidas</small></span><em>${r.rating}</em></li>`;
  }).join('');
  const mine = me && net.user?.games > 0
    ? `<section class="lb-card rk-me"><p class="eyebrow">Tu posición</p><div class="rk-me-row"><b>#${me.rank}</b><span>${me.rating} pts · Liga ${leagueOf(me.rating).name}</span></div></section>`
    : `<section class="lb-card rk-me"><p class="eyebrow">Tu posición</p><p class="muted">Juega tu primera clasificatoria para entrar en la tabla.</p><button class="btn primary" data-go="lobby">Jugar ahora</button></section>`;
  const ladder = LEAGUES.map((l) => `<li style="--c:${l.color}"><span class="emblem sm" style="--c:${l.color}"><i>${GLYPH[l.glyph]}${VS}</i></span><b>${l.name}</b><small>desde ${l.min}</small></li>`).join('');
  return `<div class="rank-layout"><section class="lb-card"><div class="card-head"><p class="eyebrow">Top ${top.length}</p><span class="pill">Elo</span></div>
      ${rows ? `<ol class="rk-list">${rows}</ol>` : '<p class="muted">Aún no hay partidas clasificatorias. ¡Sé el primero!</p>'}</section>
    <aside class="rank-side">${mine}<section class="lb-card"><p class="eyebrow">Ligas</p><ul class="ladder">${ladder}</ul></section></aside></div>`;
}

async function renderDaily() {
  const res = await api('/api/daily');
  if (!res.ok) return offline;
  const d = res.json;
  const rows = d.top.map((r) => `<li class="rk-row ${r.id === net.user?.id ? 'me' : ''}">${medal(r.rank)}<span class="rk-name"><b>${esc(r.name)}</b><small>${r.attempts} intento${r.attempts > 1 ? 's' : ''}</small></span><em>${fmtDuration(r.seconds)}</em></li>`).join('');
  return `<div class="rank-layout"><section class="lb-card"><div class="card-head"><p class="eyebrow">Desafío #${d.number} · mate en ${d.mateIn}</p><span class="pill">${d.solvedCount} resuelto${d.solvedCount === 1 ? '' : 's'}</span></div>
      ${rows ? `<ol class="rk-list">${rows}</ol>` : '<p class="muted">Nadie ha resuelto el desafío de hoy todavía.</p>'}</section>
    <aside class="rank-side"><section class="lb-card"><p class="eyebrow">Tu resultado</p>
      ${d.mine ? `<div class="rk-me-row"><b>#${d.mine.rank}</b><span>${fmtDuration(d.mine.seconds)} · ${d.mine.attempts} intento${d.mine.attempts > 1 ? 's' : ''}</span></div>` : '<p class="muted">Aún no lo has resuelto hoy.</p><button class="btn primary" data-go="daily">Resolver ahora</button>'}</section></aside></div>`;
}

async function renderCircuit() {
  const [pub, mine] = await Promise.all([api('/api/circuit', { auth: false }), api('/api/circuit/me')]);
  if (!pub.ok) return offline;
  const label = { champion: 'Campeón', final: 'Finalista', semi: 'Semifinal', quarter: 'Cuartos' };
  const champs = pub.json.champions.map((c, i) => `<li class="rk-row">${medal(i + 1)}<span class="rk-name"><b>${esc(c.name)}</b><small>${new Date(c.at).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</small></span><em>👑</em></li>`).join('');
  const results = mine.ok
    ? mine.json.results.map((r) => `<li class="rk-row"><span class="rk-name"><b>${label[r.placement]}</b><small>${new Date(r.at).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</small></span><em>🪙 ${r.coins}</em></li>`).join('')
    : '';
  return `<div class="rank-layout"><section class="lb-card"><div class="card-head"><p class="eyebrow">Últimos campeones</p><span class="pill">Royale Circuit</span></div>
      ${champs ? `<ol class="rk-list">${champs}</ol>` : '<p class="muted">Todavía no hay campeones. El próximo puedes ser tú.</p>'}</section>
    <aside class="rank-side"><section class="lb-card"><p class="eyebrow">Tus torneos</p>
      ${results ? `<ol class="rk-list">${results}</ol>` : '<p class="muted">No has jugado ningún Circuit todavía.</p>'}
      <button class="btn primary" data-go="circuit">Ir al Royale Circuit</button></section></aside></div>`;
}

const RENDERERS = { elo: renderElo, daily: renderDaily, circuit: renderCircuit };

async function paint() {
  $$('#rankTabs button').forEach((b) => b.classList.toggle('on', b.dataset.rtab === tab));
  const body = $('#rankingBody');
  body.innerHTML = '<section class="lb-card"><p class="muted">Cargando…</p></section>';
  const mine = tab;
  const html = await RENDERERS[tab]();
  if (app.screen === 'ranking' && tab === mine) body.innerHTML = html;
}

export async function enterRanking() {
  showScreen('ranking');
  await paint();
  if (!net.user && (await ensureOnline())) paint();
}

export function initRanking() {
  $('#rankTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rtab]');
    if (!b) return;
    tab = b.dataset.rtab;
    paint();
  });
  $('#rankingBody').addEventListener('click', (e) => {
    if (e.target.closest('[data-rk="retry"]')) paint();
  });
}
