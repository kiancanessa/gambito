// Arranque y navegación: Academia (pruebas finales), partida rápida contra la IA, tienda, recompensas y enlaces a los demás modos.
import {
  CAMPAIGN, DAILY_REWARDS, GLYPH, QUICK_LEVELS,
} from './data.js';
import { enterDaily, initDaily } from './daily.js';
import { Engine } from './engine.js';
import { sfx } from './fx.js';
import { bootstrap, net, onNet } from './net.js';
import { enterHub, initOnline, isOnlineGameActive, joinFromLink } from './online.js';
import { initProfile, refreshIdentity } from './profile.js';
import { startSession } from './session.js';
import { shareGame } from './share.js';
import { initStage, stage, stopDemo } from './stage.js';
import {
  addCoins, addXp, claimDaily, dailyAvailable, onChange, resetAll, save, state,
} from './store.js';
import { flags } from './flags.js';
import { enterLobby, initLobby } from './lobby.js';
import { enterCircuit, initCircuit } from './circuit.js';
import { applyFlair, enterProgress, initProgress } from './progress.js';
import { enterAcademy, initAcademy } from './academy.js';
import { announceRecords, recordsHtml, updateRecords } from './records.js';
import { initShell } from './shell.js';
import { enterHistory, initHistory } from './history.js';
import { enterProfile } from './profile.js';
import { enterRanking, initRanking } from './ranking.js';
import { enterSettings, initSettings } from './settings.js';
import { enterSocial, initSocial } from './social.js';
import { initWallet } from './wallet.js';
import { initTutorial, startTutorial } from './tutorial.js';
import {
  $, $$, app, avatar, celebrate, choice, confirmModal, esc, showScreen, stars as starsHtml, toast, VS,
} from './ui.js';

const engine = new Engine();
const quick = { level: 3, color: 'w' };

initStage();
app.engine = engine;

// ---------- Aspecto ----------
// Las skins equipadas se aplican solo a la pantalla de juego (no al <body>), para que las
// vistas previas de la tienda lleven su propia clase sin competir con la equipada.
function applySkins() {
  const el = $('#screen-game');
  el.className = el.className.replace(/\b(set|board)-\S+/g, '').trim();
  el.classList.add(`set-${state.equipped.set}`, `board-${state.equipped.board}`);
  stage?.setSkins({ set: state.equipped.set, board: state.equipped.board });
  stage?.setCosmetics?.({ crown: state.equipped.crown });
}
app.applySkins = applySkins;

let lastCoins = state.coins;
function updateHud() {
  if (state.coins !== lastCoins) {
    const chip = $('#coinChip');
    chip.classList.remove('bump');
    void chip.offsetWidth;
    chip.classList.add('bump');
    lastCoins = state.coins;
  }
  $('#hudCoins').textContent = state.coins;
  $('#hudLevel').textContent = state.level;
  $('#profileRating').textContent = net.user ? `${net.user.rating} pts` : '—';
  applyFlair();
  refreshIdentity();
  $('#shopCoins').textContent = state.coins;
  $('#muteBtn').classList.toggle('is-muted', state.muted);
  $('#muteBtn').setAttribute('aria-pressed', String(state.muted));
}

// Inicio: centro de highlights (se carga a demanda para no pesar en el arranque).
async function refreshHome() {
  updateHud();
  (await import('./highlights.js')).enterHighlights();
}
app.refreshHome = refreshHome;

