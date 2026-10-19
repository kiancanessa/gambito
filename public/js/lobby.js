// Lobby competitivo: una sola pantalla con tu liga, el selector de partida (clasificatoria, amigos, IA, campaña),
// desafío diario, misiones, temporada, ranking y partidas en vivo. Reutiliza las acciones de online.js.
import { CAMPAIGN, GLYPH, LEAGUES, QUICK_LEVELS, TIME_CONTROLS, leagueOf } from './data.js';
import { missionsSummary } from './missions.js';
import { api, ensureOnline, net, onNet, refreshUser } from './net.js';
import { flags } from './flags.js';
import { cancelQueue, createRoom, getTc, joinRoom, onQueueChange, queueInfo, setTc, startQueue } from './online.js';
import { historyHtml, openReplay, tcName } from './replay.js';
import { seasonSummary } from './season.js';
import { state } from './store.js';
import { $, $$, app, avatar, esc, fmtCountdown, fmtDuration, showScreen, toast, VS } from './ui.js';

const MODES = [
  { id: 'ranked', icon: '⚔️', label: 'Clasificatoria' },
  { id: 'friend', icon: '🔗', label: 'Con amigo' },
  { id: 'ai', icon: '🤖', label: 'Contra la IA' },
  { id: 'campaign', icon: '🗺️', label: 'Campaña' },
];
const AI_GLYPHS = ['p', 'p', 'n', 'b', 'r', 'q'];
const AI_COLORS = ['#8bc34a', '#ffb74d', '#4dd0e1', '#ef5350', '#ba68c8', '#ffd54f'];
const REFRESH_MS = 12_000;

const lb = {
  mode: localStorage.getItem('gambito.lobby.mode') || 'ranked',
  color: 'r',
  aiLevel: 3,
  data: { stats: null, top: [], me: null, live: [], daily: null, history: [] },
  offline: false,
  timer: null,
  built: false,
};
if (!MODES.some((m) => m.id === lb.mode)) lb.mode = 'ranked';

const glyph = (g, color) => `<span class="lg" style="color:${color}">${GLYPH[g]}${VS}</span>`;
const online = () => !!net.user && !lb.offline;

// ---------- Estructura ----------
function build() {
  if (lb.built) return;
  lb.built = true;
  $('#lobbyBody').innerHTML = `
    <section class="lb-card lb-player" id="lbPlayer"></section>
    <section class="lb-card lb-play" id="lbPlay"></section>
    <div class="lb-side">
      <section class="lb-card" id="lbDaily"></section>
      <section class="lb-card" id="lbMissions"></section>
      <section class="lb-card" id="lbSeason"></section>
      <section class="lb-card" id="lbRank"></section>
    </div>
    <section class="lb-card lb-live" id="lbLive"></section>
    ${flags.replays ? '<section class="lb-card lb-history" id="lbHistory"></section>' : ''}
    <section class="lb-card lb-circuit" id="lbCircuit"></section>`;
}

// ---------- Tarjetas ----------
function renderPlayer() {
  const u = net.user;
  const rating = u?.rating ?? 1000;
  const lg = leagueOf(rating);
  const i = LEAGUES.indexOf(lg);
  const next = LEAGUES[i + 1];
  const pct = next ? Math.max(4, Math.min(100, ((rating - lg.min) / (next.min - lg.min)) * 100)) : 100;
  $('#lbPlayer').innerHTML = `
    <div class="lb-emblem" style="--c:${lg.color}"><span>${GLYPH[lg.glyph]}${VS}</span></div>
    <div class="lb-id">
      <p class="eyebrow">${u ? `Liga ${lg.name}` : 'Modo local'}</p>
      <h2>${esc(u?.name ?? 'Jugador')}</h2>
      ${u
        ? `<div class="lg-bar" title="${rating} puntos"><i style="width:${pct}%;background:${lg.color}"></i></div>
           <small>${rating} pts · ${next ? `${next.min - rating} para la liga ${next.name}` : 'Liga máxima'}</small>`
        : '<small class="warn">Sin conexión con el servidor: puedes jugar contra la IA y la campaña.</small>'}
    </div>
    <ul class="lb-chips">
      <li><b>Nv ${state.level}</b><small>jugador</small></li>
      <li><b>🔥 ${state.daily.streak}</b><small>racha</small></li>
      <li><b>🪙 ${state.coins}</b><small>oros</small></li>
      ${u ? `<li><b>${u.wins}V ${u.losses}D</b><small>${u.draws} tablas</small></li>` : ''}
    </ul>
    <div class="lb-actions"><button class="btn" data-open="profile" ${u ? '' : 'disabled'}>Perfil</button><button class="btn" data-go="shop">Tienda</button></div>`;
}

