// Jugar (antes «lobby»): un modo principal destacado —la clasificatoria— y el resto como bloques compactos.
//
// Regla de diseño: un solo botón primario a la vista. Si se abre otro modo, su acción pasa a ser la principal; sin conexión,
// el modo principal disponible es la partida contra la IA. Todo sale de datos reales (net, store, API); donde no hay nada,
// un estado vacío; mientras carga o falla, un esqueleto o un aviso.
import { academyContinue, academyNext, academyPips } from './academy.js';
import { GLYPH, QUICK_LEVELS, TIME_CONTROLS, leagueOf } from './data.js';
import { circuitClock, circuitHud, onCircuit, openCircuit, refreshCircuitPublic, watchCircuitList } from './circuit.js';
import { flags } from './flags.js';
import { api, bootstrap, ensureOnline, net, onNet, refreshUser } from './net.js';
import { cancelQueue, createRoom, getTc, joinRoom, onQueueChange, queueInfo, setTc, startQueue } from './online.js';
import { tcName } from './replay.js';
import { $, app, avatar, esc, fmtCountdown, fmtDuration, showScreen, toast, VS } from './ui.js';

const MODES = {
  ai: { title: 'Partida rápida', sub: 'Contra Stockfish, también sin conexión' },
  circuit: { title: 'Royale Circuit', sub: 'Torneos eliminatorios programados' },
  friend: { title: 'Jugar con amigos', sub: 'Por enlace o código' },
  academy: { title: 'Entrenamiento', sub: 'Academia y desafío diario' },
};
const AI_GLYPHS = ['p', 'p', 'n', 'b', 'r', 'q'];
const AI_COLORS = ['#8bc34a', '#ffb74d', '#4dd0e1', '#ef5350', '#ba68c8', '#ffd54f'];
const REFRESH_MS = 12_000;

const readMode = () => {
  try {
    return localStorage.getItem('gambito.lobby.mode');
  } catch {
    return null;
  }
};
const lb = {
  mode: ['ai', 'friend', 'academy'].includes(readMode()) ? readMode() : 'ranked', // 'ranked' = ningún bloque abierto
  color: 'r',
  aiLevel: 3,
  data: { stats: null, me: null, daily: null },
  loaded: false,
  offline: false,
  timer: null,
  tick: null,
};

const online = () => !!net.user && !lb.offline;
const connecting = () => !net.booted && !net.user;
const loadingData = () => online() && !lb.loaded;
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const hhmm = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const cd = (until) => `<b class="cd" data-until="${until}">${mmss(until - circuitClock())}</b>`;
// Qué acción es la principal ahora mismo (solo una se pinta como botón primario).
const primaryMode = () => (lb.mode !== 'ranked' ? lb.mode : online() || connecting() ? 'ranked' : 'ai');

function tcChips(withNone) {
  const cur = getTc();
  return TIME_CONTROLS.filter((t) => withNone || t.id !== 'none')
    .map((t) => `<button class="tc-chip ${t.id === cur ? 'on' : ''}" data-tc="${t.id}" aria-pressed="${t.id === cur}"><b>${t.id === 'none' ? '∞' : t.sub}</b><small>${t.id === 'none' ? 'sin reloj' : t.label}</small></button>`)
    .join('');
}
const colorSeg = () =>
  `<div class="seg" data-lbcolor role="group" aria-label="Tu color">${[['w', 'Blancas'], ['b', 'Negras'], ['r', 'Al azar']].map(([c, l]) => `<button data-color="${c}" class="${lb.color === c ? 'on' : ''}" aria-pressed="${lb.color === c}">${l}</button>`).join('')}</div>`;
const actionBtn = (mode, label, attrs = '') => {
  const main = primaryMode() === mode;
  return `<button class="btn lg ${main ? 'primary' : ''}" ${main ? 'id="plPrimary" aria-keyshortcuts="P"' : ''} ${attrs}>${label}</button>`;
};