// ---------- Navegación ----------
async function go(name) {
  const g = app.game;
  if (app.screen === 'game' && g && name !== 'game') {
    if (!g.over) {
      const online = isOnlineGameActive();
      const ok = await confirmModal(
        '¿Abandonar la partida?',
        online ? 'Si sales y no vuelves en 45 segundos, perderás la partida.' : 'Perderás el progreso de esta partida.',
        'Abandonar',
        'Seguir jugando',
      );
      if (!ok) return;
    }
    app.leaveHook?.();
    app.leaveHook = null;
    app.resignHandler = null;
    g.destroy();
    app.game = null;
  }
  if (name !== 'home') stopDemo();
  if (name === 'online') {
    await enterHub();
    return;
  }
  if (name === 'lobby') {
    await enterLobby();
    return;
  }
  if (name === 'circuit') {
    await enterCircuit();
    return;
  }
  if (name === 'social') {
    await enterSocial();
    return;
  }
  if (name === 'ranking') {
    await enterRanking();
    return;
  }
  if (name === 'academy') {
    enterAcademy();
    return;
  }
  if (name === 'watch') {
    await (await import('./watch.js')).enterWatch(); // carga diferida
    return;
  }
  if (name === 'progress' || name === 'missions' || name === 'season') {
    await enterProgress(name === 'progress' ? null : name);
    return;
  }
  if (name === 'profile') {
    await enterProfile();
    return;
  }
  if (name === 'history') {
    await enterHistory();
    return;
  }
  if (name === 'settings') {
    enterSettings();
    return;
  }
  if (name === 'daily') {
    await enterDaily();
    return;
  }
  showScreen(name);
  if (name === 'home') {
    refreshHome();
    history.replaceState(null, '', '/');
  }
  if (name === 'quick') renderQuick();
  if (name === 'shop') {
    const m = await import('./customize.js'); // carga diferida: solo pesa cuando se abre
    await m.enterCustomize();
  }
}
app.go = go;
app.openUser = async (id) => (await import('./userprofile.js')).enterUser(id);
document.addEventListener('click', (e) => {
  const u = e.target.closest('[data-user]');
  if (u) app.openUser(u.dataset.user);
  const t = e.target.closest('[data-open-tournament]');
  if (t) app.openCircuit?.(t.dataset.openTournament);
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
});

// ---------- Pruebas finales de la Academia: los cinco rivales (antes, la campaña) ----------
function startTrial(i) {
  const n = CAMPAIGN[i];
  beginGame({
    mode: 'trial', index: i, playerColor: 'w',
    ai: { skill: n.skill, depth: n.depth, movetime: n.movetime, blunder: n.blunder },
    opp: { name: n.name, title: n.title, glyph: n.glyph, color: n.color, check: n.check, start: n.start, win: n.win, lose: n.lose },
    reward: i < state.campaign.cleared ? Math.round(n.reward / 2) : n.reward,
    intro: n.intro.filter(([who]) => who !== 'narrator'), // el relato de «Escaquia» ya no existe; los rivales y sus frases, sí
  });
}

// ---------- Partida rápida ----------
const QUICK_GLYPHS = ['p', 'p', 'n', 'b', 'r', 'q'];
const QUICK_COLORS = ['#8bc34a', '#ffb74d', '#4dd0e1', '#ef5350', '#ba68c8', '#ffd54f'];

function renderQuick() {
  $('#quickLevels').innerHTML = QUICK_LEVELS.map((l, i) => `
    <button class="level-card ${l.id === quick.level ? 'on' : ''}" data-level="${l.id}">
      ${avatar(QUICK_GLYPHS[i], QUICK_COLORS[i])}
      <b>${l.name}</b><small>Premio base 🪙 ${Math.round(50 * l.mult)}</small>
    </button>`).join('');
  $$('#quickColor button').forEach((b) => b.classList.toggle('on', b.dataset.color === quick.color));
}

$('#quickLevels').addEventListener('click', (e) => {
  const b = e.target.closest('[data-level]');
  if (!b) return;
  quick.level = Number(b.dataset.level);
  renderQuick();
});
$('#quickColor').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  quick.color = b.dataset.color;
  renderQuick();
});
// Partida rápida contra la IA (también la usa el lobby).
function startQuick(levelId, colorPref) {
  const i = QUICK_LEVELS.findIndex((l) => l.id === levelId);
  const l = QUICK_LEVELS[i];
  const color = colorPref === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : colorPref;
  beginGame({
    mode: 'quick', playerColor: color,
    ai: { skill: l.skill, depth: l.depth, movetime: l.movetime, blunder: l.blunder },
    opp: { name: `Rival ${l.name}`, title: `Nivel ${l.id} de ${QUICK_LEVELS.length}`, glyph: QUICK_GLYPHS[i], color: QUICK_COLORS[i] },
    reward: Math.round(50 * l.mult),
  });
}
app.startQuick = startQuick;
$('#quickStart').addEventListener('click', () => startQuick(quick.level, quick.color));