function tcChips(withNone) {
  const cur = getTc();
  return TIME_CONTROLS.filter((t) => withNone || t.id !== 'none')
    .map((t) => `<button class="tc-chip ${t.id === cur ? 'on' : ''}" data-tc="${t.id}"><b>${t.id === 'none' ? '∞' : t.sub}</b><small>${t.id === 'none' ? 'sin reloj' : t.label}</small></button>`)
    .join('');
}

const colorSeg = () =>
  `<div class="seg" data-lbcolor>${[['w', '⚪ Blancas'], ['b', '⚫ Negras'], ['r', '🎲 Azar']].map(([c, l]) => `<button data-color="${c}" class="${lb.color === c ? 'on' : ''}">${l}</button>`).join('')}</div>`;

function renderPlayBody() {
  const q = queueInfo();
  const st = lb.data.stats;
  const presence = st ? `<span class="presence"><i class="dot"></i> ${st.online} en línea · ${st.queue} buscando</span>` : '';
  const needOnline = !online() ? '<p class="warn">Necesitas conexión con el servidor para este modo.</p>' : '';

  if (lb.mode === 'ranked') {
    if (q.active) {
      const s = Math.floor((Date.now() - q.since) / 1000);
      return `<div class="queue-box lb-queue"><div class="spinner"></div>
        <div><b>Buscando rival…</b><small>${tcName(getTc())} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · la búsqueda se amplía con el tiempo</small></div>
        <button class="btn danger" data-lb="cancel">Cancelar</button></div>`;
    }
    return `<p class="muted">Rival de tu nivel, reloj y puntos de liga.</p>
      <div class="tc-grid">${tcChips(false)}</div>${needOnline}
      <button class="lb-cta" data-lb="queue" ${online() ? '' : 'disabled'}><span>Buscar partida</span><small>${tcName(getTc())}</small></button>${presence}`;
  }
  if (lb.mode === 'friend') {
    return `<p class="muted">Crea un enlace y compártelo: la partida empieza en cuanto tu amigo entre. Sin puntos de liga.</p>
      <div class="tc-grid">${tcChips(true)}</div>${colorSeg()}${needOnline}
      <button class="lb-cta" data-lb="create" ${online() ? '' : 'disabled'}><span>Crear enlace</span><small>${tcName(getTc())}</small></button>
      <form class="join-form" id="lbJoin"><input id="lbJoinCode" placeholder="Código o enlace de una partida" maxlength="80" autocomplete="off" aria-label="Código de partida"><button class="btn" ${online() ? '' : 'disabled'}>Unirme</button></form>`;
  }
  if (lb.mode === 'ai') {
    const l = QUICK_LEVELS.find((x) => x.id === lb.aiLevel);
    return `<p class="muted">Practica sin conexión contra Stockfish. Más nivel, más oros.</p>
      <div class="level-grid lb-levels">${QUICK_LEVELS.map((x, i) => `<button class="level-card ${x.id === lb.aiLevel ? 'on' : ''}" data-ai="${x.id}">${avatar(AI_GLYPHS[i], AI_COLORS[i])}<b>${x.name}</b><small>🪙 ${Math.round(50 * x.mult)}</small></button>`).join('')}</div>
      ${colorSeg()}
      <button class="lb-cta" data-lb="ai"><span>Jugar</span><small>Nivel ${l.name}</small></button>`;
  }
  // campaña
  const cleared = state.campaign.cleared;
  const done = cleared >= CAMPAIGN.length;
  const n = CAMPAIGN[Math.min(cleared, CAMPAIGN.length - 1)];
  return `<div class="lb-next">${avatar(n.glyph, n.color)}
      <div><p class="eyebrow">${done ? 'Capítulo completado' : `Siguiente rival · ${cleared + 1} de ${CAMPAIGN.length}`}</p><h3>${n.name}</h3><small>${n.title} · 🪙 ${n.reward}</small></div></div>
    <div class="pips">${CAMPAIGN.map((_, i) => `<i class="${i < cleared ? 'on' : i === cleared ? 'now' : ''}"></i>`).join('')}</div>
    <button class="lb-cta" data-lb="campaign"><span>${done ? 'Rejugar' : cleared ? 'Continuar campaña' : 'Empezar campaña'}</span><small>Valle de Peones</small></button>
    <button class="btn lb-secondary" data-go="campaign">Ver el mapa</button>`;
}

