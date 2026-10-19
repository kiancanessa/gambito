// Lobby competitivo: dónde jugar (PLAY NOW), tu rango, el torneo activo (Royale Circuit), eventos, misiones, amigos y ranking.
// Reutiliza las acciones de online.js, circuit.js y social.js; todo lo que se muestra viene de datos reales.
import { CAMPAIGN, GLYPH, LEAGUES, QUICK_LEVELS, SEASON, TIME_CONTROLS, leagueOf } from './data.js';
import { circuitMine, circuitPublic, refreshCircuitPublic } from './circuit.js';
import { flags } from './flags.js';
import { missionsSummary } from './missions.js';
import { api, ensureOnline, net, onNet, refreshUser } from './net.js';
import { cancelQueue, createRoom, getTc, joinRoom, onQueueChange, queueInfo, setTc, startQueue } from './online.js';
import { historyHtml, openReplay, tcName } from './replay.js';
import { seasonSummary } from './season.js';
import { challengeFriend, onSocial, refreshSocial, socialData } from './social.js';
import { state } from './store.js';
import { $, app, avatar, esc, fmtCountdown, fmtDuration, showScreen, toast, VS } from './ui.js';

const MODES = [
  { id: 'ranked', label: 'Clasificatoria', hint: 'Sube de liga' },
  { id: 'friend', label: 'Con amigo', hint: 'Por enlace' },
  { id: 'ai', label: 'Contra la IA', hint: 'Práctica' },
  { id: 'campaign', label: 'Campaña', hint: 'Historia' },
];
const AI_GLYPHS = ['p', 'p', 'n', 'b', 'r', 'q'];
const AI_COLORS = ['#8bc34a', '#ffb74d', '#4dd0e1', '#ef5350', '#ba68c8', '#ffd54f'];
const REFRESH_MS = 12_000;
const PRESENCE_LABEL = { online: 'En línea', queue: 'Buscando partida', playing: 'Jugando' };

const lb = {
  mode: localStorage.getItem('gambito.lobby.mode') || 'ranked',
  color: 'r',
  aiLevel: 3,
  data: { stats: null, top: [], me: null, live: [], daily: null, history: [] },
  circuitAt: 0, // cuándo se leyó el estado público del Circuit (para la cuenta atrás)
  offline: false,
  timer: null,
  tick: null,
  built: false,
};
if (!MODES.some((m) => m.id === lb.mode)) lb.mode = 'ranked';

const glyph = (g, color) => `<span class="lg" style="color:${color}">${GLYPH[g]}${VS}</span>`;
const online = () => !!net.user && !lb.offline;
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const emblem = (lg, cls = '') => `<span class="emblem ${cls}" style="--c:${lg.color}"><i>${GLYPH[lg.glyph]}${VS}</i></span>`;

// ---------- Estructura ----------
// En móvil los dos contenedores desaparecen (display: contents) y las tarjetas se ordenan con `order`;
// en escritorio son dos columnas: jugar a la izquierda, rango y torneo a la derecha.
function build() {
  if (lb.built) return;
  lb.built = true;
  $('#lobbyBody').innerHTML = `
    <div class="lb-main">
      <section class="lb-card lb-play" id="lbPlay"></section>
      <section class="lb-card lb-events" id="lbEvents"></section>
      <section class="lb-card lb-live" id="lbLive"></section>
      ${flags.replays ? '<section class="lb-card lb-history" id="lbHistory"></section>' : ''}
    </div>
    <div class="lb-side">
      <section class="lb-card lb-player" id="lbPlayer"></section>
      <section class="lb-card lb-circuit" id="lbCircuit"></section>
      <section class="lb-card lb-prog" id="lbMissions"></section>
      <section class="lb-card" id="lbSeason"></section>
      ${flags.social ? '<section class="lb-card" id="lbSocial"></section>' : ''}
      <section class="lb-card" id="lbRank"></section>
    </div>`;
}

