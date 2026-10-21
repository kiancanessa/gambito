// Lobby híbrido de CHECKPOINT: una arena (3D diferido, con alternativa 2D) y, encima, todo lo que importa para jugar.
//
// Arena: perfil y rango reales, PLAY NOW, torneo Royale destacado y accesos. Debajo: configuración de partida, torneos y eventos,
// misiones, amigos, ranking, partidas en vivo e historial. Todo sale de datos reales (net, store, API); donde no hay nada
// (sin torneos, sin amigos, sin partidas) se muestra un estado vacío, y mientras carga o falla, un esqueleto o un aviso.
import { academyContinue, academyNext, academyPips } from './academy.js';
import { GLYPH, LEAGUES, QUICK_LEVELS, SEASON, TIME_CONTROLS, XP_PER_LEVEL, leagueOf } from './data.js';
import { arenaMode, readCapabilities } from './arena-caps.js';
import { webglSupported } from './board3d.js';
import { circuitMine, circuitPublic, refreshCircuitPublic } from './circuit.js';
import { flags } from './flags.js';
import { missionsSummary } from './missions.js';
import { api, bootstrap, ensureOnline, net, onNet, refreshUser } from './net.js';
import { cancelQueue, createRoom, getTc, joinRoom, onQueueChange, queueInfo, setTc, startQueue } from './online.js';
import { historyHtml, openReplay, tcName } from './replay.js';
import { seasonLevel, seasonSummary } from './season.js';
import { challengeFriend, onSocial, refreshSocial, socialData } from './social.js';
import { state } from './store.js';
import { $, app, avatar, esc, fmtCountdown, fmtDuration, onScreen, showScreen, toast, VS } from './ui.js';

const MODES = [
  { id: 'ranked', label: 'Clasificatoria', hint: 'Sube de liga' },
  { id: 'friend', label: 'Con amigo', hint: 'Por enlace' },
  { id: 'ai', label: 'Contra la IA', hint: 'Práctica' },
  { id: 'academy', label: 'Academia', hint: 'Aprende' },
];
const AI_GLYPHS = ['p', 'p', 'n', 'b', 'r', 'q'];
const AI_COLORS = ['#8bc34a', '#ffb74d', '#4dd0e1', '#ef5350', '#ba68c8', '#ffd54f'];
const REFRESH_MS = 12_000;
const ARENA_IDLE_MS = 45_000; // sin volver al lobby en este tiempo, se libera la escena 3D
const PRESENCE_LABEL = { online: 'En línea', queue: 'Buscando partida', playing: 'Jugando' };

const lb = {
  mode: localStorage.getItem('gambito.lobby.mode') || 'ranked',
  color: 'r',
  aiLevel: 3,
  data: { stats: null, top: [], me: null, live: [], daily: null, history: [] },
  loaded: false, // ya se completó al menos una consulta de datos (con éxito o con fallo)
  circuitAt: 0, // cuándo se leyó el estado público del Circuit (para la cuenta atrás)
  offline: false,
  timer: null,
  tick: null,
  built: false,
  league: null,
};
if (!MODES.some((m) => m.id === lb.mode)) lb.mode = 'ranked';

const glyph = (g, color) => `<span class="lg" style="color:${color}">${GLYPH[g]}${VS}</span>`;
const online = () => !!net.user && !lb.offline;
const connecting = () => !net.booted && !net.user;
const loadingData = () => online() && !lb.loaded;
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const emblem = (lg, cls = '') => `<span class="emblem ${cls}" style="--c:${lg.color}"><i>${GLYPH[lg.glyph]}${VS}</i></span>`;

const ICON = {
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-trophy"/></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-users"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-clock"/></svg>',
  bars: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-bars"/></svg>',
  sword: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-sword"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-user"/></svg>',
  palette: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-palette"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-target"/></svg>',
};
// Estado vacío cuidado: icono, titular, explicación y (opcional) una acción.
const empty = (icon, title, text, action = '') => `<div class="empty-state">${ICON[icon]}<b>${title}</b><p>${text}</p>${action}</div>`;
const skeleton = (rows = 3) => `<div class="skeleton-list" aria-busy="true" aria-label="Cargando">${'<i class="skeleton"></i>'.repeat(rows)}</div>`;

