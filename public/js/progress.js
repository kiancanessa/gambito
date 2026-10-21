// Progresión (nivel de cuenta, misiones, temporada, logros e historial). Todo lo que se ve aquí lo calcula y lo concede el
// servidor: el cliente pide `/api/progress`, reclama con `/api/progress/claim` y se entera de los avances por WebSocket
// (`progress`). No hay rachas: nada de lo acumulado caduca por faltar un día.
import { ACHIEVEMENTS, MISSIONS_DAILY, MISSIONS_WEEKLY } from './progression-data.js';
import { decorClass, identityHtml, titleOf } from './cosmetics-art.js';
import { feedback } from './feedback.js';
import { flags } from './flags.js';
import { sfx } from './fx.js';
import { api, onReady, socket } from './net.js';
import { save, state } from './store.js';
import { $, app, esc, showScreen, toast } from './ui.js';
import { syncWallet } from './wallet.js';

const TABS = [['overview', 'Resumen'], ['missions', 'Misiones'], ['season', 'Temporada'], ['achievements', 'Logros'], ['history', 'Historial']];
const STATE_TEXT = { pending: 'Pendiente', inprogress: 'En progreso', completed: 'Completada', claimed: 'Reclamada' };
const KIND_ICON = { game: '♟', puzzle: '🧩', review: '🎬', circuit: '🏆', circuit_join: '🏆', mission: '🎯', achievement: '🏅', season_reward: '🎁' };
const RULE_LINES = (r) => [
  [`Participar y terminar una partida online`, `+${r.base + r.complete} XP`],
  [`Ganar / tablas`, `+${r.win} / +${r.draw} XP`],
  [`Partida clasificatoria`, `+${r.rated} XP`],
  [`Jaque mate · jaques (hasta ${r.maxChecks}) · coronar`, `+${r.mate} · +${r.check} c/u · +${r.promotion} XP`],
  [`Ganar a un rival con 100+ de rating más`, `+${r.underdog} XP`],
  [`Desafío diario resuelto`, `+${r.puzzle} XP`],
  [`Revisar una partida propia en la repetición`, `+${r.review} XP (hasta ${r.reviewDailyCap} al día)`],
  [`Abandonar una partida`, `solo +${r.abandonBase} XP`],
];

const ps = { data: null, tab: 'overview', offline: false, busy: false, board: null, offset: 0, timer: null, refresh: null };
const subs = new Set();
export const onProgress = (fn) => subs.add(fn);
const changed = () => subs.forEach((fn) => fn());
const serverNow = () => Date.now() + ps.offset;

export const progressData = () => ps.data;

// Lo que espera el jugador: misiones completadas sin reclamar, recompensas del pase abiertas y de temporadas anteriores.
export function claimableCount() {
  const d = ps.data;
  if (!d) return 0;
  const m = [...d.missions.daily.items, ...d.missions.weekly.items].filter((x) => x.state === 'completed').length + d.missions.carryover.length;
  return m + (d.season?.claimable ?? 0) + d.pastSeasons.reduce((n, s) => n + s.claimable, 0);
}
export const seasonClaimableCount = () => (ps.data?.season?.claimable ?? 0) + (ps.data?.pastSeasons ?? []).reduce((n, s) => n + s.claimable, 0);
export const missionsClaimableCount = () => claimableCount() - seasonClaimableCount();

// Resumen para el lobby.
export function dailyBrief() {
  const d = ps.data;
  return d ? d.missions.daily.items : null;
}
export function seasonBrief() {
  const s = ps.data?.season;
  if (!s) return null;
  const maxed = s.level >= s.levels;
  const next = maxed ? null : s.track[s.level];
  return { name: s.name, level: s.level, levels: s.levels, per: s.xpPerLevel, into: s.into, maxed, nextReward: next && (next.coins ? `🪙 ${next.coins}` : next.label), claimable: s.claimable, theme: s.theme };
}

// ---------- Datos ----------
export async function loadProgress({ quiet = false } = {}) {
  const res = await api('/api/progress');
  if (!res.ok) {
    if (!quiet || !ps.data) ps.offline = true;
    if (app.screen === 'progress') render();
    return null;
  }
  ps.offline = false;
  ps.data = res.json;
  ps.offset = res.json.now - Date.now();
  changed();
  if (app.screen === 'progress') render();
  return ps.data;
}