// ---------- Rango del jugador ----------
function renderPlayer() {
  const u = net.user;
  const rating = u?.rating ?? 1000;
  const lg = leagueOf(rating);
  const i = LEAGUES.indexOf(lg);
  const next = LEAGUES[i + 1];
  const pct = next ? Math.max(4, Math.min(100, ((rating - lg.min) / (next.min - lg.min)) * 100)) : 100;
  const pos = lb.data.me && u?.games > 0 ? `<li><b>#${lb.data.me.rank}</b><small>puesto</small></li>` : '';
  $('#lbPlayer').innerHTML = `
    ${emblem(lg, 'big')}
    <div class="lb-id">
      <p class="eyebrow">${u ? `Liga ${lg.name}` : 'Modo local'}</p>
      <h2>${esc(u?.name ?? 'Jugador')}</h2>
      ${u
        ? `<div class="lg-bar" title="${rating} puntos"><i style="width:${pct}%;color:${next?.color ?? lg.color};background:currentColor"></i></div>
           <small>${rating} pts · ${next ? `${next.min - rating} para ${next.name}` : 'liga máxima'}</small>`
        : '<small class="warn">Sin conexión: puedes jugar la campaña y contra la IA.</small>'}
    </div>
    <ul class="lb-chips">
      <li><b>${state.level}</b><small>nivel</small></li>
      <li><b>${state.daily.streak}</b><small>racha</small></li>
      <li><b>${state.coins}</b><small>oros</small></li>
      ${u ? `<li><b>${u.wins}-${u.losses}</b><small>V-D</small></li>` : ''}
      ${pos}
    </ul>
    <div class="lb-actions"><button class="btn" data-go="profile">Perfil</button><button class="btn" data-go="shop">Personalizar</button></div>`;
}

// ---------- Jugar ----------
function tcChips(withNone) {
  const cur = getTc();
  return TIME_CONTROLS.filter((t) => withNone || t.id !== 'none')
    .map((t) => `<button class="tc-chip ${t.id === cur ? 'on' : ''}" data-tc="${t.id}"><b>${t.id === 'none' ? '∞' : t.sub}</b><small>${t.id === 'none' ? 'sin reloj' : t.label}</small></button>`)
    .join('');
}

const colorSeg = () =>
  `<div class="seg" data-lbcolor>${[['w', '⚪ Blancas'], ['b', '⚫ Negras'], ['r', '🎲 Azar']].map(([c, l]) => `<button data-color="${c}" class="${lb.color === c ? 'on' : ''}">${l}</button>`).join('')}</div>`;

// Botón principal: siempre PLAY NOW; lo que hace depende del modo elegido.
const playNow = (action, sub, enabled = true) =>
  `<button class="play-now lb-cta" data-lb="${action}" ${enabled ? '' : 'disabled'}><span class="pn-main">PLAY NOW</span><small>${sub}</small></button>`;

function renderPlayBody() {
  const q = queueInfo();
  const st = lb.data.stats;
  const presence = st ? `<p class="presence"><i class="dot"></i> ${st.online} en línea · ${st.queue} buscando partida</p>` : '';
  const needOnline = !online() ? '<p class="warn">Este modo necesita conexión con el servidor.</p>' : '';

  if (lb.mode === 'ranked') {
    if (q.active) {
      const s = Math.floor((Date.now() - q.since) / 1000);
      return `<div class="queue-box lb-queue"><div class="spinner"></div>
        <div><b>Buscando rival…</b><small>${tcName(getTc())} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · la búsqueda se amplía con el tiempo</small></div>
        <button class="btn danger" data-lb="cancel">Cancelar</button></div>`;
    }
    return `<p class="muted">Rival de tu nivel, con reloj y puntos de liga. Elige el ritmo:</p>
      <div class="tc-grid">${tcChips(false)}</div>${needOnline}
      ${playNow('queue', `Clasificatoria · ${tcName(getTc())}`, online())}${presence}`;
  }
  if (lb.mode === 'friend') {
    return `<p class="muted">Crea un enlace y compártelo: la partida empieza cuando tu amigo entre. No cambia tus puntos de liga.</p>
      <div class="tc-grid">${tcChips(true)}</div>${colorSeg()}${needOnline}
      ${playNow('create', `Crear partida · ${tcName(getTc())}`, online())}
      <form class="join-form" id="lbJoin"><input id="lbJoinCode" placeholder="Código o enlace de una partida" maxlength="80" autocomplete="off" aria-label="Código de partida"><button class="btn" ${online() ? '' : 'disabled'}>Unirme</button></form>`;
  }
  if (lb.mode === 'ai') {
    const l = QUICK_LEVELS.find((x) => x.id === lb.aiLevel);
    return `<p class="muted">Practica sin conexión contra Stockfish. Más nivel, más oros.</p>
      <div class="level-grid lb-levels">${QUICK_LEVELS.map((x, i) => `<button class="level-card ${x.id === lb.aiLevel ? 'on' : ''}" data-ai="${x.id}">${avatar(AI_GLYPHS[i], AI_COLORS[i])}<b>${x.name}</b><small>🪙 ${Math.round(50 * x.mult)}</small></button>`).join('')}</div>
      ${colorSeg()}
      ${playNow('ai', `Contra la IA · nivel ${l.name}`)}`;
  }
  const cleared = state.campaign.cleared;
  const done = cleared >= CAMPAIGN.length;
  const n = CAMPAIGN[Math.min(cleared, CAMPAIGN.length - 1)];
  return `<div class="lb-next">${avatar(n.glyph, n.color)}
      <div><p class="eyebrow">${done ? 'Capítulo completado' : `Siguiente rival · ${cleared + 1} de ${CAMPAIGN.length}`}</p><h3>${n.name}</h3><small>${n.title} · 🪙 ${n.reward}</small></div></div>
    <div class="pips">${CAMPAIGN.map((_, i) => `<i class="${i < cleared ? 'on' : i === cleared ? 'now' : ''}"></i>`).join('')}</div>
    ${playNow('campaign', `${done ? 'Rejugar' : cleared ? 'Continuar campaña' : 'Empezar campaña'} · Valle de Peones`)}
    <button class="btn lb-secondary" data-go="campaign">Ver el mapa</button>`;
}