// ---------- Arena (3D diferido + alternativa 2D) ----------
const arena = { inst: null, loading: false, idle: null };

const avatarSpec = () => {
  const lg = leagueOf(net.user?.rating ?? 1000);
  return { type: lg.glyph, color: lg.color };
};

async function startArena() {
  clearTimeout(arena.idle);
  const el = $('#arena');
  if (!el) return;
  if (arena.inst) {
    arena.inst.setAvatar(avatarSpec());
    arena.inst.start();
    return;
  }
  if (arena.loading) return;
  const caps = arenaMode(readCapabilities(webglSupported()));
  el.dataset.render = caps.use3d ? '3d' : '2d'; // (no usar data-mode: lo usan los selectores de modo de juego)
  el.dataset.why = caps.reason;
  if (!caps.use3d) return;
  arena.loading = true;
  el.classList.add('loading3d');
  try {
    const { Arena3D } = await import('./arena3d.js'); // carga diferida: el 3D no pesa hasta que se abre el lobby
    if (app.screen !== 'lobby') return;
    arena.inst = new Arena3D($('#arenaStage'), { avatar: avatarSpec(), animate: caps.animate, onFail: failArena });
    arena.inst.start();
    el.classList.add('is3d');
  } catch (err) {
    console.warn('Arena 3D no disponible, se usa la alternativa 2D:', err);
    failArena();
  } finally {
    arena.loading = false;
    el.classList.remove('loading3d');
  }
}

function disposeArena() {
  clearTimeout(arena.idle);
  arena.inst?.dispose();
  arena.inst = null;
  $('#arena')?.classList.remove('is3d');
}

function failArena() {
  disposeArena();
  const el = $('#arena');
  if (el) {
    el.dataset.render = '2d';
    el.dataset.why = 'rendimiento';
  }
}

// Al salir del lobby se pausa; si se entra en una partida se libera la GPU al instante; si se tarda, también.
function onLeaveLobby(name) {
  if (name === 'lobby') return;
  if (name === 'game') return disposeArena();
  arena.inst?.pause();
  clearTimeout(arena.idle);
  arena.idle = setTimeout(disposeArena, ARENA_IDLE_MS);
  return undefined;
}
app.disposeArena = disposeArena;
app.arenaStats = () => arena.inst?.stats() ?? null; // diagnóstico: recursos gráficos de la escena (null = no hay escena 3D)

// ---------- Estructura ----------
function build() {
  if (lb.built) return;
  lb.built = true;
  $('#lobbyBody').innerHTML = `
    <section class="arena" id="arena" data-render="2d" aria-label="Arena CHECKPOINT">
      <div class="arena-view" aria-hidden="true">
        <div class="arena-2d"><i class="a2-grid"></i><i class="a2-pillar p1"></i><i class="a2-pillar p2"></i><i class="a2-pillar p3"></i><i class="a2-arch"></i>
          <i class="a2-board b1"></i><i class="a2-board b2"></i><i class="a2-board b3"></i><i class="a2-board b4"></i>
          <span class="a2-platform"><i class="a2-ring"></i><span class="a2-avatar" id="a2Avatar"></span></span></div>
        <div class="arena-stage" id="arenaStage"></div>
      </div>
      <div class="arena-hud">
        <section class="hud-card hud-profile" id="arenaProfile" aria-label="Tu perfil"></section>
        <section class="hud-dock" id="arenaDock" aria-label="Jugar"></section>
        <section class="hud-card hud-circuit" id="arenaCircuit" aria-label="Royale Circuit"></section>
      </div>
    </section>
    <div class="lobby-grid">
      <div class="lb-main">
        <section class="lb-card lb-play" id="lbPlay"></section>
        <section class="lb-card lb-events" id="lbEvents"></section>
        <section class="lb-card lb-live" id="lbLive"></section>
        ${flags.replays ? '<section class="lb-card lb-history" id="lbHistory"></section>' : ''}
      </div>
      <div class="lb-side">
        <section class="lb-card lb-prog" id="lbMissions"></section>
        <section class="lb-card" id="lbSeason"></section>
        ${flags.social ? '<section class="lb-card" id="lbSocial"></section>' : ''}
        <section class="lb-card" id="lbRank"></section>
      </div>
    </div>`;
}