async function loadBoard() {
  const id = ps.data?.season?.id ?? ps.data?.pastSeasons?.at(-1)?.id;
  if (!id) return;
  const res = await api(`/api/season/leaderboard?season=${id}`);
  if (res.ok) {
    ps.board = res.json;
    if (app.screen === 'progress' && ps.tab === 'season') render();
  }
}

async function claim(body) {
  if (ps.busy) return;
  ps.busy = true;
  render();
  try {
    const res = await api('/api/progress/claim', { method: 'POST', body });
    if (res.ok) {
      sfx.coin();
      const r = res.json.reward;
      toast(`🎁 ${[r.coins ? `+${r.coins} 🪙` : '', r.xp ? `+${r.xp} XP` : '', r.item ? 'objeto nuevo' : ''].filter(Boolean).join(' · ') || 'Recompensa reclamada'}`, 3500);
      ps.data = res.json.summary;
      ps.offset = ps.data.now - Date.now();
      changed();
      syncWallet();
    } else {
      toast(res.json?.error ?? 'No se pudo reclamar', 3500);
      await loadProgress({ quiet: true });
    }
  } finally {
    ps.busy = false;
    render();
  }
}

/** Revisar una partida propia hasta el final: el servidor comprueba que es tuya y la cuenta una sola vez. */
export async function reportReview(gameId, plies) {
  if (!flags.wallet) return;
  const res = await api('/api/progress/review', { method: 'POST', body: { gameId, ply: plies } });
  if (res.ok && res.json.ok && res.json.xp) toast(`🎬 Partida revisada: +${res.json.xp} XP`, 2500);
}

// ---------- Interfaz ----------
const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
};
const left = (until) => `<b class="cd" data-until="${until}">${clock(until - serverNow())}</b>`;
const dateOf = (ms) => new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short' });
const rewardLine = (m) => `🪙 ${m.coins} · ${m.xp} XP`;

// El marco, el título y la decoración que llevas puestos salen del inventario del servidor (state.equipped).
export function applyFlair() {
  document.documentElement.dataset.cosmetics = '1';
}

function header(d) {
  const a = d.account;
  const pct = Math.min(100, (a.xp / a.next) * 100);
  const t = titleOf();
  return `<section class="lb-card pg-head ${decorClass()}">
    <div class="lvl-badge">${identityHtml(state.equipped, { size: 76, label: `Nivel ${a.level}` })}<small>NIVEL ${a.level}</small></div>
    <div class="pg-xp"><p class="eyebrow">Nivel de cuenta${t ? ` · ${esc(t)}` : ''}</p>
      <div class="xpline" role="progressbar" aria-label="Experiencia" aria-valuenow="${a.xp}" aria-valuemin="0" aria-valuemax="${a.next}"><i style="width:${pct}%"></i></div>
      <small>${a.xp} / ${a.next} XP para el nivel ${a.level + 1} · el nivel es independiente de tu rating</small></div>
    <ul class="lb-chips"><li><b>${a.coins}</b><small>oros</small></li><li><b>${claimableCount()}</b><small>por reclamar</small></li></ul>
  </section>`;
}

function missionRow(m, extra = {}) {
  const pct = Math.min(100, (m.progress / m.target) * 100);
  const can = m.state === 'completed' && !ps.busy;
  const data = `data-claim="mission" data-slot="${extra.kind}" data-id="${esc(m.id)}" data-period="${esc(extra.period)}"`;
  return `<li class="mission st-${m.state}">
    <div class="m-main"><b>${esc(m.text)}</b><div class="m-bar" role="progressbar" aria-valuenow="${m.progress}" aria-valuemin="0" aria-valuemax="${m.target}"><i style="width:${pct}%"></i></div>
      <small>${m.progress} / ${m.target} · ${rewardLine(m)}</small></div>
    <span class="m-state st-${m.state}">${STATE_TEXT[m.state]}</span>
    ${extra.kind ? `<button class="btn ${can ? 'primary' : ''}" ${data} ${can ? '' : 'disabled'} aria-label="Reclamar: ${esc(m.text)}">${m.state === 'claimed' ? '✓' : 'Reclamar'}</button>` : ''}
  </li>`;
}