// ---------- Modo principal: clasificatoria ----------
function renderHero() {
  const box = $('#plHero');
  const q = queueInfo();
  const u = net.user;
  const lg = leagueOf(u?.rating ?? 1000);
  const st = lb.data.stats;
  const meta = u
    ? `<span class="pl-league" style="--c:${lg.color}">${GLYPH[lg.glyph]}${VS} Liga ${esc(lg.name)}</span><span>${u.rating} pts</span>${lb.data.me && u.games > 0 ? `<span>Puesto #${lb.data.me.rank}</span>` : ''}`
    : '';
  let action;
  if (q.active) {
    const s = Math.floor((Date.now() - q.since) / 1000);
    action = `<div class="pl-queue" role="status"><span class="spinner"></span><span><b>Buscando rival…</b><small>${esc(tcName(getTc()))} · ${mmss(s * 1000)} · la búsqueda se amplía con el tiempo</small></span><button class="btn" data-lb="cancel">Cancelar</button></div>`;
  } else if (connecting()) {
    action = '<p class="pl-note" aria-busy="true">Conectando con el servidor…</p>';
  } else if (!online()) {
    action = '<div class="pl-offline" role="alert"><span>Sin conexión: la clasificatoria necesita el servidor.</span><button class="btn" data-lb="retry">Reintentar</button></div>';
  } else {
    action = `<div class="pl-tc" role="group" aria-label="Ritmo de juego">${tcChips(false)}</div>${actionBtn('ranked', 'Buscar rival', 'data-lb="ranked"')}`;
  }
  box.innerHTML = `
    <div class="pl-hero-head"><p class="pl-kicker">Modo principal</p><h3>Clasificatoria</h3>
      <p class="pl-sub">Un rival de tu nivel, con reloj y puntos de liga.</p>${meta ? `<p class="pl-meta">${meta}</p>` : ''}</div>
    <div class="pl-hero-act">${action}</div>
    ${st && online() ? `<p class="pl-foot"><i class="dot"></i> ${st.online} en línea · ${st.queue} buscando partida</p>` : ''}`;
}

// ---------- Otros modos ----------
function circuitLine() {
  if (!flags.circuit) return 'Próximamente';
  const c = circuitHud();
  if (c.kind === 'unknown') return connecting() || loadingData() ? 'Consultando torneos…' : 'Sin datos de torneos';
  if (c.kind === 'idle') return 'No hay torneos programados';
  const t = c.t ?? c.running[0];
  if (c.kind === 'open') return `${esc(t.name)} · inscripción abierta, cierra en ${cd(t.regClosesAt)}`;
  if (c.kind === 'joined') return `Inscrito en ${esc(t.name)} · empieza a las ${hhmm(t.startsAt)}`;
  if (c.kind === 'playing') return `Compitiendo en ${esc(t.name)}`;
  if (c.kind === 'next') return `${esc(t.name)} · ${t.status === 'closed' ? `empieza en ${cd(t.startsAt)}` : `inscripción en ${cd(t.regOpensAt)}`}`;
  return `${c.running.length} torneo${c.running.length > 1 ? 's' : ''} en curso`;
}

function modeSub(id) {
  if (id === 'circuit') return circuitLine();
  if (id === 'academy') return esc(academyNext().label);
  if (id === 'ai') return `${MODES.ai.sub} · nivel ${esc(QUICK_LEVELS.find((x) => x.id === lb.aiLevel).name)}`;
  return MODES[id].sub;
}

function renderModes() {
  const c = flags.circuit ? circuitHud() : null;
  const live = c && (c.kind === 'open' || c.kind === 'playing' || c.kind === 'running');
  $('#plModes').innerHTML = ['ai', 'circuit', 'friend', 'academy']
    .map((id) => {
      const open = lb.mode === id;
      const badge = id === 'circuit' && live ? `<span class="pill live">${c.kind === 'playing' ? 'En juego' : c.kind === 'open' ? 'Abierto' : 'En curso'}</span>` : '';
      const aria = id === 'circuit' ? '' : `aria-expanded="${open}" aria-controls="plPanel"`;
      return `<button class="pl-mode ${open ? 'on' : ''}" data-pl="${id}" ${aria}>
        <span class="pl-mode-txt"><b>${MODES[id].title}</b><small>${modeSub(id)}</small></span>${badge}<span class="pl-chev" aria-hidden="true">${id === 'circuit' ? '›' : open ? '−' : '+'}</span></button>`;
    })
    .join('');
}