// ---------- Perfil y rango (HUD izquierdo) ----------
function renderProfile() {
  const box = $('#arenaProfile');
  if (connecting()) {
    box.innerHTML = `<div class="hp-top">${'<i class="skeleton circle"></i>'}<div class="hp-id">${'<i class="skeleton"></i>'.repeat(2)}</div></div>${skeleton(2)}`;
    return;
  }
  const u = net.user;
  const rating = u?.rating ?? 1000;
  const lg = leagueOf(rating);
  const i = LEAGUES.indexOf(lg);
  const next = LEAGUES[i + 1];
  const pct = next ? Math.max(4, Math.min(100, ((rating - lg.min) / (next.min - lg.min)) * 100)) : 100;
  const need = XP_PER_LEVEL(state.level);
  const pos = lb.data.me && u?.games > 0 ? `<li><b>#${lb.data.me.rank}</b><small>puesto</small></li>` : '';
  const a2 = $('#a2Avatar');
  if (a2) {
    a2.style.setProperty('--c', lg.color);
    a2.textContent = GLYPH[lg.glyph] + VS;
  }
  box.innerHTML = `
    <div class="hp-top">${emblem(lg, 'big')}
      <div class="hp-id"><p class="eyebrow">${u ? `Liga ${lg.name}` : 'Modo local'}</p><h2>${esc(u?.name ?? 'Jugador')}</h2>
        <small>${u ? `<b class="hp-rating">${rating}</b> pts de rating` : 'Sin cuenta conectada'}</small></div></div>
    ${u
      ? `<div class="meter"><div class="meter-head"><span>Rango</span><small>${next ? `${next.min - rating} pts para ${next.name}` : 'liga máxima'}</small></div>
          <div class="lg-bar" role="progressbar" aria-label="Progreso de liga" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%;color:${next?.color ?? lg.color};background:currentColor"></i></div></div>`
      : `<div class="hud-alert" role="alert"><span>Sin conexión con el servidor: tu rating y las partidas online no están disponibles.</span><button class="btn" data-lb="retry">Reintentar</button></div>`}
    <div class="meter"><div class="meter-head"><span>Nivel ${state.level}</span><small>${state.xp}/${need} XP</small></div>
      <div class="xpline" role="progressbar" aria-label="Experiencia" aria-valuenow="${state.xp}" aria-valuemin="0" aria-valuemax="${need}"><i style="width:${Math.min(100, (state.xp / need) * 100)}%"></i></div>
      <small class="meter-foot">Temporada: nivel ${seasonLevel()}/${SEASON.levels}</small></div>
    <ul class="lb-chips"><li><b>${state.daily.streak}</b><small>racha</small></li><li><b>${state.coins}</b><small>oros</small></li>${u ? `<li><b>${u.wins}-${u.losses}</b><small>V-D</small></li>` : ''}${pos}</ul>
    <nav class="hud-links" aria-label="Accesos">
      <button class="btn" data-go="profile">${ICON.user}Perfil</button>
      <button class="btn" data-go="ranking">${ICON.bars}Clasificación</button>
      <button class="btn" data-go="shop">${ICON.palette}Personalizar</button>
      <button class="btn" data-go="missions">${ICON.target}Misiones</button>
    </nav>`;
  if (lb.league !== lg.id) {
    lb.league = lg.id;
    arena.inst?.setAvatar({ type: lg.glyph, color: lg.color });
  }
}

// ---------- PLAY NOW (dock de la arena) ----------
function tcChips(withNone) {
  const cur = getTc();
  return TIME_CONTROLS.filter((t) => withNone || t.id !== 'none')
    .map((t) => `<button class="tc-chip ${t.id === cur ? 'on' : ''}" data-tc="${t.id}"><b>${t.id === 'none' ? '∞' : t.sub}</b><small>${t.id === 'none' ? 'sin reloj' : t.label}</small></button>`)
    .join('');
}

const colorSeg = () =>
  `<div class="seg" data-lbcolor>${[['w', '⚪ Blancas'], ['b', '⚫ Negras'], ['r', '🎲 Azar']].map(([c, l]) => `<button data-color="${c}" class="${lb.color === c ? 'on' : ''}">${l}</button>`).join('')}</div>`;

// Qué hará PLAY NOW según el modo elegido.
function playPlan() {
  if (lb.mode === 'ranked') return { text: `Clasificatoria · ${tcName(getTc())}`, needs: true };
  if (lb.mode === 'friend') return { text: `Partida con amigo · ${tcName(getTc())}`, needs: true };
  if (lb.mode === 'ai') return { text: `Contra la IA · nivel ${QUICK_LEVELS.find((x) => x.id === lb.aiLevel).name}`, needs: false };
  return { text: academyNext().label, needs: false };
}

function renderDock() {
  const q = queueInfo();
  const plan = playPlan();
  const st = lb.data.stats;
  const modes = MODES.map((m) => `<button data-mode="${m.id}" aria-pressed="${m.id === lb.mode}" class="${m.id === lb.mode ? 'on' : ''}">${m.label}</button>`).join('');
  let main;
  if (lb.mode === 'ranked' && q.active) {
    const s = Math.floor((Date.now() - q.since) / 1000);
    main = `<div class="dock-queue" role="status"><div class="spinner"></div><div><b>Buscando rival…</b><small>${tcName(getTc())} · ${mmss(s * 1000)} · la búsqueda se amplía con el tiempo</small></div><button class="btn danger" data-lb="cancel">Cancelar</button></div>`;
  } else {
    const blocked = plan.needs && !online();
    main = `<button class="play-now" id="arenaPlay" data-lb="play" aria-keyshortcuts="P" ${blocked ? 'disabled' : ''}>
        <span class="pn-main">PLAY NOW</span><small>${blocked ? (connecting() ? 'Conectando con el servidor…' : 'Sin conexión: elige la campaña o la IA') : plan.text}</small><kbd aria-hidden="true">P</kbd></button>`;
  }
  $('#arenaDock').innerHTML = `${main}
    <div class="dock-modes" role="group" aria-label="Modo de juego">${modes}</div>
    <p class="dock-foot">${st && online() ? `<i class="dot"></i> ${st.online} en línea · ${st.queue} buscando partida` : loadingData() ? 'Consultando jugadores en línea…' : online() ? '' : '<i class="dot off"></i> Sin conexión'}</p>`;
}

function playBody() {
  const q = queueInfo();
  const needOnline = !online() ? '<p class="warn">Este modo necesita conexión con el servidor.</p>' : '';
  if (lb.mode === 'ranked') {
    if (q.active) return '<p class="muted">Estás en la cola. Puedes cancelar desde el botón de arriba.</p>';
    return `<p class="muted">Rival de tu nivel, con reloj y puntos de liga. Elige el ritmo y pulsa PLAY NOW.</p><div class="tc-grid">${tcChips(false)}</div>${needOnline}`;
  }
  if (lb.mode === 'friend') {
    return `<p class="muted">Crea un enlace y compártelo: la partida empieza cuando tu amigo entre. No cambia tus puntos de liga.</p>
      <div class="tc-grid">${tcChips(true)}</div>${colorSeg()}${needOnline}
      <form class="join-form" id="lbJoin"><input id="lbJoinCode" placeholder="Código o enlace de una partida" maxlength="80" autocomplete="off" aria-label="Código de partida"><button class="btn" ${online() ? '' : 'disabled'}>Unirme</button></form>`;
  }
  if (lb.mode === 'ai') {
    return `<p class="muted">Practica sin conexión contra Stockfish. Más nivel, más oros.</p>
      <div class="level-grid lb-levels">${QUICK_LEVELS.map((x, i) => `<button class="level-card ${x.id === lb.aiLevel ? 'on' : ''}" data-ai="${x.id}">${avatar(AI_GLYPHS[i], AI_COLORS[i])}<b>${x.name}</b><small>🪙 ${Math.round(50 * x.mult)}</small></button>`).join('')}</div>${colorSeg()}`;
  }
  const n = academyNext();
  return `<div class="lb-next"><span class="emblem" style="--c:#34e3a0"><i>${GLYPH.p}${VS}</i></span>
      <div><p class="eyebrow">${n.stage}</p><h3>${n.title}</h3><small>${n.sub}</small></div></div>
    <div class="pips" aria-label="Progreso de la Academia">${academyPips().map((on) => `<i class="${on}"></i>`).join('')}</div>
    <button class="btn lb-secondary" data-go="academy">Ver toda la ruta</button>`;
}

function renderPlay() {
  $('#lbPlay').innerHTML = `
    <div class="card-head"><p class="eyebrow">Configurar partida</p><span class="pill">${MODES.find((m) => m.id === lb.mode).label}</span></div>
    <div class="lb-play-body" id="lbPlayBody">${playBody()}</div>`;
}

// Solo el cuerpo (la cola cambia cada segundo; no se rehace nada que pierda el foco).
function renderPlayOnly() {
  if (app.screen !== 'lobby') return;
  const el = $('#lbPlayBody');
  if (el) el.innerHTML = playBody();
  renderDock();
}

function runPlay() {
  if (lb.mode === 'ranked') return startQueue();
  if (lb.mode === 'friend') return createRoom({ tc: getTc(), color: lb.color });
  if (lb.mode === 'ai') return app.startQuick(lb.aiLevel, lb.color);
  return academyContinue();
}

// ---------- Royale Circuit (HUD derecho) ----------
function circuitState() {
  const pub = circuitPublic();
  const mine = circuitMine();
  const left = pub?.open ? pub.open.fillInMs - (Date.now() - lb.circuitAt) : 0;
  if (mine?.status === 'registering') return { kind: 'joined', mine, left: mine.fillInMs - (Date.now() - lb.circuitAt) };
  if (mine?.status === 'running' && !mine.you?.out) return { kind: 'playing', mine };
  if (pub?.open) return { kind: 'open', open: pub.open, size: pub.size, left };
  if (pub?.running?.length) return { kind: 'running', running: pub.running };
  if (!pub) return { kind: 'unknown' };
  return { kind: 'idle' };
}

function renderCircuit() {
  const box = $('#arenaCircuit');
  if (!flags.circuit) {
    box.innerHTML = '<p class="eyebrow">Royale Circuit</p><h3>Torneos eliminatorios</h3><p class="muted">Muy pronto: entra, sobrevive ronda a ronda y gana cosméticos exclusivos.</p><span class="pill soon">Próximamente</span>';
    return;
  }
  const c = circuitState();
  const head = (pill) => `<div class="card-head"><p class="eyebrow">Royale Circuit</p>${pill}</div>`;
  const prize = '<ul class="prize-row compact"><li>Cuartos <b>🪙 30</b></li><li>Semi <b>🪙 60</b></li><li>Final <b>🪙 120</b></li><li class="top">Campeón <b>🪙 250 + 👑</b></li></ul>';
  if (c.kind === 'unknown') {
    if (connecting() || loadingData()) {
      box.innerHTML = `${head('')}<h3>Eliminatoria de 8</h3>${skeleton(2)}`;
    } else {
      box.innerHTML = `${head('<span class="pill bad">Sin datos</span>')}<h3>Eliminatoria de 8</h3><div class="hud-alert" role="alert"><span>No se pudo consultar el estado de los torneos.</span><button class="btn" data-lb="retry">Reintentar</button></div>`;
    }
    return;
  }
  if (c.kind === 'idle') {
    box.innerHTML = `${head('<span class="pill ok">Libre</span>')}<h3>Eliminatoria de 8 · Blitz 3+2</h3>
      ${empty('trophy', 'No hay torneos abiertos', 'Abre el siguiente: arranca un minuto después de la primera inscripción y se completa con bots.')}
      ${prize}<button class="btn primary" data-lb="circuit">Abrir un torneo</button>`;
    return;
  }
  let pill = '';
  let line = '';
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
  } else {
    pill = `<span class="pill live">${c.running.length} en curso</span>`;
    line = 'Hay torneos en marcha: míralos en directo o abre uno nuevo.';
  }
  box.innerHTML = `${head(pill)}<h3>Eliminatoria de 8 · Blitz 3+2</h3><p class="muted">${line}</p>${prize}<button class="btn primary" data-lb="circuit">${cta}</button>`;
}

// ---------- Torneos y eventos ----------
function renderEvents() {
  const d = lb.data.daily;
  const pub = circuitPublic();
  const season = seasonSummary();
  const daysLeft = Math.max(0, Math.ceil((new Date(`${SEASON.endsAt}T23:59:59`).getTime() - Date.now()) / 86_400_000));
  const rows = [];
  if (flags.circuit && pub) {
    const c = circuitState();
    if (c.kind === 'open' || c.kind === 'joined') {
      const n = c.kind === 'open' ? `${c.open.joined}/${c.size}` : `${c.mine.entrants.length}/${c.mine.size}`;
      rows.push(['live', 'ACTIVO', 'Royale Circuit · inscripción abierta', `${n} jugadores · Blitz 3+2`, `<button class="btn primary" data-lb="circuit">${c.kind === 'open' ? 'Entrar' : 'Ver'}</button>`]);
    }
    for (const t of pub.running ?? []) {
      const live = t.live[0];
      rows.push(['live', 'EN CURSO', `Royale Circuit · ${live?.label ?? 'en juego'}`, live ? `${esc(live.a)} vs ${esc(live.b)}` : 'Rondas simuladas entre bots', live ? `<button class="btn" data-spectate="${esc(live.code)}">Ver</button>` : '']);
    }
    if (!rows.length) rows.push(['next', 'PRÓXIMO', 'Royale Circuit', 'No hay ninguno abierto: se abre cuando alguien se inscribe y empieza 1 min después', '<button class="btn" data-lb="circuit">Abrir uno</button>']);
  }
  if (online() && d) {
    rows.push([d.mine ? 'done' : 'today', 'HOY', `Desafío diario #${d.number} · mate en ${d.mateIn}`, `${d.mine ? `Resuelto en ${fmtDuration(d.mine.seconds)} · puesto #${d.mine.rank}` : `${d.solvedCount} lo resolvieron`} · cierra en ${fmtCountdown(d.nextResetAt - Date.now())}`, `<button class="btn ${d.mine ? '' : 'primary'}" data-go="daily">${d.mine ? 'Ranking' : 'Resolver'}</button>`]);
  }
  rows.push(['next', 'PRÓXIMO', season.name, daysLeft ? `La temporada termina en ${daysLeft} día${daysLeft > 1 ? 's' : ''} · nivel ${season.level}/${season.levels}` : 'La temporada ha terminado', '<button class="btn" data-go="season">Ver pase</button>']);
  const body = loadingData() && !pub ? skeleton(3) : `<ul class="ev-list">${rows.map(([kind, tag, title, sub, action]) => `<li class="${kind}"><span class="ev-tag">${tag}</span><span class="ev-main"><b>${title}</b><small>${sub}</small></span>${action}</li>`).join('')}</ul>`;
  $('#lbEvents').innerHTML = `<div class="card-head"><p class="eyebrow">Torneos y eventos</p></div>${body}`;
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
  let body;
  if (!d) body = connecting() || loadingData() ? skeleton(2) : empty('users', 'Amigos no disponibles', 'Conéctate al servidor para ver quién está en línea.');
  else if (active.length) body = `<ul class="fr-mini">${active.map((f) => `<li><i class="pdot ${f.presence === 'playing' ? 'play' : f.presence === 'queue' ? 'queue' : 'on'}"></i><span><b>${esc(f.name)}</b><small>${PRESENCE_LABEL[f.presence]}</small></span><button class="btn" data-challenge="${esc(f.id)}" data-name="${esc(f.name)}">Retar</button></li>`).join('')}</ul>`;
  else if (d.friends.length) body = empty('users', 'Nadie conectado', `Tus ${d.friends.length} amigos están desconectados ahora mismo.`);
  else body = empty('users', 'Aún no tienes amigos', 'Comparte tu código de amigo o añade el de alguien para retarlo.');
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
  let body;
  if (rows) body = `<ol class="lb">${rows}</ol>${me && net.user?.games > 0 ? `<p class="next-line muted">Tu posición: <b>#${me.rank}</b> · ${me.rating} pts</p>` : ''}`;
  else if (loadingData()) body = skeleton(3);
  else body = empty('bars', 'La tabla está vacía', 'Nadie ha jugado una clasificatoria todavía. El primero en jugar encabeza la liga.');
  $('#lbRank').innerHTML = `<div class="card-head"><p class="eyebrow">Clasificación</p><button class="link-btn" data-go="ranking">Ver todo</button></div>${body}`;
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
  let body;
  if (rows) body = `<ul class="live-list">${rows}</ul>`;
  else if (loadingData()) body = skeleton(2);
  else if (!online()) body = empty('sword', 'Sin conexión', 'Conéctate para ver partidas en directo.');
  else body = empty('sword', 'Ninguna partida en directo', 'No hay clasificatorias en curso. Empieza una y deja que otros te vean jugar.');
  $('#lbLive').innerHTML = `<div class="card-head"><p class="eyebrow"><i class="dot live"></i> Partidas en vivo</p></div>${body}`;
}

