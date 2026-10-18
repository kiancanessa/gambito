// Arranque y navegación: campaña, partida rápida contra la IA, tienda, recompensas y enlaces a los demás modos.
import {
  CAMPAIGN, CHAPTER, DAILY_REWARDS, GLYPH, QUICK_LEVELS, RARITY, SHOP, XP_PER_LEVEL,
} from './data.js';
import { dailyPending, enterDaily, initDaily } from './daily.js';
import { Engine } from './engine.js';
import { burst, sfx } from './fx.js';
import { renderMap } from './map.js';
import { claimableMissions, initMissions, renderMissions, track } from './missions.js';
import { bootstrap, net, onNet } from './net.js';
import { enterHub, initOnline, isOnlineGameActive, joinFromLink } from './online.js';
import { initProfile } from './profile.js';
import { claimableSeason, initSeason, renderSeason, addSeasonXp } from './season.js';
import { startSession } from './session.js';
import { shareGame } from './share.js';
import { initStage, mountHome, stage, stopDemo, thumbFor } from './stage.js';
import {
  addCoins, addXp, buy, claimDaily, dailyAvailable, equip, onChange, owns, resetAll, save, state,
} from './store.js';
import { initTutorial, startTutorial } from './tutorial.js';
import {
  $, $$, app, avatar, celebrate, choice, confirmModal, esc, showScreen, stars as starsHtml, toast, VS,
} from './ui.js';

const engine = new Engine();
let shopTab = 'sets';
const quick = { level: 3, color: 'w' };

initStage();
app.engine = engine;

// ---------- Aspecto ----------
function buildAmbient() {
  const glyphs = ['♔', '♕', '♖', '♗', '♘', '♙', '♚', '♛', '♜', '♝', '♞', '♟'];
  $('#ambient').innerHTML = Array.from({ length: 16 }, (_, i) => {
    const size = 24 + Math.random() * 56;
    return `<span style="left:${Math.random() * 100}%;font-size:${size}px;animation-duration:${18 + Math.random() * 26}s;animation-delay:${-Math.random() * 40}s;opacity:${0.05 + Math.random() * 0.08}">${glyphs[i % glyphs.length]}${VS}</span>`;
  }).join('');
}

// Las skins equipadas se aplican solo a la pantalla de juego (no al <body>), para que las
// vistas previas de la tienda lleven su propia clase sin competir con la equipada.
function applySkins() {
  const el = $('#screen-game');
  el.className = el.className.replace(/\b(set|board)-\S+/g, '').trim();
  el.classList.add(`set-${state.equipped.set}`, `board-${state.equipped.board}`);
  stage?.setSkins({ set: state.equipped.set, board: state.equipped.board });
}

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
  $('#hudStreak').textContent = state.daily.streak;
  $('#hudXp').style.width = `${Math.min(100, (state.xp / XP_PER_LEVEL(state.level)) * 100)}%`;
  $('#shopCoins').textContent = state.coins;
  $('#muteBtn').textContent = state.muted ? '🔇' : '🔊';
  const next = CAMPAIGN[Math.min(state.campaign.cleared, CAMPAIGN.length - 1)];
  $('#homeCampaignInfo').textContent =
    state.campaign.cleared >= CAMPAIGN.length
      ? `${CHAPTER.name.split('·')[1].trim()} · completado`
      : `${CHAPTER.name.split('·')[1].trim()} · próximo: ${next.name}`;
  const s = state.stats;
  $('#homeStats').textContent = `${s.games} partidas · ${s.wins} victorias · ${s.checks} jaques`;
}

async function refreshHome() {
  updateHud();
  const dot = (id, on) => ($(id).hidden = !on);
  dot('#missionsDot', claimableMissions() > 0);
  dot('#seasonDot', claimableSeason() > 0);
  const pending = await dailyPending();
  dot('#dailyDot', pending);
  $('#homeDailyInfo').textContent = state.dailyPuzzle.streak ? `🔥 Racha de ${state.dailyPuzzle.streak} día${state.dailyPuzzle.streak > 1 ? 's' : ''}` : 'Un mate nuevo cada día';
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
  if (name === 'daily') {
    await enterDaily();
    return;
  }
  showScreen(name);
  if (name === 'home') {
    mountHome();
    refreshHome();
    history.replaceState(null, '', '/');
  }
  if (name === 'campaign') renderCampaign();
  if (name === 'quick') renderQuick();
  if (name === 'shop') renderShop();
  if (name === 'missions') renderMissions();
  if (name === 'season') renderSeason();
}
app.go = go;

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
});

// ---------- Campaña: mapa interactivo ----------
let mapSel = 0;