function renderPlay() {
  $('#lbPlay').innerHTML = `
    <div class="card-head"><p class="eyebrow">Jugar</p><span class="lb-presence" id="lbPresence"></span></div>
    <div class="lb-tabs" role="tablist" aria-label="Modo de juego">${MODES.map((m) => `<button role="tab" data-mode="${m.id}" aria-selected="${m.id === lb.mode}" class="${m.id === lb.mode ? 'on' : ''}"><b>${m.label}</b><small>${m.hint}</small></button>`).join('')}</div>
    <div class="lb-play-body" id="lbPlayBody">${renderPlayBody()}</div>`;
  renderPresence();
}

// Solo el cuerpo (la cola cambia cada segundo; no se rehacen las pestañas ni se pierde el foco).
function renderPlayBodyOnly() {
  const el = $('#lbPlayBody');
  if (el && app.screen === 'lobby') el.innerHTML = renderPlayBody();
}

// ---------- Royale Circuit (torneo destacado) ----------
function circuitState() {
  const pub = circuitPublic();
  const mine = circuitMine();
  const left = pub?.open ? pub.open.fillInMs - (Date.now() - lb.circuitAt) : 0;
  if (mine?.status === 'registering') return { kind: 'joined', mine, left: mine.fillInMs - (Date.now() - lb.circuitAt) };
  if (mine?.status === 'running' && !mine.you?.out) return { kind: 'playing', mine };
  if (pub?.open) return { kind: 'open', open: pub.open, size: pub.size, left };
  if (pub?.running?.length) return { kind: 'running', running: pub.running };
  return { kind: 'idle' };
}

function renderCircuit() {
  if (!flags.circuit) {
    $('#lbCircuit').innerHTML = '<p class="eyebrow">Royale Circuit</p><h3>Torneos eliminatorios</h3><p class="muted">Muy pronto: entra, sobrevive ronda a ronda y gana cosméticos exclusivos.</p><span class="pill soon">Próximamente</span>';
    return;
  }
  const c = circuitState();
  let pill = '<span class="pill ok">Abierto</span>';
  let line = 'Sin inscripción abierta: sé el primero y el torneo arranca 1 minuto después, completando con bots.';
  let cta = 'Entrar al torneo';
  if (c.kind === 'open') {
    pill = `<span class="pill todo">${c.open.joined}/${c.size} inscritos</span>`;
    line = `Empieza al llegar a ${c.size} o en <b id="lbCount">${mmss(c.left)}</b>, con bots si faltan.`;
  } else if (c.kind === 'joined') {
    pill = `<span class="pill todo">Inscrito ${c.mine.entrants.length}/${c.mine.size}</span>`;
    line = `Ya estás dentro. Empieza en <b id="lbCount">${mmss(c.left)}</b> o al completarse.`;
    cta = 'Ver torneo';
  } else if (c.kind === 'playing') {
    pill = '<span class="pill live">¡Estás compitiendo!</span>';
    line = c.mine.you?.matchCode ? 'Tu partida está en juego.' : 'Esperando tu siguiente partida.';
    cta = 'Ir al torneo';
  } else if (c.kind === 'running') {
    pill = `<span class="pill live">${c.running.length} en curso</span>`;
    line = 'Hay torneos en marcha: míralos en directo o abre uno nuevo.';
  }
  $('#lbCircuit').innerHTML = `
    <div class="card-head"><p class="eyebrow">Royale Circuit</p>${pill}</div>
    <h3>Eliminatoria de 8 · Blitz 3+2</h3>
    <p class="muted">${line}</p>
    <ul class="prize-row"><li>Cuartos <b>🪙 30</b></li><li>Semi <b>🪙 60</b></li><li>Final <b>🪙 120</b></li><li class="top">Campeón <b>🪙 250 + 👑</b></li></ul>
    <button class="btn primary" data-lb="circuit">${cta}</button>`;
}