// ---------- Partida contra la IA ----------
function dialogueHtml(who, text) {
  const char = CAMPAIGN.find((c) => c.id === who);
  const head = who === 'narrator'
    ? `<div class="avatar" style="--c:#7e6cff">📜</div><b>Narrador</b>`
    : `${avatar(char.glyph, char.color)}<b>${char.name}</b>`;
  return `<div class="dialogue"><div class="speaker">${head}</div><p>${text}</p>
    <div class="modal-actions"><button class="btn primary" data-choice="next">Continuar</button></div></div>`;
}

async function beginGame(cfg) {
  for (const [who, text] of cfg.intro || []) await choice(dialogueHtml(who, text), 'story');
  startSession({
    opp: cfg.opp,
    playerColor: cfg.playerColor,
    ai: cfg.ai,
    onEnd: (summary) => finishGame(cfg, summary),
    ui: { hint: true, undo: true },
  });
}
app.beginGame = beginGame;
app.startTrial = startTrial;

// ---------- Recompensas y resultado ----------
function computeRewards(cfg, s) {
  const rows = [];
  if (s.result === 'win') {
    rows.push(['Victoria', cfg.reward]);
    if (s.checks) rows.push([`Jaques (${s.checks})`, Math.min(25, s.checks * 5)]);
    if (s.promotions) rows.push([`Coronación${s.promotions > 1 ? 'es' : ''}`, Math.min(30, s.promotions * 15)]);
    if (s.lost === 0 && !s.usedUndo) rows.push(['Partida impecable', 40]);
  } else if (s.result === 'draw') {
    rows.push(['Tablas', Math.round(cfg.reward * 0.25)]);
  } else {
    rows.push(['Consuelo', 5]);
  }
  return rows;
}