function renderPlay() {
  $('#lbPlay').innerHTML = `
    <div class="lb-tabs" role="tablist">${MODES.map((m) => `<button role="tab" data-mode="${m.id}" aria-selected="${m.id === lb.mode}" class="${m.id === lb.mode ? 'on' : ''}"><span>${m.icon}</span>${m.label}</button>`).join('')}</div>
    <div class="lb-play-body" id="lbPlayBody">${renderPlayBody()}</div>`;
}

// Solo el cuerpo (la cola cambia cada segundo; no se rehacen las pestañas ni se pierde el foco).
function renderPlayBodyOnly() {
  const el = $('#lbPlayBody');
  if (el && app.screen === 'lobby') el.innerHTML = renderPlayBody();
}

function renderDaily() {
  const d = lb.data.daily;
  const streak = state.dailyPuzzle.streak;
  if (!online() || !d) {
    $('#lbDaily').innerHTML = `<p class="eyebrow">Desafío diario</p><p class="muted">${online() ? 'Cargando…' : 'Disponible con conexión.'}</p><button class="btn" data-go="daily">Abrir</button>`;
    return;
  }
  $('#lbDaily').innerHTML = `
    <div class="card-head"><p class="eyebrow">Desafío diario #${d.number}</p><span class="pill ${d.mine ? 'ok' : 'todo'}">${d.mine ? '✓ Resuelto' : 'Pendiente'}</span></div>
    <h3>Mate en ${d.mateIn}</h3>
    <p class="muted">${d.mine ? `${fmtDuration(d.mine.seconds)} · puesto #${d.mine.rank}` : `${d.solvedCount} jugadores ya lo resolvieron`} · ⏳ ${fmtCountdown(d.nextResetAt - Date.now())}${streak ? ` · 🔥 ${streak}` : ''}</p>
    <button class="btn ${d.mine ? '' : 'primary'}" data-go="daily">${d.mine ? 'Ver ranking' : 'Resolver ahora'}</button>`;
}

function renderMissions() {
  const { daily } = missionsSummary();
  const ready = daily.filter((m) => m.ready).length;
  $('#lbMissions').innerHTML = `
    <div class="card-head"><p class="eyebrow">Misiones de hoy</p>${ready ? `<span class="pill todo">${ready} para reclamar</span>` : ''}</div>
    <ul class="lb-missions">${daily.map((m) => `<li class="${m.claimed ? 'claimed' : m.ready ? 'ready' : ''}"><span>${esc(m.text)}</span><div class="m-bar"><i style="width:${Math.min(100, (m.progress / m.target) * 100)}%"></i></div><small>${m.claimed ? '✓' : `${m.progress}/${m.target}`}</small></li>`).join('')}</ul>
    <button class="btn ${ready ? 'primary' : ''}" data-go="missions">${ready ? 'Reclamar premios' : 'Ver misiones'}</button>`;
}

function renderSeason() {
  const s = seasonSummary();
  $('#lbSeason').innerHTML = `
    <div class="card-head"><p class="eyebrow">${esc(s.name)}</p>${s.claimable ? `<span class="pill todo">${s.claimable} premio${s.claimable > 1 ? 's' : ''}</span>` : ''}</div>
    <div class="season-line"><b>Nivel ${s.level}</b><small>/ ${s.levels}</small></div>
    <div class="xpline"><i style="width:${s.maxed ? 100 : (s.into / s.per) * 100}%"></i></div>
    <p class="muted">${s.maxed ? '¡Pase completado!' : `${s.into}/${s.per} XP · siguiente: ${esc(s.nextReward)}`}</p>
    <button class="btn ${s.claimable ? 'primary' : ''}" data-go="season">${s.claimable ? 'Reclamar' : 'Ver pase'}</button>`;
}

function renderRank() {
  const { top, me } = lb.data;
  const meId = net.user?.id;
  const rows = top.slice(0, 5).map((r) => {
    const lg = leagueOf(r.rating);
    return `<li class="${r.id === meId ? 'me' : ''}"><span class="rk">${r.rank}</span>${glyph(lg.glyph, lg.color)}<b>${esc(r.name)}</b><em>${r.rating}</em></li>`;
  }).join('');
  $('#lbRank').innerHTML = `<div class="card-head"><p class="eyebrow">Clasificación</p><button class="link-btn" data-go="online">Ver más</button></div>
    <ol class="lb">${rows || '<li class="empty">Aún no hay partidas clasificatorias. ¡Sé el primero!</li>'}</ol>
    ${me && net.user?.games > 0 ? `<p class="next-line muted">Tu posición: <b>#${me.rank}</b> · ${me.rating} pts</p>` : ''}`;
}

function renderLive() {
  const games = lb.data.live;
  const rows = games.map((g) => {
    const w = leagueOf(g.w.rating);
    const b = leagueOf(g.b.rating);
    return `<li><div class="vs">${glyph(w.glyph, w.color)}<b>${esc(g.w.name)}</b><em>${g.w.rating}</em><span class="x">vs</span>${glyph(b.glyph, b.color)}<b>${esc(g.b.name)}</b><em>${g.b.rating}</em></div>
      <small>${tcName(g.tc)} · ${Math.ceil(g.moves / 2)} jugadas${g.spectators ? ` · 👀 ${g.spectators}` : ''}</small>
      <button class="btn" data-spectate="${esc(g.code)}">Ver</button></li>`;
  }).join('');
  $('#lbLive').innerHTML = `<div class="card-head"><p class="eyebrow"><i class="dot live"></i> Partidas en vivo</p></div>
    ${rows ? `<ul class="live-list">${rows}</ul>` : `<p class="muted">${online() ? 'No hay partidas clasificatorias en curso ahora mismo. ¡Empieza una y deja que otros te vean!' : 'Conéctate para ver partidas en directo.'}</p>`}`;
}

function renderHistory() {
  if (!flags.replays) return;
  const rows = historyHtml(lb.data.history);
  $('#lbHistory').innerHTML = `<div class="card-head"><p class="eyebrow">🎬 Mis últimas partidas</p></div>
    ${rows ? `<ul class="live-list history-list">${rows}</ul>` : `<p class="muted">${online() ? 'Aquí aparecerán tus partidas online para que las revises o las compartas.' : 'Conéctate para ver tu historial.'}</p>`}`;
}

function renderCircuit() {
  $('#lbCircuit').innerHTML = `
    <div class="circuit-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div><p class="eyebrow">Royale Circuit</p><h3>Torneos eliminatorios en vivo</h3>
    <p class="muted">Entra, sobrevive ronda a ronda y gana cosméticos exclusivos. Estamos terminando de prepararlo.</p></div>
    <span class="pill soon">Próximamente</span>`;
}

function renderPresence() {
  const st = lb.data.stats;
  $('#lbPresence').innerHTML = online() && st ? `<i class="dot"></i> ${st.online} en línea · ${st.queue} buscando` : '<i class="dot off"></i> Sin conexión';
}

function renderAll() {
  build();
  renderPlayer();
  renderPlay();
  renderDaily();
  renderMissions();
  renderSeason();
  renderRank();
  renderLive();
  renderHistory();
  renderCircuit();
  renderPresence();
}

// ---------- Datos ----------
async function refresh() {
  if (!net.user) return;
  const [st, top, live, daily, history] = await Promise.all([
    api('/api/stats', { auth: false }),
    api('/api/leaderboard'),
    api('/api/live', { auth: false }),
    api('/api/daily'),
    flags.replays ? api('/api/me/games?limit=6') : { ok: false },
  ]);
  if (app.screen !== 'lobby') return;
  lb.offline = !(st.ok || top.ok);
  if (st.ok) lb.data.stats = st.json;
  if (top.ok) {
    lb.data.top = top.json.top;
    lb.data.me = top.json.me;
  }
  if (live.ok) lb.data.live = live.json.games;
  if (daily.ok) lb.data.daily = daily.json;
  if (history.ok) lb.data.history = history.json.games;
  await refreshUser();
  if (app.screen === 'lobby') renderAll();
}

export async function enterLobby() {
  showScreen('lobby');
  renderAll(); // al instante, con los datos locales
  await ensureOnline();
  if (app.screen !== 'lobby') return;
  renderAll();
  refresh();
  clearInterval(lb.timer);
  lb.timer = setInterval(() => (app.screen === 'lobby' ? refresh() : clearInterval(lb.timer)), REFRESH_MS);
}

// ---------- Eventos ----------
export function initLobby() {
  build();
  onQueueChange(() => renderPlayBodyOnly());
  onNet(() => {
    if (app.screen === 'lobby') {
      renderPlayer();
      renderPlayBodyOnly();
    }
  });

  const root = $('#screen-lobby');
  root.addEventListener('click', async (e) => {
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      lb.mode = mode.dataset.mode;
      localStorage.setItem('gambito.lobby.mode', lb.mode);
      return renderPlay();
    }
    const tc = e.target.closest('[data-tc]');
    if (tc) {
      setTc(tc.dataset.tc);
      return renderPlayBodyOnly();
    }
    const col = e.target.closest('[data-lbcolor] [data-color]');
    if (col) {
      lb.color = col.dataset.color;
      return renderPlayBodyOnly();
    }
    const ai = e.target.closest('[data-ai]');
    if (ai) {
      lb.aiLevel = Number(ai.dataset.ai);
      return renderPlayBodyOnly();
    }
    const rep = e.target.closest('[data-replay]');
    if (rep) return openReplay(rep.dataset.replay);
    const spec = e.target.closest('[data-spectate]');
    if (spec) return joinRoom(spec.dataset.spectate);
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (act === 'queue') return startQueue();
    if (act === 'cancel') return cancelQueue();
    if (act === 'create') return createRoom({ tc: getTc(), color: lb.color });
    if (act === 'ai') return app.startQuick(lb.aiLevel, lb.color);
    if (act === 'campaign') {
      const cleared = state.campaign.cleared;
      return app.startCampaign(cleared >= CAMPAIGN.length ? CAMPAIGN.length - 1 : cleared);
    }
    return undefined;
  });

  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'lbJoin') return;
    e.preventDefault();
    const value = $('#lbJoinCode').value;
    const m = value.match(/\/g\/([A-Za-z0-9]{4,12})/);
    const code = (m ? m[1] : value.replace(/[^A-Za-z0-9]/g, '')).toUpperCase();
    if (code.length < 4) return toast('Escribe el código o pega el enlace de la partida');
    return joinRoom(code);
  });
  void $$;
}