function progressHtml() {
  const c = state.campaign.cleared;
  const total = CAMPAIGN.length;
  const got = Object.values(state.campaign.stars).reduce((a, b) => a + b, 0);
  const left = CAMPAIGN.slice(c).reduce((s, n) => s + n.reward, 0);
  const next = CAMPAIGN[c];
  return `<p class="eyebrow">Tu progreso</p>
    <div class="pips">${CAMPAIGN.map((n, i) => `<i class="${i < c ? 'on' : i === c ? 'now' : ''}" title="${n.name}"></i>`).join('')}</div>
    <p class="big-num"><b>${c}</b> / ${total} <small>rivales superados</small></p>
    <ul class="mini-stats">
      <li><span>★ Estrellas</span><b>${got} / ${total * 3}</b></li>
      <li><span>Victorias</span><b>${state.stats.wins}</b></li>
      <li><span>${c >= total ? 'Capítulo' : 'Oros por ganar'}</span><b>${c >= total ? '¡Completo!' : `🪙 ${left}`}</b></li>
    </ul>
    <p class="muted next-line">${next ? `Próximo: <b>${next.name}</b>` : 'Has liberado el Valle. El Bosque de Alfiles te espera.'}</p>`;
}

function nodeCardHtml(i) {
  const c = state.campaign.cleared;
  if (i >= CAMPAIGN.length) {
    return `<div class="nc-head"><div class="avatar" style="--c:#2d6a4f">🌲</div><div><b>${CHAPTER.next}</b><small>Nuevo reino</small></div></div>
      <p class="nc-quote">“Busca en el Bosque de Alfiles... antes de que olvides quién eres.”</p>
      <button class="btn" disabled>${c >= CAMPAIGN.length ? 'Próximamente' : 'Supera el Valle para llegar'}</button>`;
  }
  const n = CAMPAIGN[i];
  const status = i < c ? 'cleared' : i === c ? 'current' : 'locked';
  const reward = i < c ? Math.round(n.reward / 2) : n.reward;
  const best = state.campaign.stars[n.id] || 0;
  const chip = { cleared: '✓ Superado', current: '▶ Siguiente rival', locked: '🔒 Bloqueado' }[status];
  return `<div class="nc-head">${avatar(n.glyph, n.color)}<div><b>${n.name}</b><small>${n.title}</small></div></div>
    <span class="status-chip ${status}">${chip}</span>
    <p class="nc-quote">“${n.start}”</p>
    <ul class="mini-stats">
      <li><span>Dificultad</span><b class="diff">${'⚔'.repeat(i + 1)}<em>${'⚔'.repeat(CAMPAIGN.length - i - 1)}</em></b></li>
      <li><span>Recompensa${i < c ? ' (repetir)' : ''}</span><b>🪙 ${reward}</b></li>
      <li><span>Mejor resultado</span><b class="pstars">${best ? starsHtml(best) : '<em>Sin jugar</em>'}</b></li>
    </ul>
    <button class="btn ${status === 'locked' ? '' : 'primary'}" data-play="${i}" ${status === 'locked' ? 'disabled' : ''}>${status === 'cleared' ? 'Repetir' : status === 'current' ? 'Jugar' : 'Bloqueado'}</button>`;
}

function updateCampaignCards() {
  $('#progressCard').innerHTML = progressHtml();
  $('#nodeCard').innerHTML = nodeCardHtml(mapSel);
}

let mapCtl = null;
function renderCampaign() {
  $('#chapterName').textContent = CHAPTER.name;
  const cleared = state.campaign.cleared;
  const seen = Math.min(state.campaign.seen ?? 0, cleared);
  mapSel = Math.min(cleared, CAMPAIGN.length - 1);
  mapCtl?.destroy();
  mapCtl = renderMap($('#mapHost'), {
    cleared,
    stars: state.campaign.stars,
    selected: mapSel,
    animateFrom: seen !== cleared ? seen : null,
    onSelect: (i) => {
      mapSel = i;
      sfx.select();
      updateCampaignCards();
    },
    onPlay: (i) => i < CAMPAIGN.length && i <= state.campaign.cleared && startCampaign(i),
    onArrive: () => sfx.coin(),
  });
  state.campaign.seen = cleared;
  save();
  updateCampaignCards();
}

$('#nodeCard').addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (b) startCampaign(Number(b.dataset.play));
});