function panelBody() {
  if (lb.mode === 'ai') {
    return `<div class="level-grid pl-levels" role="group" aria-label="Nivel del rival">${QUICK_LEVELS.map((x, i) => `<button class="level-card ${x.id === lb.aiLevel ? 'on' : ''}" data-ai="${x.id}" aria-pressed="${x.id === lb.aiLevel}">${avatar(AI_GLYPHS[i], AI_COLORS[i])}<b>${x.name}</b><small>🪙 ${Math.round(50 * x.mult)}</small></button>`).join('')}</div>
      <div class="pl-row">${colorSeg()}${actionBtn('ai', 'Jugar contra la IA', 'data-lb="play"')}</div>`;
  }
  if (lb.mode === 'friend') {
    const off = !online();
    return `<p class="pl-note">Crea un enlace y compártelo: la partida empieza cuando tu amigo entra. No cambia tus puntos de liga.</p>
      <div class="pl-tc" role="group" aria-label="Ritmo de juego">${tcChips(true)}</div>
      <div class="pl-row">${colorSeg()}${actionBtn('friend', 'Crear partida por enlace', `data-lb="play" ${off ? 'disabled' : ''}`)}</div>
      <form class="join-form pl-join" id="lbJoin"><input id="lbJoinCode" placeholder="Código o enlace de una partida" maxlength="80" autocomplete="off" aria-label="Código de partida"><button class="btn" ${off ? 'disabled' : ''}>Unirme</button></form>
      ${off ? '<p class="pl-note warn">Este modo necesita conexión con el servidor.</p>' : ''}
      ${flags.social ? '<button class="btn ghost" data-go="social">Mis amigos</button>' : ''}`;
  }
  const n = academyNext();
  const d = lb.data.daily;
  const daily = online() && d
    ? `<div class="pl-daily"><span><b>Desafío diario #${d.number} · mate en ${d.mateIn}</b><small>${d.mine ? `Resuelto en ${fmtDuration(d.mine.seconds)} · puesto #${d.mine.rank}` : `${d.solvedCount} lo resolvieron`} · cierra en ${fmtCountdown(d.nextResetAt - Date.now())}</small></span><button class="btn" data-go="daily">${d.mine ? 'Ver ranking' : 'Resolver'}</button></div>`
    : '';
  return `<div class="pl-next"><span class="emblem" style="--c:#34e3a0"><i>${GLYPH.p}${VS}</i></span>
      <span><small>${esc(n.stage ?? '')}</small><b>${esc(n.title)}</b><small>${esc(n.sub ?? '')}</small></span></div>
    <div class="pips" aria-label="Progreso de la Academia">${academyPips().map((on) => `<i class="${on}"></i>`).join('')}</div>
    <div class="pl-row">${actionBtn('academy', esc(n.label), 'data-lb="play"')}<button class="btn ghost" data-go="academy">Ver toda la ruta</button></div>
    ${daily}`;
}

function renderPanel() {
  const panel = $('#plPanel');
  panel.hidden = lb.mode === 'ranked';
  if (panel.hidden) panel.innerHTML = ''; // sin restos ocultos: un solo botón principal en la página
  else panel.innerHTML = `<div class="pl-panel-head"><h3>${MODES[lb.mode].title}</h3><button class="btn ghost sm" data-pl="close">Cerrar</button></div>${panelBody()}`;
}

function renderAll() {
  if (!$('#plHero')) {
    $('#lobbyBody').innerHTML = `<div class="pl">
      <section class="pl-hero" id="plHero" aria-label="Clasificatoria"></section>
      <div class="pl-modes" id="plModes"></div>
      <section class="pl-panel" id="plPanel" hidden></section>
      <p class="pl-more"><button class="link-btn" data-go="watch">Espectar partidas en directo</button></p>
    </div>`;
  }
  renderHero();
  renderModes();
  renderPanel();
}
// La cola cambia cada segundo: solo se repinta lo necesario (sin perder el foco de un campo).
function renderQueueOnly() {
  if (app.screen !== 'lobby') return;
  renderHero();
  if (lb.mode !== 'friend') renderPanel();
}