async function finishGame(cfg, s) {
  const rows = computeRewards(cfg, s);
  const total = rows.reduce((t, r) => t + r[1], 0);

  const st = state.stats;
  st.games += 1;
  if (s.result === 'win') st.wins += 1;
  else if (s.result === 'draw') st.draws += 1;
  else st.losses += 1;
  st.checks += s.checks;
  st.captures += s.captures;
  st.promotions += s.promotions;

  let starsEarned = 0;
  if (s.result === 'win') {
    const clean = !s.usedUndo;
    starsEarned = 1 + (clean && s.lost <= 2 ? 1 : 0) + (clean && s.lost === 0 ? 1 : 0);
    if (cfg.mode === 'trial') {
      const id = CAMPAIGN[cfg.index].id;
      state.campaign.stars[id] = Math.max(state.campaign.stars[id] || 0, starsEarned);
    }
  }
  let firstClear = false;
  let chapterDone = false;
  if (cfg.mode === 'trial' && s.result === 'win' && cfg.index === state.campaign.cleared) {
    state.campaign.cleared += 1;
    firstClear = true;
    chapterDone = state.campaign.cleared >= CAMPAIGN.length;
  }
  const records = updateRecords({ result: s.result, plies: s.plies, checks: s.checks, mate: /mate/i.test(s.reason) });
  addCoins(total, { source: 'game' });
  // Práctica contra la IA: el servidor no la ve, así que da poca XP y con tope diario (la XP de verdad viene de las partidas online).
  const levelUps = addXp(Math.min(30, Math.max(5, Math.round(total / 3))), { source: 'game' });
  save();
  if (total) sfx.coin();
  if (s.result === 'win') celebrate();

  const titles = { win: '¡Victoria!', loss: 'Derrota', draw: 'Tablas' };
  const quote = s.result === 'win' ? cfg.opp.win : s.result === 'loss' ? cfg.opp.lose : '';
  const buttons = [];
  if (firstClear && !chapterDone) buttons.push(['next', 'Siguiente rival ▶', 'primary']);
  buttons.push(['again', s.result === 'win' ? 'Jugar otra vez' : 'Revancha', buttons.length ? '' : 'primary']);
  buttons.push(['share', '📤 Compartir', '']);
  buttons.push(['menu', cfg.mode === 'trial' ? 'Academia' : 'Menú', '']);

  const html = `<div class="result ${s.result}">
    <p class="eyebrow">${esc(s.reason)}</p>
    <h2>${titles[s.result]}</h2>
    ${s.result === 'win' ? `<p class="stars-earned">${starsHtml(starsEarned)}</p>` : ''}
    ${quote ? `<blockquote><b>${esc(cfg.opp.name)}:</b> “${esc(quote)}”</blockquote>` : ''}
    <ul class="rewards">${rows.map((r, i) => `<li style="--i:${i}"><span>${r[0]}</span><b>+${r[1]} 🪙</b></li>`).join('')}
      <li class="total" style="--i:${rows.length}"><span>Total</span><b>+${total} 🪙</b></li></ul>
    ${recordsHtml(records)}
    ${levelUps ? `<p class="levelup">⭐ ¡Subiste al nivel ${state.level}!</p>` : ''}
    ${firstClear && !chapterDone ? `<p class="levelup">🎓 Prueba superada: nuevo rival desbloqueado</p>` : ''}
    <div class="modal-actions">${buttons.map(([v, label, c]) => `<button class="btn ${c}" data-choice="${v}">${label}</button>`).join('')}</div>
  </div>`;
  announceRecords(records);
  let pick = await choice(html, 'result-card');
  while (pick === 'share') {
    await shareGame({ game: app.game, summary: s, headline: titles[s.result], sub: `vs ${cfg.opp.name}` });
    pick = await choice(html, 'result-card');
  }

  if (chapterDone) {
    await choice(
      `<div class="result win"><p class="eyebrow">Academia completada</p><h2>¡Te has graduado!</h2>
       <p>Has superado las cinco pruebas finales: ya juegas como un <b>Maestro</b>. Sigue subiendo de liga, juega el Royale Circuit o repite las pruebas para mejorar tus estrellas.</p>
       <div class="modal-actions"><button class="btn primary" data-choice="ok">Volver a la Academia</button></div></div>`,
      'result-card',
    );
  }

  if (pick === 'again') beginGame({ ...cfg, intro: null, reward: cfg.mode === 'trial' ? Math.round(CAMPAIGN[cfg.index].reward / 2) : cfg.reward });
  else if (pick === 'next') startTrial(cfg.index + 1);
  else go(cfg.mode === 'trial' ? 'academy' : 'home');
}

// ---------- Acciones de partida ----------
$('#hintBtn').addEventListener('click', async () => {
  const game = app.game;
  if (!game || !game.myTurn) return;
  if (state.coins < 10) {
    sfx.error();
    toast('Necesitas 10 oros para una pista.');
    return;
  }
  const btn = $('#hintBtn');
  btn.disabled = true;
  const ok = await game.hint();
  btn.disabled = false;
  if (ok) {
    addCoins(-10, { source: 'hint' });
    toast('💡 Pista: mira las casillas resaltadas');
  }
});
$('#undoBtn').addEventListener('click', () => {
  if (app.game?.undo()) toast('Jugada deshecha (pierdes el bono impecable)');
});
$('#resignBtn').addEventListener('click', async () => {
  if (app.resignHandler) return app.resignHandler();
  const g = app.game;
  if (!g || g.over) return;
  if (await confirmModal('¿Rendirte?', 'Cuenta como derrota.', 'Rendirme', 'Seguir')) g.resign();
});