function startCampaign(i) {
  const n = CAMPAIGN[i];
  beginGame({
    mode: 'campaign', index: i, playerColor: 'w',
    ai: { skill: n.skill, depth: n.depth, movetime: n.movetime, blunder: n.blunder },
    opp: { name: n.name, title: n.title, glyph: n.glyph, color: n.color, check: n.check, start: n.start, win: n.win, lose: n.lose },
    reward: i < state.campaign.cleared ? Math.round(n.reward / 2) : n.reward,
    intro: n.intro,
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
$('#quickStart').addEventListener('click', () => {
  const i = QUICK_LEVELS.findIndex((l) => l.id === quick.level);
  const l = QUICK_LEVELS[i];
  const color = quick.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : quick.color;
  beginGame({
    mode: 'quick', playerColor: color,
    ai: { skill: l.skill, depth: l.depth, movetime: l.movetime, blunder: l.blunder },
    opp: { name: `Rival ${l.name}`, title: `Nivel ${l.id} de ${QUICK_LEVELS.length}`, glyph: QUICK_GLYPHS[i], color: QUICK_COLORS[i] },
    reward: Math.round(50 * l.mult),
  });
});

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
    if (cfg.mode === 'campaign') {
      const id = CAMPAIGN[cfg.index].id;
      state.campaign.stars[id] = Math.max(state.campaign.stars[id] || 0, starsEarned);
    }
  }
  let firstClear = false;
  let chapterDone = false;
  if (cfg.mode === 'campaign' && s.result === 'win' && cfg.index === state.campaign.cleared) {
    state.campaign.cleared += 1;
    firstClear = true;
    chapterDone = state.campaign.cleared >= CAMPAIGN.length;
  }
  addCoins(total);
  const levelUps = addXp(Math.max(10, total));
  // Misiones y temporada
  track('game');
  if (s.result === 'win') {
    track('win');
    if (s.lost === 0 && !s.usedUndo) track('perfect');
  }
  track('check', s.checks);
  track('capture', s.captures);
  track('promote', s.promotions);
  addSeasonXp(Math.max(15, Math.round(total / 2)));
  save();
  if (total) sfx.coin();
  if (s.result === 'win') celebrate();

  const titles = { win: '¡Victoria!', loss: 'Derrota', draw: 'Tablas' };
  const quote = s.result === 'win' ? cfg.opp.win : s.result === 'loss' ? cfg.opp.lose : '';
  const buttons = [];
  if (firstClear && !chapterDone) buttons.push(['next', 'Siguiente rival ▶', 'primary']);
  buttons.push(['again', s.result === 'win' ? 'Jugar otra vez' : 'Revancha', buttons.length ? '' : 'primary']);
  buttons.push(['share', '📤 Compartir', '']);
  buttons.push(['menu', cfg.mode === 'campaign' ? 'Mapa' : 'Menú', '']);

  const html = `<div class="result ${s.result}">
    <p class="eyebrow">${esc(s.reason)}</p>
    <h2>${titles[s.result]}</h2>
    ${s.result === 'win' ? `<p class="stars-earned">${starsHtml(starsEarned)}</p>` : ''}
    ${quote ? `<blockquote><b>${esc(cfg.opp.name)}:</b> “${esc(quote)}”</blockquote>` : ''}
    <ul class="rewards">${rows.map((r, i) => `<li style="--i:${i}"><span>${r[0]}</span><b>+${r[1]} 🪙</b></li>`).join('')}
      <li class="total" style="--i:${rows.length}"><span>Total</span><b>+${total} 🪙</b></li></ul>
    ${levelUps ? `<p class="levelup">⭐ ¡Subiste al nivel ${state.level}!</p>` : ''}
    ${firstClear && !chapterDone ? `<p class="levelup">🗺️ Nuevo rival desbloqueado</p>` : ''}
    <div class="modal-actions">${buttons.map(([v, label, c]) => `<button class="btn ${c}" data-choice="${v}">${label}</button>`).join('')}</div>
  </div>`;
  let pick = await choice(html, 'result-card');
  while (pick === 'share') {
    await shareGame({ game: app.game, summary: s, headline: titles[s.result], sub: `vs ${cfg.opp.name}` });
    pick = await choice(html, 'result-card');
  }

  if (chapterDone) {
    await choice(
      `<div class="result win"><p class="eyebrow">Fin del capítulo</p><h2>¡Valle de Peones superado!</h2>
       <p>El Regente Gris se desvanece entre la niebla. Su voz se queda en el aire: <i>“Busca en el Bosque de Alfiles... antes de que olvides quién eres”.</i></p>
       <p class="muted">${CHAPTER.next} llegará en la próxima versión.</p>
       <div class="modal-actions"><button class="btn primary" data-choice="ok">Volver al mapa</button></div></div>`,
      'result-card',
    );
  }

  if (pick === 'again') beginGame({ ...cfg, intro: null, reward: cfg.mode === 'campaign' ? Math.round(CAMPAIGN[cfg.index].reward / 2) : cfg.reward });
  else if (pick === 'next') startCampaign(cfg.index + 1);
  else go(cfg.mode === 'campaign' ? 'campaign' : 'home');
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
    addCoins(-10);
    toast('💡 Pista: mira las casillas resaltadas');
  }
});
$('#viewBtn').addEventListener('click', () => {
  if (stage) $('#viewLabel').textContent = stage.cyclePreset();
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

// ---------- Tienda ----------
const KIND = { sets: 'set', boards: 'board', fx: 'fx' };

function previewHtml(tab, item) {
  if (tab === 'sets' || tab === 'boards') {
    const url = thumbFor(tab === 'sets' ? 'set' : 'board', item.id);
    if (url) return `<img class="pv pv-img" alt="${item.name}" src="${url}">`;
  }
  if (tab === 'sets') {
    const sq = (cls, c, p) => `<div class="sq ${cls}"><span class="piece ${c} t-${p}">${GLYPH[p]}${VS}</span></div>`;
    return `<div class="pv pv-set set-${item.id} board-${state.equipped.board}">${sq('light', 'w', 'n')}${sq('dark', 'b', 'q')}${sq('dark', 'w', 'b')}${sq('light', 'b', 'r')}</div>`;
  }
  if (tab === 'boards') {
    return `<div class="pv pv-board board-${item.id} set-${state.equipped.set}">${['light', 'dark', 'dark', 'light', 'light', 'dark', 'dark', 'light', 'light']
      .map((c, i) => `<div class="sq ${c}">${i === 4 ? `<span class="piece w t-k">${GLYPH.k}${VS}</span>` : ''}</div>`).join('')}</div>`;
  }
  return `<div class="pv pv-fx" data-fx="${item.id}"><span class="try">✨ Probar</span><div class="fx-layer"></div></div>`;
}

function renderShop() {
  $$('#shopTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === shopTab));
  const kind = KIND[shopTab];
  $('#shopGrid').innerHTML = SHOP[shopTab].map((item) => {
    const own = owns(kind, item.id);
    const eq = state.equipped[kind] === item.id;
    const r = RARITY[item.rarity];
    const action = eq
      ? `<button class="btn" disabled>Equipado</button>`
      : own
        ? `<button class="btn primary" data-act="equip" data-id="${item.id}">Equipar</button>`
        : `<button class="btn buy ${state.coins < item.price ? 'cant' : ''}" data-act="buy" data-id="${item.id}">🪙 ${item.price}</button>`;
    return `<article class="shop-card ${eq ? 'equipped' : ''}" style="--r:${r.color}">
      ${previewHtml(shopTab, item)}
      <div class="shop-info"><b>${item.name}</b><span class="rarity">${r.label}</span></div>
      ${action}
    </article>`;
  }).join('');
}

$('#shopTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  shopTab = b.dataset.tab;
  renderShop();
});

$('#shopGrid').addEventListener('click', (e) => {
  const pv = e.target.closest('.pv-fx');
  if (pv) {
    const layer = $('.fx-layer', pv);
    const r = pv.getBoundingClientRect();
    burst(layer, r.width / 2, r.height / 2, pv.dataset.fx, 1.2);
    sfx.capture();
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const kind = KIND[shopTab];
  const item = SHOP[shopTab].find((i) => i.id === btn.dataset.id);
  if (btn.dataset.act === 'buy') {
    const res = buy(kind, item);
    if (!res.ok) {
      sfx.error();
      toast(res.reason === 'coins' ? `Te faltan ${item.price - state.coins} oros.` : 'Ya lo tienes.');
      return;
    }
    equip(kind, item.id);
    sfx.coin();
    toast(`¡${item.name} desbloqueado y equipado!`);
  } else {
    equip(kind, item.id);
    sfx.select();
  }
  applySkins();
  renderShop();
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
    `<div class="result win"><p class="eyebrow">Bienvenido a Gambito</p><h2>¿Primera vez?</h2>
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
  if (await confirmModal('¿Reiniciar progreso?', 'Se borrarán oros, skins, campaña y misiones (también en la nube).', 'Borrar todo', 'Cancelar')) {
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
initMissions();
initSeason();
initTutorial();
initProfile();
buildAmbient();
applySkins();
updateHud();
engine.init().then((ok) => {
  if (!ok) toast('Stockfish no se pudo cargar: la IA jugará en modo simple.');
});
window.addEventListener('resize', () => stage?.resize());

(async () => {
  // El enlace de partida (/g/CODIGO) se lee antes de ir al inicio, porque el inicio limpia la URL.
  const link = location.pathname.match(/^\/g\/([A-Za-z0-9]{4,12})$/);
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
  await maybeLoginBonus();
  maybeTutorial();
})();

// Registro del service worker (solo en producción: en desarrollo cacheaba archivos viejos).
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Hook de depuración para pruebas manuales en consola.
window.__gambito = { get game() { return app.game; }, state, engine, net, get stage() { return stage; }, app, share: () => import('./share.js') };
