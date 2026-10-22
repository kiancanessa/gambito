// Multijugador: partidas con amigos por enlace, emparejamiento clasificatorio, espectadores y emotes.
import { EMOTES, GLYPH, LEAGUES, TIME_CONTROLS, leagueOf } from './data.js';
import { feedback } from './feedback.js';
import { sfx } from './fx.js';
import { buzz, prefs } from './prefs.js';
import { announceRecords, recordsHtml, updateRecords } from './records.js';
import { flags } from './flags.js';
import { api, ensureOnline, net, refreshUser, socket } from './net.js';
import { startSession, setBanner } from './session.js';
import { shareGame } from './share.js';
import { addCoins, save, state } from './store.js';
import { $, $$, app, avatar, celebrate, choice, confirmModal, copyText, esc, fmtClock, showScreen, toast, VS, wait } from './ui.js';

const on = {
  code: null,
  game: null,
  pc: 'w',
  spectator: false,
  last: null, // último estado recibido
  clock: null, // { w, b, running, at }
  pendingUntil: 0, // hasta cuándo se espera la confirmación del servidor de mi jugada
  statusTimer: null,
  sendingTimer: null,
  offline: false, // mi conexión con el servidor está caída
  oppDcUntil: 0, // hasta cuándo puede volver el rival antes de perder (0 = conectado)
  lastTickSec: null,
  ended: false,
  wantRematch: false,
  tc: localStorage.getItem('gambito.tc') || 'blitz5',
  color: 'r',
  queued: false,
  queueSince: 0,
  hubTimer: null,
  clockTimer: null,
};

// Estado visible de mi última jugada: «Enviando…» (solo si tarda más de 0,2 s), «✓ Aceptada» o «✗ Rechazada».
// La confirmación inmediata es el cambio de color de la última jugada (gris → amarillo) cuando el servidor la acepta.
function moveStatus(kind) {
  const el = $('#moveStatus');
  clearTimeout(on.statusTimer);
  if (!kind) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `move-status ${kind}`;
  el.textContent = { sending: 'Enviando…', ok: '✓ Aceptada', bad: '✗ Rechazada' }[kind];
  if (kind !== 'sending') on.statusTimer = setTimeout(() => (el.hidden = true), kind === 'ok' ? 900 : 1600);
}

// Banner de conexión: mi propia conexión tiene prioridad sobre la del rival.
function paintBanner() {
  const b = $('#connBanner');
  const s = on.last;
  let text = '';
  let kind = '';
  if (on.offline && s?.status === 'playing') {
    text = 'Sin conexión: reconectando… Tu reloj sigue corriendo y volverás a la partida en cuanto se recupere.';
    kind = 'warn';
  } else if (on.oppDcUntil && s?.status === 'playing' && !on.spectator) {
    const left = Math.max(0, on.oppDcUntil - Date.now());
    text = `Tu rival se ha desconectado. Si no vuelve en ${fmtClock(left).replace(/\.\d$/, '')}, ganas por desconexión.`;
    kind = 'rival';
  }
  b.hidden = !text;
  if (text) {
    b.className = `conn-banner ${kind}`;
    if (b.textContent !== text) b.textContent = text;
  }
}

const tcLabel = (id) => {
  const t = TIME_CONTROLS.find((x) => x.id === id);
  return t ? (id === 'none' ? 'Sin reloj' : `${t.label} ${t.sub}`) : id;
};
const linkFor = (code) => `${location.origin}/g/${code}`;

// ---------- Hub ----------
export async function enterHub() {
  showScreen('online');
  $('#onlineBody').hidden = true;
  $('#onlineOffline').hidden = true;
  const ok = await ensureOnline();
  if (app.screen !== 'online') return;
  $('#onlineOffline').hidden = ok;
  $('#onlineBody').hidden = !ok;
  if (!ok) return;
  renderHub();
  refreshHubData();
  clearInterval(on.hubTimer);
  on.hubTimer = setInterval(() => (app.screen === 'online' ? !document.hidden && refreshHubData() : clearInterval(on.hubTimer)), 15000);
}

