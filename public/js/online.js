// Multijugador: partidas con amigos por enlace, emparejamiento clasificatorio, espectadores y emotes.
import { EMOTES, GLYPH, LEAGUES, TIME_CONTROLS, leagueOf } from './data.js';
import { sfx } from './fx.js';
import { track } from './missions.js';
import { flags } from './flags.js';
import { api, ensureOnline, net, refreshUser, socket } from './net.js';
import { addSeasonXp } from './season.js';
import { startSession, setBanner } from './session.js';
import { shareGame } from './share.js';
import { addCoins, addXp, save, state } from './store.js';
import { $, $$, app, avatar, celebrate, choice, confirmModal, copyText, esc, fmtClock, showScreen, toast, VS, wait } from './ui.js';

const on = {
  code: null,
  game: null,
  pc: 'w',
  spectator: false,
  last: null, // último estado recibido
  clock: null, // { w, b, running, at }
  pendingUntil: 0, // hasta cuándo se espera la confirmación del servidor de mi jugada
  ended: false,
  wantRematch: false,
  tc: localStorage.getItem('gambito.tc') || 'blitz5',
  color: 'r',
  queued: false,
  queueSince: 0,
  hubTimer: null,
  clockTimer: null,
};

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
  on.hubTimer = setInterval(() => (app.screen === 'online' ? refreshHubData() : clearInterval(on.hubTimer)), 15000);
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
      draw: !on.spectator,
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
  } else if (s.moves.length < local) {
    if (Date.now() >= on.pendingUntil) g.loadMoves(s.moves); // jugada rechazada: volver al estado del servidor
  } else {
    on.pendingUntil = 0;
    if (g.chess.fen().split(' ')[0] !== s.fen.split(' ')[0]) g.loadMoves(s.moves);
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
  if (on.spectator) $('#meName').textContent = s.players.w?.name ?? 'Blancas';
  if (me) $('#meSub').textContent = `${on.spectator ? 'Espectador' : on.pc === 'w' ? 'Blancas' : 'Negras'} · ${me.rating} pts`;
  setBanner(`<span>🌐 ${s.rated ? 'Clasificatoria' : 'Partida con amigo'} · ${esc(tcLabel(s.tc))}</span>
    ${s.spectators ? `<span>👀 ${s.spectators}</span>` : ''}${s.status === 'playing' && !s.clocks ? '' : ''}`);
  on.clock = s.clocks ? { ...s.clocks, at: Date.now() } : null;

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
    const paint = (el, color) => {
      const ms = rem(color);
      el.textContent = fmtClock(ms);
      el.classList.toggle('low', ms < 10000 && ms > 0);
      el.classList.toggle('running', c.running === color && on.last?.status === 'playing');
    };
    paint($('#meClock'), on.pc);
    paint($('#oppClock'), on.pc === 'w' ? 'b' : 'w');
  }, 200);
}

async function finishOnline(summary) {
  const s = on.last;
  if (on.spectator) return;
  if (summary.reason === 'Abortada') {
    toast('Partida abortada: no cuenta para el ranking');
    await leaveToHub();
    return;
  }
  const rated = !!s?.rated;
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
  addCoins(total);
  const levelUps = addXp(Math.max(10, total));
  if (minMoves) {
    track('game');
    track('online');
    if (summary.result === 'win') {
      track('win');
      track('onlinewin');
      if (summary.lost === 0) track('perfect');
    }
    track('check', summary.checks);
    track('capture', summary.captures);
    track('promote', summary.promotions);
    addSeasonXp(Math.max(20, total));
  }
  save();
  if (total) sfx.coin();
  if (summary.result === 'win') celebrate();

  const delta = s?.ratingDelta ? s.ratingDelta[on.pc] : null;
  if (delta !== null && s.ratingDelta?.ratings) {
    net.user = { ...net.user, rating: s.ratingDelta.ratings[on.pc] };
  }
  const lg = leagueOf(net.user?.rating ?? 1000);
  const oppName = s?.players[on.pc === 'w' ? 'b' : 'w']?.name ?? 'Rival';
  const titles = { win: '¡Victoria!', loss: 'Derrota', draw: 'Tablas' };
  const html = `<div class="result ${summary.result}">
    <p class="eyebrow">${esc(summary.reason)} · vs ${esc(oppName)}</p>
    <h2>${titles[summary.result]}</h2>
    ${delta !== null ? `<p class="rating-line ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} pts · ${net.user.rating} · Liga ${lg.name}</p>` : ''}
    ${rows.length ? `<ul class="rewards">${rows.map((r, i) => `<li style="--i:${i}"><span>${r[0]}</span><b>+${r[1]} 🪙</b></li>`).join('')}<li class="total" style="--i:${rows.length}"><span>Total</span><b>+${total} 🪙</b></li></ul>` : '<p class="muted">Partida muy corta: sin recompensas (mínimo 6 jugadas).</p>'}
    ${levelUps ? `<p class="levelup">⭐ ¡Subiste al nivel ${state.level}!</p>` : ''}
    <div class="modal-actions">
      <button class="btn primary" data-choice="rematch">Revancha</button>
      <button class="btn" data-choice="share">📤 Compartir</button>
      <button class="btn" data-choice="exit">Salir</button>
    </div></div>`;
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
    } else if (m.message) toast(m.message);
  });
  socket.on('emote', (m) => {
    const g = on.game;
    if (!g || app.game !== g) return;
    const role = m.from;
    const p = on.last?.players[role];
    g.say(p?.name ?? 'Jugador', EMOTES[m.id] ?? '...', GLYPH.k, g.findKing(role), role === on.pc ? 'me' : 'opp');
  });
  socket.on('connection', (c) => {
    if (!c.open && on.game && app.game === on.game && !on.ended) toast('Conexión perdida: reconectando…', 4000);
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
        if (navigator.share) navigator.share({ title: 'Gambito', text: '¡Te reto a una partida de ajedrez en Gambito!', url: link }).catch(() => {});
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