// ---------- Torneos y eventos: activos y próximos ----------
function renderEvents() {
  const d = lb.data.daily;
  const pub = circuitPublic();
  const season = seasonSummary();
  const daysLeft = Math.max(0, Math.ceil((new Date(`${SEASON.endsAt}T23:59:59`).getTime() - Date.now()) / 86_400_000));
  const rows = [];
  if (flags.circuit) {
    const c = circuitState();
    if (c.kind === 'open' || c.kind === 'joined') {
      const n = c.kind === 'open' ? `${c.open.joined}/${c.size}` : `${c.mine.entrants.length}/${c.mine.size}`;
      rows.push(['live', 'ACTIVO', 'Royale Circuit · inscripción abierta', `${n} jugadores · Blitz 3+2`, `<button class="btn primary" data-lb="circuit">${c.kind === 'open' ? 'Entrar' : 'Ver'}</button>`]);
    }
    for (const t of pub?.running ?? []) {
      const live = t.live[0];
      rows.push(['live', 'EN CURSO', `Royale Circuit · ${live?.label ?? 'en juego'}`, live ? `${esc(live.a)} vs ${esc(live.b)}` : 'Rondas simuladas entre bots', live ? `<button class="btn" data-spectate="${esc(live.code)}">Ver</button>` : '']);
    }
    if (!rows.length) rows.push(['next', 'PRÓXIMO', 'Royale Circuit', 'Se abre cuando alguien se inscribe y empieza 1 min después', '<button class="btn" data-lb="circuit">Abrir uno</button>']);
  }
  if (online() && d) {
    rows.push([d.mine ? 'done' : 'today', 'HOY', `Desafío diario #${d.number} · mate en ${d.mateIn}`, `${d.mine ? `Resuelto en ${fmtDuration(d.mine.seconds)} · puesto #${d.mine.rank}` : `${d.solvedCount} lo resolvieron`} · cierra en ${fmtCountdown(d.nextResetAt - Date.now())}`, `<button class="btn ${d.mine ? '' : 'primary'}" data-go="daily">${d.mine ? 'Ranking' : 'Resolver'}</button>`]);
  }
  rows.push(['next', 'PRÓXIMO', season.name, daysLeft ? `La temporada termina en ${daysLeft} día${daysLeft > 1 ? 's' : ''} · nivel ${season.level}/${season.levels}` : 'La temporada ha terminado', '<button class="btn" data-go="season">Ver pase</button>']);
  $('#lbEvents').innerHTML = `<div class="card-head"><p class="eyebrow">Torneos y eventos</p></div>
    <ul class="ev-list">${rows.map(([kind, tag, title, sub, action]) => `<li class="${kind}"><span class="ev-tag">${tag}</span><span class="ev-main"><b>${title}</b><small>${sub}</small></span>${action}</li>`).join('')}</ul>`;
}

// ---------- Misiones y progreso ----------
function renderMissions() {
  const { daily } = missionsSummary();
  const ready = daily.filter((m) => m.ready).length;
  $('#lbMissions').innerHTML = `
    <div class="card-head"><p class="eyebrow">Misiones de hoy</p>${ready ? `<span class="pill todo">${ready} para reclamar</span>` : ''}</div>
    <ul class="lb-missions">${daily.map((m) => `<li class="${m.claimed ? 'claimed' : m.ready ? 'ready' : ''}"><span>${esc(m.text)}</span><small>${m.claimed ? '✓' : `${m.progress}/${m.target}`}</small><div class="m-bar"><i style="width:${Math.min(100, (m.progress / m.target) * 100)}%"></i></div></li>`).join('')}</ul>
    <button class="btn ${ready ? 'primary' : ''}" data-go="missions">${ready ? 'Reclamar premios' : 'Ver misiones'}</button>`;
}

function renderSeason() {
  const s = seasonSummary();
  $('#lbSeason').innerHTML = `
    <div class="card-head"><p class="eyebrow">Pase de temporada</p>${s.claimable ? `<span class="pill todo">${s.claimable} premio${s.claimable > 1 ? 's' : ''}</span>` : ''}</div>
    <div class="season-line"><b>Nivel ${s.level}</b><small>/ ${s.levels}</small></div>
    <div class="xpline"><i style="width:${s.maxed ? 100 : (s.into / s.per) * 100}%"></i></div>
    <p class="muted">${s.maxed ? '¡Pase completado!' : `${s.into}/${s.per} XP · siguiente: ${esc(s.nextReward)}`}</p>
    <button class="btn ${s.claimable ? 'primary' : ''}" data-go="season">${s.claimable ? 'Reclamar' : 'Ver pase'}</button>`;
}

// ---------- Amigos ----------
function renderSocial() {
  if (!flags.social) return;
  const d = socialData();
  const pending = d ? d.incoming.length : 0;
  const active = d ? d.friends.filter((f) => f.presence !== 'offline').slice(0, 4) : [];
  const onlineN = d ? d.friends.filter((f) => f.presence !== 'offline').length : 0;
  const body = !d
    ? `<p class="muted">${online() ? 'Cargando…' : 'Conéctate para ver a tus amigos.'}</p>`
    : active.length
      ? `<ul class="fr-mini">${active.map((f) => `<li><i class="pdot ${f.presence === 'playing' ? 'play' : f.presence === 'queue' ? 'queue' : 'on'}"></i><span><b>${esc(f.name)}</b><small>${PRESENCE_LABEL[f.presence]}</small></span><button class="btn" data-challenge="${esc(f.id)}" data-name="${esc(f.name)}">Retar</button></li>`).join('')}</ul>`
      : `<p class="muted">${d.friends.length ? 'Ningún amigo conectado ahora.' : 'Añade amigos con su código para retarlos.'}</p>`;
  $('#lbSocial').innerHTML = `<div class="card-head"><p class="eyebrow">Amigos</p>${pending ? `<span class="pill todo">${pending} solicitud${pending > 1 ? 'es' : ''}</span>` : d ? `<span class="pill ${onlineN ? 'ok' : ''}">${onlineN} en línea</span>` : ''}</div>
    ${body}<button class="btn" data-lb="social">Abrir amigos</button>`;
}

// ---------- Clasificación, en vivo e historial ----------
function renderRank() {
  const { top, me } = lb.data;
  const meId = net.user?.id;
  const rows = top.slice(0, 5).map((r) => {
    const lg = leagueOf(r.rating);
    return `<li class="${r.id === meId ? 'me' : ''}"><span class="rk">${r.rank}</span>${glyph(lg.glyph, lg.color)}<b>${esc(r.name)}</b><em>${r.rating}</em></li>`;
  }).join('');
  $('#lbRank').innerHTML = `<div class="card-head"><p class="eyebrow">Clasificación</p><button class="link-btn" data-go="ranking">Ver todo</button></div>
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
  $('#lbHistory').innerHTML = `<div class="card-head"><p class="eyebrow">Mis últimas partidas</p><button class="link-btn" data-go="history">Ver historial</button></div>
    ${rows ? `<ul class="live-list history-list">${rows}</ul>` : `<p class="muted">${online() ? 'Aquí aparecerán tus partidas online para que las revises o las compartas.' : 'Conéctate para ver tu historial.'}</p>`}`;
}

function renderPresence() {
  const el = $('#lbPresence');
  if (!el) return;
  const st = lb.data.stats;
  el.innerHTML = online() && st ? `<i class="dot"></i> ${st.online} en línea` : '<i class="dot off"></i> Sin conexión';
}

function renderAll() {
  build();
  renderPlayer();
  renderPlay();
  renderCircuit();
  renderEvents();
  renderMissions();
  renderSeason();
  renderSocial();
  renderRank();
  renderLive();
  renderHistory();
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
  if (flags.circuit) {
    await refreshCircuitPublic();
    lb.circuitAt = Date.now();
  }
  if (flags.social) await refreshSocial();
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
  clearInterval(lb.tick);
  lb.tick = setInterval(() => {
    if (app.screen !== 'lobby') return clearInterval(lb.tick);
    const el = $('#lbCount');
    if (el) el.textContent = mmss(circuitState().left ?? 0);
    return undefined;
  }, 1000);
}

// ---------- Eventos ----------
export function initLobby() {
  build();
  onQueueChange(() => renderPlayBodyOnly());
  if (flags.social) onSocial(() => app.screen === 'lobby' && renderSocial());
  onNet(() => {
    if (app.screen === 'lobby') {
      renderPlayer();
      renderPlayBodyOnly();
      renderPresence();
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
    const ch = e.target.closest('[data-challenge]');
    if (ch) return challengeFriend(ch.dataset.challenge, ch.dataset.name);
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (act === 'circuit') return app.go('circuit');
    if (act === 'social') return app.go('social');
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
}