// ---------- Recompensa de entrada diaria ----------
async function maybeLoginBonus() {
  if (!dailyAvailable()) return;
  const nextStreak = state.daily.streak + 1;
  const days = DAILY_REWARDS.map((r, i) => {
    const idx = ((nextStreak - 1) % DAILY_REWARDS.length);
    return `<li class="${i === idx ? 'today' : i < idx ? 'past' : ''}"><small>Día ${i + 1}</small><b>🪙 ${r}</b></li>`;
  }).join('');
  await choice(
    `<div class="result win"><p class="eyebrow">Recompensa diaria</p><h2>¡Bienvenido de vuelta!</h2>
     <ul class="days">${days}</ul>
     <div class="modal-actions"><button class="btn primary" data-choice="claim">Reclamar</button></div></div>`,
    'result-card',
  );
  const got = claimDaily();
  if (got) {
    sfx.coin();
    toast(`+${got.amount} 🪙 · racha de ${got.streak} día${got.streak > 1 ? 's' : ''} 🔥`);
  }
}

// Primera visita: invita al tutorial.
async function maybeTutorial() {
  if (state.tutorialDone || state.stats.games > 0) return;
  const r = await choice(
    `<div class="result win"><p class="eyebrow">Bienvenido a CHECKPOINT</p><h2>¿Primera vez?</h2>
     <p>Aprende a mover las piezas en un minuto y llévate <b>100 🪙</b> de regalo.</p>
     <div class="modal-actions"><button class="btn primary" data-choice="yes">🎓 Empezar tutorial</button><button class="btn" data-choice="no">Ya sé jugar</button></div></div>`,
    'result-card',
  );
  if (r === 'yes') startTutorial();
}

// ---------- Ajustes ----------
$('#muteBtn').addEventListener('click', () => {
  state.muted = !state.muted;
  save();
});
$('#resetBtn').addEventListener('click', async () => {
  if (await confirmModal('¿Reiniciar progreso?', 'Se borrarán oros, skins, progreso de la Academia y misiones (también en la nube).', 'Borrar todo', 'Cancelar')) {
    resetAll();
    applySkins();
    toast('Progreso reiniciado');
  }
});

// ---------- Arranque ----------
onChange(updateHud);
onNet(() => updateHud());
initOnline();
initDaily();
initProgress();
initTutorial();
initProfile();
initWallet();
initCircuit();
initSocial();
initLobby();
initShell();
initAcademy();
initRanking();
initHistory();
initSettings();
applySkins();
updateHud();
engine.init().then((ok) => {
  if (!ok) toast('Stockfish no se pudo cargar: la IA jugará en modo simple.');
});
window.addEventListener('resize', () => stage?.resize());

(async () => {
  // El enlace de partida (/g/CODIGO) se lee antes de ir al inicio, porque el inicio limpia la URL.
  const link = location.pathname.match(/^\/g\/([A-Za-z0-9]{4,12})$/);
  const shared = location.pathname.match(/^\/([utr])\/([\w-]{1,64})$/); // perfil, torneo o repetición compartidos
  const sharedPly = Number(new URLSearchParams(location.search).get('m')) || null; // jugada desde la que abrir una repetición
  await go('home');
  const online = await bootstrap();
  applySkins();
  updateHud();
  refreshHome();
  if (link) {
    if (online) joinFromLink(link[1]);
    else toast('No hay conexión con el servidor para unirte a esa partida');
    return;
  }
  if (shared && online) {
    if (shared[1] === 'u') await app.openUser(shared[2]);
    else if (shared[1] === 't') await app.openCircuit?.(shared[2]);
    else await (await import('./watch.js')).openPublicReplay(shared[2], sharedPly);
    return;
  }
  await maybeLoginBonus();
  maybeTutorial();
})();

// Registro del service worker (solo en producción: en desarrollo cacheaba archivos viejos).
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Hook de depuración para pruebas manuales en consola.
window.__gambito = { get game() { return app.game; }, state, engine, net, get stage() { return stage; }, app, share: () => import('./share.js') };