function runPlay() {
  if (lb.mode === 'friend') return createRoom({ tc: getTc(), color: lb.color });
  if (lb.mode === 'ai') return app.startQuick(lb.aiLevel, lb.color);
  if (lb.mode === 'academy') return academyContinue();
  return startQueue();
}

function setMode(mode) {
  lb.mode = mode;
  try {
    localStorage.setItem('gambito.lobby.mode', mode);
  } catch {
    /* sin almacenamiento */
  }
  renderAll();
  if (mode !== 'ranked') $('#plPanel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- Datos ----------
async function refresh() {
  if (!net.user) {
    lb.loaded = true;
    return;
  }
  const [st, top, daily] = await Promise.all([api('/api/stats', { auth: false }), api('/api/leaderboard?limit=1'), api('/api/daily')]);
  if (app.screen !== 'lobby') return;
  lb.offline = !(st.ok || top.ok);
  if (st.ok) lb.data.stats = st.json;
  if (top.ok) lb.data.me = top.json.me;
  if (daily.ok) lb.data.daily = daily.json;
  if (flags.circuit) await refreshCircuitPublic();
  await refreshUser();
  lb.loaded = true;
  if (app.screen === 'lobby') renderAll();
}

export async function enterLobby() {
  showScreen('lobby');
  renderAll();
  await ensureOnline();
  if (app.screen !== 'lobby') return;
  renderAll();
  refresh();
  if (flags.circuit) watchCircuitList(); // el estado del Circuit se actualiza solo mientras estás aquí
  clearInterval(lb.timer);
  lb.timer = setInterval(() => (app.screen === 'lobby' ? !document.hidden && refresh() : clearInterval(lb.timer)), REFRESH_MS); // en una pestaña oculta no se consulta
  clearInterval(lb.tick);
  lb.tick = setInterval(() => {
    if (app.screen !== 'lobby') return clearInterval(lb.tick);
    for (const el of document.querySelectorAll('#lobbyBody .cd')) el.textContent = mmss(Number(el.dataset.until) - circuitClock());
    return undefined;
  }, 1000);
}

// ---------- Eventos ----------
export function initLobby() {
  onQueueChange(() => renderQueueOnly());
  onCircuit(() => app.screen === 'lobby' && renderModes());
  onNet(() => app.screen === 'lobby' && renderAll());

  // Atajo de teclado: P = la acción principal (si no se está escribiendo ni hay un diálogo abierto).
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'p' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (app.screen !== 'lobby' || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    if (document.querySelector('#modal:not([hidden])')) return;
    const btn = $('#plPrimary');
    if (btn && !btn.disabled) {
      e.preventDefault();
      btn.click();
    }
  });

  const root = $('#screen-lobby');
  root.addEventListener('click', async (e) => {
    const pl = e.target.closest('[data-pl]')?.dataset.pl;
    if (pl === 'circuit') return openCircuit(null);
    if (pl === 'close') return setMode('ranked');
    if (pl) return setMode(lb.mode === pl ? 'ranked' : pl);
    const tc = e.target.closest('[data-tc]');
    if (tc) {
      setTc(tc.dataset.tc);
      return renderAll();
    }
    const col = e.target.closest('[data-lbcolor] [data-color]');
    if (col) {
      lb.color = col.dataset.color;
      return renderPanel();
    }
    const ai = e.target.closest('[data-ai]');
    if (ai) {
      lb.aiLevel = Number(ai.dataset.ai);
      renderModes();
      return renderPanel();
    }
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (act === 'ranked') return startQueue();
    if (act === 'play') return runPlay();
    if (act === 'cancel') return cancelQueue();
    if (act === 'retry') {
      lb.loaded = false;
      renderAll();
      await bootstrap();
      return refresh();
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