function missionBlock(kind, title, block, hint) {
  return `<section class="lb-card"><div class="card-head"><p class="eyebrow">${title}</p><small class="muted">${hint} ${left(block.endsAt)}</small></div>
    <ul class="missions">${block.items.map((m) => missionRow(m, { kind, period: block.period })).join('')}</ul></section>`;
}

function renderMissions(d) {
  const carry = d.missions.carryover.length
    ? `<section class="lb-card pg-carry"><div class="card-head"><p class="eyebrow">Completadas del periodo anterior</p><span class="pill todo">${d.missions.carryover.length}</span></div>
        <p class="muted">No se pierden por no haber entrado a tiempo: puedes reclamarlas ahora.</p>
        <ul class="missions">${d.missions.carryover.map((m) => missionRow(m, { kind: m.kind, period: m.period })).join('')}</ul></section>`
    : '';
  return `${carry}${missionBlock('daily', 'Misiones diarias', d.missions.daily, 'se renuevan en')}${missionBlock('weekly', 'Misiones semanales', d.missions.weekly, 'se renuevan en')}
    <p class="muted fine">El servidor cuenta tus partidas online, el desafío diario, los torneos y las repeticiones revisadas. Las partidas contra la IA no cuentan porque no se pueden verificar. No hay rachas: faltar un día no te quita nada.</p>`;
}

function trackCard(t, season) {
  const icon = t.item ? { board: '♟', set: '♞', fx: '✨' }[t.item.split(':')[0]] : '🪙';
  const big = !!(t.item || t.coins >= 100);
  const open = t.state === 'open' && !ps.busy;
  const text = t.coins ? `${t.coins} oros` : t.label;
  const stateText = { claimed: '✓ Reclamado', open: 'Reclamar', locked: '🔒', expired: 'Caducado' }[t.state];
  return `<button class="pass-card ${t.state === 'claimed' ? 'done' : t.state === 'open' ? 'open' : 'locked'} ${big ? 'big' : ''}" data-claim="season" data-season="${season.id}" data-level="${t.level}" ${open ? '' : 'disabled'}>
    <small>Nivel ${t.level}</small><span class="ico">${icon}</span><b>${esc(text)}</b><em>${stateText}</em></button>`;
}