function renderHub() {
  const u = net.user;
  const lg = leagueOf(u.rating);
  $('#onlineProfile').innerHTML = `${avatar(lg.glyph, lg.color)}
    <div class="who"><b>${esc(u.name)}</b><small>Liga ${lg.name} · ${u.rating} pts · ${u.wins}V ${u.losses}D ${u.draws}T</small></div>
    <button class="btn" data-open="profile">Perfil</button>`;
  $('#tcGrid').innerHTML = TIME_CONTROLS.filter((t) => t.id !== 'none')
    .map((t) => `<button class="tc-chip ${t.id === on.tc ? 'on' : ''}" data-tc="${t.id}"><b>${t.sub}</b><small>${t.label}</small></button>`)
    .join('');
  $('#friendTc').innerHTML = TIME_CONTROLS.map((t) => `<option value="${t.id}" ${t.id === on.tc ? 'selected' : ''}>${t.id === 'none' ? 'Sin reloj' : `${t.label} · ${t.sub}`}</option>`).join('');
  $$('#friendColor button').forEach((b) => b.classList.toggle('on', b.dataset.color === on.color));
  renderQueue();
}

async function refreshHubData() {
  const [lb, st] = await Promise.all([api('/api/leaderboard'), api('/api/stats', { auth: false })]);
  if (st.ok) $('#onlineCount').innerHTML = `<i class="dot"></i> ${st.json.online} en línea`;
  if (lb.ok) {
    const meId = net.user?.id;
    const rows = lb.json.top.slice(0, 10).map((r) => {
      const lg = leagueOf(r.rating);
      return `<li class="${r.id === meId ? 'me' : ''}"><span class="rk">${r.rank}</span><span class="lg" style="color:${lg.color}">${GLYPH[lg.glyph]}${VS}</span><b>${esc(r.name)}</b><em>${r.rating}</em></li>`;
    }).join('');
    $('#leaderboardCard').innerHTML = `<p class="eyebrow">Clasificación</p>
      <ol class="lb">${rows || '<li class="empty">Aún no hay partidas clasificatorias. ¡Sé el primero!</li>'}</ol>
      ${lb.json.me && net.user?.games > 0 ? `<p class="next-line muted">Tu posición: <b>#${lb.json.me.rank}</b> · ${lb.json.me.rating} pts</p>` : ''}
      <div class="league-legend">${LEAGUES.map((l) => `<span title="${l.name} desde ${l.min}" style="color:${l.color}">${GLYPH[l.glyph]}${VS}</span>`).join('')}</div>`;
  }
  await refreshUser();
  if (app.screen === 'online') renderHub();
}

// Otras pantallas (el lobby) reutilizan estas acciones y se suscriben al estado de la cola.
export const getTc = () => on.tc;
export function setTc(id) {
  on.tc = id;
  localStorage.setItem('gambito.tc', id);
}
export const queueInfo = () => ({ active: on.queued, since: on.queueSince });
const queueSubs = new Set();
export const onQueueChange = (fn) => queueSubs.add(fn);

function renderQueue() {
  $('#queueBox').hidden = !on.queued;
  $('#queueBtn').hidden = on.queued;
  if (on.queued) {
    const s = Math.floor((Date.now() - on.queueSince) / 1000);
    $('#queueTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  queueSubs.forEach((fn) => fn(queueInfo()));
}

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

export async function startQueue() {
  if (!(await connect())) return;
  on.queued = true;
  on.queueSince = Date.now();
  socket.send({ t: 'queue', tc: on.tc });
  renderQueue();
  clearInterval(on.queueTimer);
  on.queueTimer = setInterval(() => (on.queued ? renderQueue() : clearInterval(on.queueTimer)), 1000);
}

export function cancelQueue() {
  on.queued = false;
  socket.send({ t: 'dequeue' });
  renderQueue();
}

export async function createRoom({ tc, color = 'r' }) {
  if (!(await connect())) return;
  setTc(tc);
  socket.send({ t: 'create', tc, color });
}

const createFriendGame = () => createRoom({ tc: $('#friendTc').value, color: on.color });

export async function joinRoom(code) {
  if (!(await connect())) return false;
  on.ended = false;
  socket.send({ t: 'join', code });
  return true;
}

export const joinFromLink = async (code) => {
  const ok = await joinRoom(code.toUpperCase());
  if (!ok) history.replaceState(null, '', '/');
};

// ---------- Partida ----------
const oppInfo = (p) => {
  const lg = leagueOf(p?.rating ?? 1000);
  return { name: p?.name ?? 'Esperando rival...', title: p ? `Liga ${lg.name} · ${p.rating}` : '', glyph: lg.glyph, color: lg.color };
};

function openGame(s) {
  on.code = s.code;
  on.spectator = s.you === 's';
  on.pc = on.spectator ? 'w' : s.you;
  on.ended = false;
  on.pendingUntil = 0;
  socket.room = s.code;
  history.replaceState(null, '', `/g/${s.code}`);
  const oppRole = on.pc === 'w' ? 'b' : 'w';
  const game = startSession({
    opp: oppInfo(s.players[oppRole]),
    playerColor: on.pc,
    spectator: on.spectator,
    remote: {
      send: (uci) => {
        on.pendingUntil = Date.now() + 3500;
        clearTimeout(on.sendingTimer);
        on.sendingTimer = setTimeout(() => on.game?.pending && moveStatus('sending'), 220);
        socket.send({ t: 'move', uci });
      },
    },
    onResign: async () => {
      if (on.spectator) return;
      if (await confirmModal('¿Rendirte?', 'Se contará como derrota.', 'Rendirme', 'Seguir')) socket.send({ t: 'resign' });
    },
    onLeave: () => leaveGame(),
    onEnd: (summary) => finishOnline(summary),
    ui: {
      hint: false,
      undo: false,
      resign: !on.spectator,
      draw: !on.spectator && !s.circuit,
      emotes: !on.spectator,
      clocks: !!s.clocks,
      meName: net.user?.name ?? 'Tú',
      meSub: on.spectator ? 'Espectador' : `${on.pc === 'w' ? 'Blancas' : 'Negras'}`,
    },
  });
  on.game = game;
  $('#emoteBar').innerHTML = EMOTES.map((t, i) => `<button data-emote="${i}" title="${esc(t)}">${esc(t)}</button>`).join('');
  startClockTicker();
}

function handleState(s) {
  on.last = s;
  if (!on.game || on.code !== s.code || app.game !== on.game) openGame(s);
  const g = on.game;

  // 1) Sincroniza las jugadas con el servidor.
  const local = g.chess.history().length;
  if (s.moves.length > local) {
    if (s.moves.length - local <= 2) for (let i = local; i < s.moves.length; i += 1) g.applyRemote(s.moves[i]);
    else g.loadMoves(s.moves);
    on.pendingUntil = 0;
    clearTimeout(on.sendingTimer);
    g.confirmMove(); // el estado del servidor ya incluye mi jugada
    moveStatus(null);
  } else if (s.moves.length < local) {
    if (Date.now() >= on.pendingUntil) g.loadMoves(s.moves); // jugada rechazada: volver al estado del servidor
  } else {
    on.pendingUntil = 0;
    if (g.chess.fen().split(' ')[0] !== s.fen.split(' ')[0]) g.loadMoves(s.moves);
    else if (g.pending) {
      // El servidor aceptó mi jugada: la última jugada pasa a «confirmada» y, si se llegó a mostrar «Enviando…», se confirma.
      const sending = !$('#moveStatus').hidden;
      clearTimeout(on.sendingTimer);
      g.confirmMove();
      moveStatus(sending ? 'ok' : null);
    }
  }

  // 2) Interfaz: jugadores, relojes, ofertas, espera.
  const oppRole = on.pc === 'w' ? 'b' : 'w';
  const opp = s.players[oppRole];
  const me = s.players[on.pc];
  const oi = oppInfo(opp);
  $('#oppName').textContent = oi.name;
  $('#oppTitle').textContent = `${oi.title}${opp && !opp.online ? ' · desconectado' : ''}`;
  $('#oppAvatar').style.setProperty('--c', oi.color);
  $('#oppAvatar').textContent = GLYPH[oi.glyph] + VS;
  // Menú del rival (añadir amigo / reportar / bloquear): solo con rivales humanos.
  const menu = $('#oppMenuBtn');
  const human = !!opp && !opp.id.startsWith('bot-') && !on.spectator;
  menu.hidden = !(flags.social && human);
  if (human) Object.assign(menu.dataset, { id: opp.id, name: opp.name });
  if (on.spectator) $('#meName').textContent = s.players.w?.name ?? 'Blancas';
  if (me) $('#meSub').textContent = `${on.spectator ? 'Espectador' : on.pc === 'w' ? 'Blancas' : 'Negras'} · ${me.rating} pts`;
  setBanner(`<span>${s.circuit ? `🏆 ${esc(s.circuit.tournament ?? 'Royale Circuit')} · ${esc(s.circuit.label)}` : `🌐 ${s.rated ? 'Clasificatoria' : 'Partida con amigo'}`} · ${esc(tcLabel(s.tc))}</span>
    ${on.spectator ? `<span>👀 Espectador · solo lectura${s.delayMs ? ` · ⏱ retraso de ${Math.round(s.delayMs / 1000)} s` : ''}</span>` : ''}${s.circuit && on.spectator ? `<button class="link-btn" data-open-tournament="${esc(s.circuit.id)}">Ver torneo</button>` : ''}
    ${s.spectators ? `<span>👀 ${s.spectators}</span>` : ''}`);
  on.clock = s.clocks ? { ...s.clocks, at: Date.now() } : null;
  // Conexión del rival: cuenta atrás de desconexión (la calcula el servidor) y aviso al volver.
  const wasDc = !!on.oppDcUntil;
  on.oppDcUntil = opp && !opp.online && opp.dcLeft > 0 && s.status === 'playing' ? Date.now() + opp.dcLeft : 0;
  if (wasDc && !on.oppDcUntil && s.status === 'playing' && !on.spectator) feedback('reconnected', { text: 'Tu rival ha vuelto' });
  paintBanner();

  $('#waitOverlay').hidden = s.status !== 'waiting' || on.spectator;
  if (s.status === 'waiting') {
    $('#waitLink').value = linkFor(s.code);
    $('#waitCode').textContent = s.code;
  }
  $('#drawPrompt').hidden = !(s.drawOffer && s.drawOffer !== s.you && s.status === 'playing' && !on.spectator);
  $('#drawBtn').disabled = s.drawOffer === s.you;
  $('#drawBtn').textContent = s.drawOffer === s.you ? '🤝 Oferta enviada' : '🤝 Tablas';

  // 3) Fin de partida y revancha.
  if (s.status === 'over' && !on.ended) {
    on.ended = true;
    const w = s.result.winner;
    const reason = s.result.reason[0].toUpperCase() + s.result.reason.slice(1);
    if (on.spectator) {
      const name = w ? s.players[w]?.name : null;
      toast(w ? `🏁 Gana ${name} (${s.result.reason})` : `🏁 Tablas (${s.result.reason})`, 5000);
      g.finish('draw', reason);
    } else {
      g.finish(w === null ? 'draw' : w === s.you ? 'win' : 'loss', reason);
    }
  }
  if (on.wantRematch && s.rematchCode) {
    on.wantRematch = false;
    on.game = null;
    socket.send({ t: 'join', code: s.rematchCode });
  }
}

function startClockTicker() {
  clearInterval(on.clockTimer);
  on.clockTimer = setInterval(() => {
    const g = on.game;
    if (!g || app.game !== g) return clearInterval(on.clockTimer);
    const c = on.clock;
    if (!c) return;
    const now = Date.now();
    const rem = (color) => c[color] - (c.running === color ? now - c.at : 0);
    const live = on.last?.status === 'playing';
    const paint = (el, color) => {
      const ms = rem(color);
      el.textContent = fmtClock(ms);
      el.classList.toggle('warn', ms < 30000 && ms >= 10000);
      el.classList.toggle('low', ms < 10000 && ms > 0);
      el.classList.toggle('running', c.running === color && live);
    };
    paint($('#meClock'), on.pc);
    paint($('#oppClock'), on.pc === 'w' ? 'b' : 'w');
    // Alerta de poco tiempo propio: borde del tablero, un clic por segundo en los últimos 10 s y aviso para lectores de pantalla.
    const mine = rem(on.pc);
    const mineRunning = c.running === on.pc && live && !on.spectator;
    const sec = mineRunning && mine > 0 ? Math.ceil(mine / 1000) : null;
    $('#boardFrame').classList.toggle('lowtime', mineRunning && mine < 10000 && mine > 0);
    if (sec !== on.lastTickSec) {
      on.lastTickSec = sec;
      if (sec !== null && sec <= 10 && prefs.lowTimeSound) {
        sfx.tick(sec <= 3);
        if (sec <= 3) buzz(10);
      }
      if (sec === 30 || sec === 10) g.announce(`Te quedan ${sec} segundos.`);
    }
    if (on.oppDcUntil) paintBanner();
  }, 200);
}

// Partida del Royale Circuit: sin recompensas sueltas ni revancha; el servidor lleva el cuadro y los premios.
async function finishCircuitGame(summary) {
  const game = on.game;
  if (summary.result === 'win') {
    celebrate();
    feedback('advance', { title: '¡Pasas de ronda!', text: on.last?.circuit?.label ? `Superaste: ${on.last.circuit.label}` : 'Sigues en el torneo' });
  } else {
    toast(summary.result === 'loss' ? 'Has caído en el Circuit' : '🤝 Tablas: se repite con los colores cambiados', 4500);
  }
  // Si en unos segundos llega otra partida del torneo (empate o siguiente ronda), el jugador ya está dentro de ella.
  await wait(4500);
  if (on.game !== game || app.screen !== 'game') return;
  leaveGame();
  await app.go('circuit');
}

async function finishOnline(summary) {
  const s = on.last;
  if (on.spectator) return;
  if (s?.circuit) return finishCircuitGame(summary);
  if (summary.reason === 'Abortada') {
    toast('Partida abortada: no cuenta para el ranking');
    await leaveToHub();
    return;
  }
  const rated = !!s?.rated;
  if (s?.unrated) {
    toast(s.unrated === 'pair' ? 'Esta partida no puntúa: ya jugasteis 3 clasificatorias en 24 h contra el mismo rival.' : 'Esta partida no puntúa: terminó demasiado pronto.', 5000);
  }
  const minMoves = summary.moves >= 6;
  const base = { win: 60, draw: 20, loss: 10 }[summary.result] * (rated ? 1.5 : 1);
  const rows = [];
  if (minMoves) {
    rows.push([{ win: 'Victoria online', draw: 'Tablas', loss: 'Consuelo' }[summary.result], Math.round(base)]);
    if (summary.result === 'win' && summary.checks) rows.push([`Jaques (${summary.checks})`, Math.min(25, summary.checks * 5)]);
  }
  const total = rows.reduce((t, r) => t + r[1], 0);

  const st = state.stats;
  st.games += 1;
  st.onlineGames += 1;
  if (summary.result === 'win') {
    st.wins += 1;
    st.onlineWins += 1;
  } else if (summary.result === 'draw') st.draws += 1;
  else st.losses += 1;
  st.checks += summary.checks;
  st.captures += summary.captures;
  st.promotions += summary.promotions;
  // Con el flag `wallet` el servidor calcula esta recompensa con la partida que vio; el cliente solo la anuncia.
  addCoins(total, { source: 'online', key: `game:${s.code}` });
  // La XP, las misiones y la temporada de las partidas online las concede el servidor (aviso por WebSocket: ver progress.js).
  save();
  if (total) sfx.coin();
  if (summary.result === 'win') celebrate();

  const delta = s?.ratingDelta ? s.ratingDelta[on.pc] : null;
  if (delta !== null && s.ratingDelta?.ratings) {
    net.user = { ...net.user, rating: s.ratingDelta.ratings[on.pc] };
  }
  const records = updateRecords({ result: summary.result, plies: summary.plies, checks: summary.checks, mate: /mate/i.test(summary.reason), rating: net.user?.rating ?? null });
  const lg = leagueOf(net.user?.rating ?? 1000);
  const oppName = s?.players[on.pc === 'w' ? 'b' : 'w']?.name ?? 'Rival';
  const titles = { win: '¡Victoria!', loss: 'Derrota', draw: 'Tablas' };
  const html = `<div class="result ${summary.result}">
    <p class="eyebrow">${esc(summary.reason)} · vs ${esc(oppName)}</p>
    <h2>${titles[summary.result]}</h2>
    ${delta !== null ? `<p class="rating-line ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} pts · ${net.user.rating} · Liga ${lg.name}</p>` : ''}
    ${rows.length ? `<ul class="rewards">${rows.map((r, i) => `<li style="--i:${i}"><span>${r[0]}</span><b>+${r[1]} 🪙</b></li>`).join('')}<li class="total" style="--i:${rows.length}"><span>Total</span><b>+${total} 🪙</b></li></ul>` : '<p class="muted">Partida muy corta: sin recompensas (mínimo 6 jugadas).</p>'}
    ${recordsHtml(records)}
    <p class="muted fine">La XP de la partida la concede el servidor: mira tu avance en Progresión.</p>
    <div class="modal-actions">
      <button class="btn primary" data-choice="rematch">Revancha</button>
      <button class="btn" data-choice="share">📤 Compartir</button>
      <button class="btn" data-choice="exit">Salir</button>
    </div></div>`;
  announceRecords(records);
  let pick = await choice(html, 'result-card');
  while (pick === 'share') {
    await shareGame({ game: on.game, summary, headline: titles[summary.result], sub: `vs ${oppName}`, online: true });
    pick = await choice(html, 'result-card');
  }
  if (pick === 'rematch') {
    on.wantRematch = true;
    socket.send({ t: 'rematch' });
    toast('Revancha propuesta: esperando a tu rival...', 4000);
    if (on.last?.rematchCode) handleState(on.last);
  } else {
    await leaveToHub();
  }
}

function leaveGame() {
  socket.send({ t: 'leave' });
  socket.room = null;
  clearInterval(on.clockTimer);
  on.game = null;
  on.code = null;
  on.wantRematch = false;
  history.replaceState(null, '', '/');
}

async function leaveToHub() {
  leaveGame();
  await app.go(flags.lobby ? 'lobby' : 'online');
}

// ---------- Eventos de la interfaz ----------
let wired = false;
export function initOnline() {
  if (wired) return;
  wired = true;

  socket.on('state', handleState);
  socket.on('queued', () => renderQueue());
  socket.on('matched', () => {
    on.queued = false;
    renderQueue();
    sfx.coin();
    toast('⚔️ ¡Rival encontrado!');
  });
  socket.on('error', (m) => {
    if (m.code === 'nogame') {
      toast(m.message);
      history.replaceState(null, '', '/');
      app.go(flags.lobby ? 'lobby' : 'online');
    } else if (m.message) {
      toast(m.message);
      if (on.game && on.game.pending) {
        // Jugada rechazada: el servidor reenvía el estado real justo después y el tablero vuelve a él.
        on.pendingUntil = 0;
        clearTimeout(on.sendingTimer);
        moveStatus('bad');
        sfx.error();
      }
    }
  });
  socket.on('emote', (m) => {
    const g = on.game;
    if (!g || app.game !== g) return;
    const role = m.from;
    const p = on.last?.players[role];
    g.say(p?.name ?? 'Jugador', EMOTES[m.id] ?? '...', GLYPH.k, g.findKing(role), role === on.pc ? 'me' : 'opp');
  });
  socket.on('connection', (c) => {
    const active = on.game && app.game === on.game && !on.ended;
    if (!c.open && active) {
      on.offline = true;
      paintBanner();
    } else if (c.open && on.offline) {
      on.offline = false;
      paintBanner();
      if (active) feedback('reconnected', { text: 'Conexión recuperada' });
    }
  });

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tc]');
    if (t && app.screen === 'online') {
      on.tc = t.dataset.tc;
      localStorage.setItem('gambito.tc', on.tc);
      renderHub();
      return;
    }
    const em = e.target.closest('[data-emote]');
    if (em) return socket.send({ t: 'emote', id: Number(em.dataset.emote) });
    const w = e.target.closest('[data-wait]');
    if (w) {
      const link = linkFor(on.code);
      if (w.dataset.wait === 'copy') toast((await copyText(link)) ? '🔗 Enlace copiado' : link, 3000);
      if (w.dataset.wait === 'share') {
        if (navigator.share) navigator.share({ title: 'CHECKPOINT', text: '¡Te reto a una partida de ajedrez en CHECKPOINT!', url: link }).catch(() => {});
        else toast((await copyText(link)) ? '🔗 Enlace copiado' : link, 3000);
      }
      if (w.dataset.wait === 'cancel') await leaveToHub();
    }
  });

  $('#friendColor').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    on.color = b.dataset.color;
    $$('#friendColor button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#queueBtn').addEventListener('click', startQueue);
  $('#queueCancel').addEventListener('click', cancelQueue);
  $('#createBtn').addEventListener('click', createFriendGame);
  $('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#joinCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = $('#joinCode').value.match(/\/g\/([A-Za-z0-9]{4,12})/);
    const final = m ? m[1].toUpperCase() : code;
    if (final.length < 4) return toast('Escribe el código o pega el enlace de la partida');
    joinRoom(final);
  });
  $('#drawBtn').addEventListener('click', () => socket.send({ t: 'draw', action: 'offer' }));
  $('#drawAccept').addEventListener('click', () => socket.send({ t: 'draw', action: 'accept' }));
  $('#drawDecline').addEventListener('click', () => socket.send({ t: 'draw', action: 'decline' }));
}

export const isOnlineGameActive = () => !!on.game && app.game === on.game;