function renderHistory() {
  if (!flags.replays) return;
  const rows = historyHtml(lb.data.history);
  let body;
  if (rows) body = `<ul class="live-list history-list">${rows}</ul>`;
  else if (loadingData()) body = skeleton(2);
  else if (!online()) body = empty('clock', 'Sin conexión', 'Conéctate para ver tu historial.');
  else body = empty('clock', 'Aún no hay partidas que repetir', 'Cuando termines una partida online podrás verla paso a paso, compartirla o grabar un clip.');
  $('#lbHistory').innerHTML = `<div class="card-head"><p class="eyebrow">Mis últimas partidas</p><button class="link-btn" data-go="history">Ver historial</button></div>${body}`;
}

function renderAll() {
  build();
  renderProfile();
  renderDock();
  renderCircuit();
  renderPlay();
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
  if (!net.user) {
    lb.loaded = true;
    return;
  }
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
  lb.loaded = true;
  if (app.screen === 'lobby') renderAll();
}

export async function enterLobby() {
  showScreen('lobby');
  renderAll(); // al instante, con los datos locales (y esqueletos donde aún no hay datos)
  startArena();
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
  onScreen(onLeaveLobby);
  onQueueChange(() => renderPlayOnly());
  if (flags.social) onSocial(() => app.screen === 'lobby' && renderSocial());
  onNet(() => {
    if (app.screen === 'lobby') {
      renderProfile();
      renderPlayOnly();
      renderCircuit();
    }
  });

  // Atajo de teclado: P = PLAY NOW (si no se está escribiendo ni hay un diálogo abierto).
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'p' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (app.screen !== 'lobby' || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    if (document.querySelector('#modal:not([hidden])')) return;
    const btn = $('#arenaPlay');
    if (btn && !btn.disabled) {
      e.preventDefault();
      btn.click();
    }
  });

  const root = $('#screen-lobby');
  root.addEventListener('click', async (e) => {
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      lb.mode = mode.dataset.mode;
      localStorage.setItem('gambito.lobby.mode', lb.mode);
      renderPlay();
      return renderDock();
    }
    const tc = e.target.closest('[data-tc]');
    if (tc) {
      setTc(tc.dataset.tc);
      return renderPlayOnly();
    }
    const col = e.target.closest('[data-lbcolor] [data-color]');
    if (col) {
      lb.color = col.dataset.color;
      return renderPlayOnly();
    }
    const ai = e.target.closest('[data-ai]');
    if (ai) {
      lb.aiLevel = Number(ai.dataset.ai);
      return renderPlayOnly();
    }
    const rep = e.target.closest('[data-replay]');
    if (rep) return openReplay(rep.dataset.replay);
    const spec = e.target.closest('[data-spectate]');
    if (spec) return joinRoom(spec.dataset.spectate);
    const ch = e.target.closest('[data-challenge]');
    if (ch) return challengeFriend(ch.dataset.challenge, ch.dataset.name);
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (act === 'play') return runPlay();
    if (act === 'retry') {
      lb.loaded = false;
      renderAll();
      await bootstrap();
      return refresh();
    }
    if (act === 'circuit') return app.go('circuit');
    if (act === 'social') return app.go('social');
    if (act === 'cancel') return cancelQueue();
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