function renderSeason(d) {
  const s = d.season;
  const parts = [];
  if (s) {
    const maxed = s.level >= s.levels;
    parts.push(`<section class="lb-card pg-season" style="--sa:${s.theme.accent};--sb:${s.theme.accent2}">
      <div class="pg-season-glyph" aria-hidden="true">${s.theme.glyph}</div>
      <div class="pg-season-main"><p class="eyebrow">${esc(s.name)}</p><p class="muted">${esc(s.theme.tagline)}</p>
        <p class="big-num"><b>${s.level}</b> / ${s.levels} <small>nivel de temporada</small></p>
        <div class="xpline" role="progressbar" aria-valuenow="${s.into}" aria-valuemin="0" aria-valuemax="${s.xpPerLevel}"><i style="width:${maxed ? 100 : (s.into / s.xpPerLevel) * 100}%"></i></div>
        <small>${maxed ? '¡Pase completado!' : `${s.into} / ${s.xpPerLevel} XP para el nivel ${s.level + 1}`} · termina en ${left(Date.parse(`${s.endsAt}T23:59:59Z`))}</small></div>
      <button class="btn primary" data-claim="season-all" data-season="${s.id}" ${s.claimable && !ps.busy ? '' : 'disabled'}>Reclamar todo (${s.claimable})</button></section>
      <p class="muted track-label">Pista gratuita · monedas y cosméticos, nunca ventajas de juego</p>
      <div class="pass-track">${s.track.map((t) => trackCard(t, s)).join('')}</div>`);
  } else {
    const up = d.upcoming;
    parts.push(`<section class="lb-card"><p class="eyebrow">Entre temporadas</p><h3>${up ? esc(up.name) : 'Sin temporada activa'}</h3><p class="muted">${up ? `Empieza el ${dateOf(Date.parse(`${up.startsAt}T00:00:00Z`))}. Tu XP de cuenta sigue contando.` : 'La próxima se anunciará pronto. Tu XP de cuenta sigue contando.'}</p></section>`);
  }
  // Clasificación competitiva de la temporada
  const b = ps.board;
  const mine = s?.ranking ?? b?.me;
  const rows = b?.top
    .slice(0, 10)
    .map((r) => `<li class="rk-row ${r.id === ps.data?.userId ? 'me' : ''}"><i>${r.rank}</i><b>${esc(r.name)}</b><em>${r.rating}</em><small>${r.games} part.</small></li>`)
    .join('');
  parts.push(`<section class="lb-card"><div class="card-head"><p class="eyebrow">Clasificación de la temporada</p><small class="muted">solo partidas clasificatorias · mínimo ${b?.minGames ?? 3}</small></div>
    ${mine && mine.rating ? `<p class="pg-myrank">Tu rating de temporada: <b>${mine.rating}</b> · ${mine.rank ? `puesto <b>#${mine.rank}</b>` : `te faltan ${Math.max(0, (b?.minGames ?? 3) - mine.games)} partidas clasificatorias para entrar`}</p>` : '<p class="muted">Juega partidas clasificatorias para entrar en la clasificación de esta temporada. Cada temporada empieza con un rating propio, a medio camino de 1000.</p>'}
    ${rows ? `<ol class="pg-board">${rows}</ol>` : '<p class="muted">Aún no hay nadie clasificado en esta temporada.</p>'}</section>`);
  // Historial de temporadas anteriores
  if (d.pastSeasons.length) {
    parts.push(`<section class="lb-card"><p class="eyebrow">Temporadas anteriores</p><ul class="pg-past">${d.pastSeasons
      .map(
        (p) => `<li style="--sa:${p.theme.accent}"><span class="pg-past-glyph">${p.theme.glyph}</span><span><b>${esc(p.name)}</b><small>Pase: nivel ${p.level}/${p.levels}${p.ranking?.rating ? ` · rating ${p.ranking.rating}${p.ranking.rank ? ` · puesto #${p.ranking.rank}` : ''}` : ''}</small></span>${p.claimable ? `<button class="btn primary" data-claim="past-all" data-season="${p.id}" ${ps.busy ? 'disabled' : ''}>Reclamar (${p.claimable})</button>` : ''}</li>`,
      )
      .join('')}</ul><p class="muted fine">Las recompensas de una temporada se pueden reclamar hasta 14 días después de que termine.</p></section>`);
  }
  return parts.join('');
}

function renderAchievements(d) {
  const done = d.achievements.filter((a) => a.unlockedAt).length;
  return `<section class="lb-card"><div class="card-head"><p class="eyebrow">Logros</p><span class="pill ${done === d.achievements.length ? 'ok' : 'todo'}">${done}/${d.achievements.length}</span></div>
    <ul class="pg-ach">${d.achievements
      .map((a) => {
        const pct = Math.min(100, (a.progress / a.target) * 100);
        return `<li class="${a.unlockedAt ? 'done' : ''}"><i aria-hidden="true">${a.unlockedAt ? '✔' : '🔒'}</i><span><b>${esc(a.name)}</b><small>${esc(a.text)}</small>
          ${a.unlockedAt ? `<small class="ok">Conseguido el ${dateOf(a.unlockedAt)} · 🪙 ${a.coins}${a.xp ? ` · ${a.xp} XP` : ''}</small>` : `<span class="m-bar"><i style="width:${pct}%"></i></span><small>${a.progress} / ${a.target} · recompensa 🪙 ${a.coins}${a.xp ? ` · ${a.xp} XP` : ''}</small>`}</span></li>`;
      })
      .join('')}</ul><p class="muted fine">Los logros se calculan con tus partidas y resultados reales guardados en el servidor y se pagan una sola vez.</p></section>`;
}

function labelOf(h) {
  switch (h.kind) {
    case 'game': return `Partida contra ${h.label ?? 'un rival'}${h.result ? ` · ${{ win: 'victoria', loss: 'derrota', draw: 'tablas' }[h.result]}` : ''}`;
    case 'puzzle': return 'Desafío diario resuelto';
    case 'review': return 'Partida revisada en la repetición';
    case 'circuit': return 'Royale Circuit terminado';
    case 'circuit_join': return 'Participación en un Royale Circuit';
    case 'mission': return `Misión reclamada: ${[...MISSIONS_DAILY, ...MISSIONS_WEEKLY].find((m) => m.id === h.label)?.text ?? ''}`;
    case 'achievement': return `Logro: ${ACHIEVEMENTS.find((a) => a.id === h.label)?.name ?? ''}`;
    case 'season_reward': return 'Recompensa de temporada reclamada';
    default: return h.kind;
  }
}

function renderHistory(d) {
  const rows = d.history
    .map((h) => `<li><span class="ico" aria-hidden="true">${KIND_ICON[h.kind] ?? '•'}</span><span><b>${esc(labelOf(h))}</b><small>${new Date(h.at).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></span><em>${h.xp ? `+${h.xp} XP` : '—'}</em></li>`)
    .join('');
  return `<section class="lb-card"><p class="eyebrow">Historial de progresión</p>${rows ? `<ul class="pg-hist">${rows}</ul>` : '<p class="muted">Todavía no hay movimientos: juega una partida online, resuelve el desafío diario o participa en un torneo.</p>'}</section>`;
}

function renderOverview(d) {
  const daily = d.missions.daily.items;
  const s = d.season;
  const ready = claimableCount();
  const nextUnlock = d.unlocks.find((u) => !u.unlocked);
  return `<div class="pg-grid">
    <section class="lb-card"><div class="card-head"><p class="eyebrow">Misiones de hoy</p>${ready ? `<span class="pill todo">${ready} por reclamar</span>` : ''}</div>
      <ul class="missions compact">${daily.map((m) => missionRow(m)).join('')}</ul><button class="btn" data-ptab="missions">Ver todas las misiones</button></section>
    ${s ? `<section class="lb-card pg-season mini" style="--sa:${s.theme.accent};--sb:${s.theme.accent2}"><div class="pg-season-glyph" aria-hidden="true">${s.theme.glyph}</div><div class="pg-season-main"><p class="eyebrow">${esc(s.name)}</p>
      <p class="big-num"><b>${s.level}</b> / ${s.levels}</p><div class="xpline"><i style="width:${s.level >= s.levels ? 100 : (s.into / s.xpPerLevel) * 100}%"></i></div>
      <small>${s.claimable ? `${s.claimable} recompensas por reclamar` : `termina en ${left(Date.parse(`${s.endsAt}T23:59:59Z`))}`}</small></div><button class="btn" data-ptab="season">Ver temporada</button></section>` : ''}
    <section class="lb-card"><div class="card-head"><p class="eyebrow">Recompensas visuales</p>${nextUnlock ? `<small class="muted">siguiente: ${esc(nextUnlock.name)} (nivel ${nextUnlock.level})</small>` : ''}</div>
      <p class="muted">Avatares, marcos, títulos, efectos y más. Se desbloquean solos al subir de nivel o conseguir logros; son solo estéticos.</p>
      <p class="pg-label">${d.unlocks.filter((u) => u.unlocked).length} de ${d.unlocks.length} desbloqueos por nivel conseguidos</p>
      <button class="btn primary" data-go="shop">Abrir la personalización</button></section>
    <section class="lb-card"><p class="eyebrow">Cómo se gana XP</p><ul class="pg-rules">${RULE_LINES(d.rules).map(([a, b]) => `<li><span>${a}</span><b>${b}</b></li>`).join('')}</ul>
      <p class="muted fine">La XP premia participar y terminar; ganar es solo un extra. Hay un máximo por partida, por pareja de rivales y por día para que no se pueda granjear.</p></section>
  </div>`;
}

function render() {
  const body = $('#progressBody');
  if (!body || app.screen !== 'progress') return;
  if (ps.offline && !ps.data) {
    body.innerHTML = '<section class="lb-card"><p class="eyebrow">Sin conexión</p><h3>La progresión necesita el servidor</h3><p class="muted">El nivel, las misiones y la temporada se calculan y se guardan en el servidor para que nadie pueda falsearlos. Tu progreso a salvo sigue allí.</p><button class="btn primary" data-pg="retry">Reintentar</button></section>';
    return;
  }
  const d = ps.data;
  if (!d) {
    body.innerHTML = '<section class="lb-card"><p class="muted">Cargando tu progresión…</p></section>';
    return;
  }
  const tabs = `<div class="seg subnav pg-tabs" role="tablist" aria-label="Progresión">${TABS.map(([id, label]) => `<button role="tab" aria-selected="${ps.tab === id}" data-ptab="${id}" class="${ps.tab === id ? 'on' : ''}">${label}${id === 'missions' && missionsClaimableCount() ? ` <i class="dot">${missionsClaimableCount()}</i>` : ''}${id === 'season' && seasonClaimableCount() ? ` <i class="dot">${seasonClaimableCount()}</i>` : ''}</button>`).join('')}</div>`;
  const view = { overview: renderOverview, missions: renderMissions, season: renderSeason, achievements: renderAchievements, history: renderHistory }[ps.tab](d);
  const scroll = window.scrollY;
  body.innerHTML = `${header(d)}${tabs}<div class="pg-view" id="pgView">${view}</div>`;
  window.scrollTo(0, scroll);
}

function tick() {
  if (app.screen !== 'progress') {
    clearInterval(ps.timer);
    ps.timer = null;
    return;
  }
  for (const el of document.querySelectorAll('#progressBody .cd')) el.textContent = clock(Number(el.dataset.until) - serverNow());
}

export async function enterProgress(tab = null) {
  if (tab && TABS.some(([id]) => id === tab)) ps.tab = tab;
  showScreen('progress');
  render();
  await loadProgress();
  if (ps.tab === 'season') loadBoard();
  clearInterval(ps.timer);
  ps.timer = setInterval(tick, 30_000);
}

function setTab(id) {
  ps.tab = id;
  render();
  if (id === 'season') loadBoard();
  window.scrollTo(0, 0);
}

export function initProgress() {
  onReady(() => loadProgress({ quiet: true }).then(applyFlair));
  // El servidor avisa de cada avance (partida, desafío, torneo, logro, nivel): se muestra y se refresca la página.
  socket.on('cosmetics', (m) => {
    toast(`🎁 Nuevo cosmético: ${m.unlocked.slice(0, 3).map((n) => n.name).join(', ')}${m.unlocked.length > 3 ? ` y ${m.unlocked.length - 3} más` : ''}`, 4500);
    document.dispatchEvent(new CustomEvent('checkpoint:cosmetics'));
  });
  socket.on('progress', (m) => {
    if (m.xp) toast(`+${m.xp} XP`, 1800);
    if (m.leveledUp) {
      const unlocked = (m.unlocked ?? []).map((u) => u.name);
      feedback('advance', { title: `¡Nivel ${m.level}!`, text: unlocked.length ? `Desbloqueas: ${unlocked.join(', ')}` : 'Sigue así' });
    }
    if (m.achievement) feedback('mission', { title: 'Logro desbloqueado', text: ACHIEVEMENTS.find((a) => a.id === m.achievement)?.name ?? '' });
    clearTimeout(ps.refresh);
    ps.refresh = setTimeout(() => {
      loadProgress({ quiet: true }).then(applyFlair);
      syncWallet();
    }, 500);
  });
  $('#screen-progress').addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-ptab]');
    if (tab) return setTab(tab.dataset.ptab);
    if (e.target.closest('[data-pg="retry"]')) return loadProgress();
    const c = e.target.closest('[data-claim]');
    if (!c || c.disabled) return undefined;
    const kind = c.dataset.claim;
    if (kind === 'mission') return claim({ kind: 'mission', slot: c.dataset.slot, id: c.dataset.id, period: c.dataset.period });
    if (kind === 'season') return claim({ kind: 'season', season: Number(c.dataset.season), level: Number(c.dataset.level) });
    // «Reclamar todo»: una petición por nivel abierto; el servidor decide cada una.
    const season = Number(c.dataset.season);
    const levels = kind === 'season-all' ? ps.data.season.track.filter((t) => t.state === 'open').map((t) => t.level) : (ps.data.pastSeasons.find((p) => p.id === season)?.openLevels ?? []);
    for (const level of levels) await claim({ kind: 'season', season, level });
    return undefined;
  });
}
