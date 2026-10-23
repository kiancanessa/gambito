// Inicio como centro de highlights (se carga a demanda desde main.js):
//  · «Your best moves»: momentos de TUS partidas guardadas en el servidor, detectados con moments.js. Sin análisis solo cuentan los
//    hechos de las jugadas (mates, coronaciones); con el análisis de Stockfish (local, opcional) también sacrificios y errores aprovechados.
//  · «World-class moves»: partidas históricas verificadas (world-highlights.js).
// Nada se inventa: si no hay datos, se dice, y el usuario decide si analizar.
import { Chess } from '../vendor/chess.js';
import { PIECE_NAME } from './data.js';
import { api, net, onNet } from './net.js';
import { boardHtml, createPlayer, playerControls } from './miniboard.js';
import { tcName } from './replay.js';
import { $, app, esc, toast } from './ui.js';
import { WORLD_CATEGORIES, WORLD_HIGHLIGHTS } from './world-highlights.js';

// Qué momentos propios cuentan como «buena jugada» y quién la hizo (siempre el propio jugador).
const GOOD = new Set(['checkmate', 'brilliant', 'sacrifice', 'opportunity', 'promotion', 'turnaround']);
const MAX_GAMES = 8;
const RESULT = { win: 'Victoria', loss: 'Derrota', draw: 'Tablas' };
const date = (t) => new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });

const hs = { mine: null, mineState: 'idle', games: [], world: null, worldCat: 'all', worldIndex: 0, analyzing: false, wired: false };

const cachedAnalysis = (id) => {
  try {
    return !!localStorage.getItem(`gambito.analysis.v1.${id}`);
  } catch {
    return false;
  }
};

// ---------- Tus mejores jugadas ----------
// Una sola carga a la vez: el arranque, el inicio y los cambios de sesión pueden pedirla casi a la vez.
let inflight = null;
let loadedFor = null;
const loadMine = () => (inflight ??= doLoadMine().finally(() => (inflight = null)));

async function doLoadMine() {
  if (!net.user) {
    hs.mineState = net.booted ? 'offline' : 'loading';
    return renderMine();
  }
  loadedFor = net.user.id;
  hs.mineState = 'loading';
  renderMine();
  const list = await api(`/api/me/games?limit=${MAX_GAMES * 2}`);
  if (!list.ok) {
    hs.mineState = 'error';
    return renderMine();
  }
  hs.games = list.json.games.filter((g) => g.plies >= 4 && g.reason !== 'abortada').slice(0, MAX_GAMES);
  if (!hs.games.length) {
    hs.mine = [];
    hs.mineState = 'ready';
    return renderMine();
  }
  const { buildMoments } = await import('./analysis.js');
  const details = await Promise.all(hs.games.map((g) => api(`/api/games/${encodeURIComponent(g.id)}`)));
  const found = [];
  for (const res of details) {
    if (!res.ok) continue;
    const d = res.json.game;
    let analysis = null;
    try {
      const c = JSON.parse(localStorage.getItem(`gambito.analysis.v1.${d.id}`) ?? 'null');
      if (c?.v === 1 && c.evals?.length === d.moves.length + 1) analysis = c;
    } catch {
      /* sin caché: solo momentos de las jugadas */
    }
    const built = buildMoments(d.moves, { winner: d.winner, tournament: d.tournament }, analysis);
    for (const m of built.moments) {
      if (!GOOD.has(m.kind) || m.side !== d.you) continue;
      found.push({ ...m, game: d, plies: built.plies, analysed: !!analysis });
    }
  }
  found.sort((a, b) => b.score - a.score || b.game.createdAt - a.game.createdAt);
  const seen = new Set();
  hs.mine = found.filter((m) => (seen.has(`${m.game.id}:${m.ply}`) ? false : (seen.add(`${m.game.id}:${m.ply}`), true))).slice(0, 4);
  hs.analysedAny = found.some((m) => m.analysed) || details.some((r) => r.ok && cachedAnalysis(r.json.game.id));
  hs.mineState = 'ready';
  hs.loadedAt = Date.now();
  return renderMine();
}

function mineContext(m) {
  const d = m.game;
  const opp = d.you === 'w' ? d.black.name : d.white.name;
  const res = !d.winner ? 'draw' : d.winner === d.you ? 'win' : 'loss';
  return { opp, res, ctx: d.tournament ? `${d.tournament.name}${d.tournament.roundLabel ? ` · ${d.tournament.roundLabel}` : ''}` : d.rated ? `Clasificatoria · ${tcName(d.tc)}` : `Partida con amigo · ${tcName(d.tc)}` };
}

function renderMine() {
  const box = $('#hlMineBody');
  if (!box) return;
  const st = hs.mineState;
  if (st === 'loading' || st === 'idle') {
    box.innerHTML = '<div class="hl-skeleton" aria-busy="true"><span></span><span></span></div>';
    return;
  }
  if (st === 'offline' || st === 'error') {
    box.innerHTML = `<div class="hl-empty" role="status"><h3>${st === 'offline' ? 'Sin conexión' : 'No se pudieron cargar tus partidas'}</h3>
      <p>Tus jugadas destacadas salen de tus partidas online guardadas en el servidor.</p>
      <div class="hl-actions"><button class="btn" data-hl="retry">Reintentar</button></div></div>`;
    return;
  }
  if (!hs.mine.length) {
    const has = hs.games.length > 0;
    box.innerHTML = `<div class="hl-empty"><h3>Tu próxima gran jugada empieza aquí.</h3>
      <p>${has
        ? 'Todavía no hay jugadas destacadas verificadas en tus partidas. Los mates y las coronaciones aparecen solos; los sacrificios y los errores aprovechados necesitan el análisis de Stockfish.'
        : 'Juega una partida online: cuando termine, sus mejores momentos aparecerán aquí.'}</p>
      <div class="hl-actions">
        <button class="btn" data-go="lobby" data-play>Jugar una partida</button>
        ${has ? `<button class="btn" data-hl="analyze" ${hs.analyzing ? 'disabled aria-busy="true"' : ''}>${hs.analyzing ? 'Analizando…' : 'Analizar mi última partida'}</button><button class="btn ghost" data-go="history">Ver mis partidas</button>` : ''}
      </div></div>`;
    return;
  }
  const [top, ...rest] = hs.mine;
  box.innerHTML = `${featuredMine(top)}${rest.length ? `<ul class="hl-list">${rest.map(compactMine).join('')}</ul>` : ''}
    ${hs.analysedAny ? '' : `<p class="hl-note">Solo se muestran hechos de las jugadas. <button class="link-btn" data-hl="analyze" ${hs.analyzing ? 'disabled' : ''}>${hs.analyzing ? 'Analizando…' : 'Analiza tu última partida'}</button> para descubrir sacrificios y errores aprovechados.</p>`}`;
  mountPlayer($('#hlMineBody .hl-feature'), { sans: top.plies.map((p) => p.san), key: top.ply, flip: top.game.you === 'b', label: `Tu jugada ${top.plies[top.ply - 1].san}` });
}

function moveLine(m) {
  const p = m.plies[m.ply - 1];
  return `<b class="hl-san">${Math.ceil(m.ply / 2)}${m.ply % 2 ? '.' : '…'} ${esc(p.san)}</b><span class="hl-piece">${esc(PIECE_NAME[p.piece] ?? '')}</span>`;
}

function featuredMine(m) {
  const { opp, res, ctx } = mineContext(m);
  return `<article class="hl-feature" data-game="${esc(m.game.id)}" data-ply="${m.ply}">
    <div class="hl-board"><div data-mb="board"></div>${playerControls('Tu jugada')}</div>
    <div class="hl-copy">
      <p class="hl-kicker">${esc(m.title)}${m.source === 'engine' ? ' · confirmado por Stockfish' : ''}</p>
      <h3>${moveLine(m)}</h3>
      <p class="hl-idea">${esc(m.detail)}</p>
      <p class="hl-meta">vs ${esc(opp)} · ${RESULT[res]} · ${esc(ctx)} · ${date(m.game.createdAt)}</p>
      <div class="hl-notes" data-mb="notes" aria-label="Jugadas de la secuencia"></div>
      <div class="hl-actions"><button class="btn" data-hl="replay" data-id="${esc(m.game.id)}" data-ply="${m.ply}">Ver la partida completa</button></div>
    </div></article>`;
}

function compactMine(m) {
  const p = m.plies[m.ply - 1];
  const { opp, res } = mineContext(m);
  return `<li><button type="button" class="hl-item" data-hl="replay" data-id="${esc(m.game.id)}" data-ply="${m.ply}">
    <span class="hl-thumb">${boardHtml(p.after, { flip: m.game.you === 'b', mark: { from: p.from, to: p.to }, key: true, coords: false, label: `Posición tras ${p.san}` })}</span>
    <span class="hl-item-copy"><b>${esc(m.title)} · ${esc(p.san)}</b><small>vs ${esc(opp)} · ${RESULT[res]} · ${date(m.game.createdAt)}</small></span></button></li>`;
}

async function analyzeLatest() {
  if (hs.analyzing || !hs.games.length) return;
  hs.analyzing = true;
  renderMine();
  try {
    const g = hs.games[0];
    const res = await api(`/api/games/${encodeURIComponent(g.id)}`);
    if (!res.ok) throw new Error('partida');
    const { analyzeGame } = await import('./analysis.js');
    const out = await analyzeGame(res.json.game.id, res.json.game.moves);
    if (!out) throw new Error('motor');
    toast('🔍 Análisis listo');
  } catch {
    toast('No se pudo analizar la partida (sin conexión o sin motor)');
  } finally {
    hs.analyzing = false;
  }
  return loadMine();
}

// ---------- World-class moves ----------
function worldList() {
  return hs.worldCat === 'all' ? WORLD_HIGHLIGHTS : WORLD_HIGHLIGHTS.filter((h) => h.categories.includes(hs.worldCat));
}

// Las pestañas solo aparecen cuando de verdad separan contenido (al menos dos categorías con dos o más jugadas).
function worldTabs() {
  const counts = Object.keys(WORLD_CATEGORIES).map((c) => [c, WORLD_HIGHLIGHTS.filter((h) => h.categories.includes(c)).length]).filter(([, n]) => n >= 2);
  const distinct = counts.filter(([c]) => WORLD_HIGHLIGHTS.some((h) => !h.categories.includes(c)));
  if (distinct.length < 1) return '';
  return `<div class="seg hl-tabs" role="tablist" aria-label="Categorías">${[['all', 'Todas'], ...counts.map(([c]) => [c, WORLD_CATEGORIES[c]])]
    .map(([c, l]) => `<button role="tab" data-hl-cat="${c}" aria-selected="${hs.worldCat === c}" class="${hs.worldCat === c ? 'on' : ''}">${esc(l)}</button>`)
    .join('')}</div>`;
}

function renderWorld() {
  const box = $('#hlWorldBody');
  if (!box) return;
  const list = worldList();
  const top = list[hs.worldIndex] ?? list[0];
  const rest = list.filter((h) => h !== top);
  const sans = top.san.split(' ');
  box.innerHTML = `${worldTabs()}
    <article class="hl-feature" data-world="${esc(top.id)}">
      <div class="hl-board"><div data-mb="board"></div>${playerControls('Jugada clave')}</div>
      <div class="hl-copy">
        <p class="hl-kicker">${top.categories.map((c) => esc(WORLD_CATEGORIES[c])).join(' · ')}</p>
        <h3>${esc(top.title)}</h3>
        <p class="hl-players"><b>${esc(top.white)}</b> <span>vs</span> <b>${esc(top.black)}</b></p>
        <p class="hl-meta">${esc(top.event)} · ${top.year} · ${esc(top.result)}</p>
        <p class="hl-idea"><b class="hl-san">${Math.ceil(top.ply / 2)}${top.ply % 2 ? '.' : '…'} ${esc(sans[top.ply - 1])}</b> ${esc(top.idea)}</p>
        <div class="hl-notes" data-mb="notes" aria-label="Jugadas de la secuencia"></div>
        <p class="hl-eval" id="hlEval" aria-live="polite"></p>
        <div class="hl-actions">
          <button class="btn" data-hl="world-replay" data-id="${esc(top.id)}">Explorar la partida</button>
          <button class="btn" data-hl="practice" data-id="${esc(top.id)}">Practicar la posición</button>
          <button class="btn ghost" data-hl="eval" data-id="${esc(top.id)}">Evaluar con Stockfish</button>
        </div>
      </div></article>
    ${rest.length ? `<ul class="hl-list">${rest.map(compactWorld).join('')}</ul>` : ''}
    <p class="hl-note">Partidas históricas de dominio público. Las jugadas se comprueban con las reglas del ajedrez; la evaluación la calcula Stockfish en tu navegador cuando la pides.</p>`;
  const from = Math.max(0, top.ply - 6);
  mountPlayer(box.querySelector('.hl-feature'), { sans, key: top.ply, from, to: sans.length, label: `${top.white} contra ${top.black}, ${top.year}` });
}

function compactWorld(h) {
  const c = new Chess();
  const sans = h.san.split(' ');
  let last = null;
  sans.slice(0, h.ply).forEach((s) => (last = c.move(s)));
  return `<li><button type="button" class="hl-item" data-hl="world-pick" data-id="${esc(h.id)}">
    <span class="hl-thumb">${boardHtml(c.fen(), { mark: { from: last.from, to: last.to }, key: true, coords: false, label: `Posición tras ${last.san}` })}</span>
    <span class="hl-item-copy"><b>${esc(h.title)}</b><small>${esc(h.white)} vs ${esc(h.black)} · ${h.year}</small></span></button></li>`;
}

function mountPlayer(article, { sans, key, flip = false, from = null, to = null, label }) {
  if (!article) return;
  const start = from ?? Math.max(0, key - 4);
  const end = to ?? Math.min(sans.length, key + 1);
  article.player = createPlayer(article, { sans, from: start, to: end, key, flip, label });
}

// ---------- Acciones ----------
const worldById = (id) => WORLD_HIGHLIGHTS.find((h) => h.id === id);

function worldGameData(h) {
  const c = new Chess();
  const moves = h.san.split(' ').map((s) => {
    const m = c.move(s);
    return `${m.from}${m.to}${m.promotion ?? ''}`;
  });
  return {
    id: `world-${h.id}`,
    you: 'w',
    winner: h.result === '1-0' ? 'w' : h.result === '0-1' ? 'b' : null,
    reason: c.isCheckmate() ? 'jaque mate' : 'resultado histórico',
    rated: false,
    tc: 'none',
    createdAt: Date.UTC(h.year, 0, 1),
    moves,
    white: { name: h.white, rating: null },
    black: { name: h.black, rating: null },
    tournament: null,
    integrity: { ok: c.isCheckmate(), proof: 'moves' },
    historic: { event: h.event, year: h.year },
  };
}

async function evaluate(h) {
  const out = $('#hlEval');
  if (!out) return;
  out.textContent = 'Stockfish está evaluando la posición…';
  const { Engine } = await import('./engine.js');
  const { whiteCp } = await import('./moments.js');
  const engine = new Engine();
  try {
    const c = new Chess();
    const sans = h.san.split(' ');
    sans.slice(0, h.ply - 1).forEach((s) => c.move(s));
    const before = c.fen();
    const turn = c.turn();
    c.move(sans[h.ply - 1]);
    const after = c.fen();
    const v1 = await engine.evaluate(before, { depth: 16, movetime: 1200 });
    const v2 = c.isCheckmate() ? { mate: 0 } : await engine.evaluate(after, { depth: 16, movetime: 1200 });
    if (!v1 || !v2) throw new Error('motor');
    const fmt = (v, t) => {
      if (typeof v.mate === 'number') {
        const forWhite = (v.mate > 0) === (t === 'w');
        return v.mate === 0 ? 'mate' : `mate en ${Math.abs(v.mate)} para ${forWhite ? 'las blancas' : 'las negras'}`;
      }
      const cp = whiteCp(v, t) / 100;
      return `${cp > 0 ? '+' : ''}${cp.toFixed(1)} (${cp >= 0 ? 'blancas' : 'negras'})`;
    };
    const t2 = turn === 'w' ? 'b' : 'w';
    out.textContent = `Stockfish (profundidad ~16): antes de la jugada ${fmt(v1, turn)}; después ${fmt(v2, t2)}.`;
  } catch {
    out.textContent = 'No se pudo cargar el motor en este navegador.';
  } finally {
    engine.dispose();
  }
}

async function practice(h) {
  const { QUICK_LEVELS } = await import('./data.js');
  const { startSession } = await import('./session.js');
  const c = new Chess();
  const sans = h.san.split(' ');
  sans.slice(0, h.ply - 1).forEach((s) => c.move(s));
  const color = c.turn();
  const ai = QUICK_LEVELS.find((l) => l.id === 5);
  startSession({
    opp: { name: 'Stockfish', title: 'Práctica · nivel Experto', glyph: 'q', color: '#929baa' },
    playerColor: color,
    fen: c.fen(),
    ai: { skill: ai.skill, depth: ai.depth, movetime: ai.movetime, blunder: 0 },
    onEnd() {},
    ui: { banner: `<span>🎯 Practica: ${color === 'w' ? 'juegan las blancas' : 'juegan las negras'}. ¿Encuentras la idea de ${esc(h.white.split(' ').pop())}?</span>`, hint: true, undo: true, resign: true, resignLabel: 'Salir' },
  });
}

function wire() {
  if (hs.wired) return;
  hs.wired = true;
  $('#screen-home').addEventListener('click', async (e) => {
    const cat = e.target.closest('[data-hl-cat]');
    if (cat) {
      hs.worldCat = cat.dataset.hlCat;
      hs.worldIndex = 0;
      return renderWorld();
    }
    const b = e.target.closest('[data-hl]');
    if (!b) return undefined;
    const a = b.dataset.hl;
    if (a === 'retry') return loadMine();
    if (a === 'analyze') return analyzeLatest();
    if (a === 'replay') return (await import('./replay.js')).openReplay(b.dataset.id, { ply: Number(b.dataset.ply) || null });
    const h = worldById(b.dataset.id);
    if (!h) return undefined;
    if (a === 'world-pick') {
      hs.worldIndex = worldList().indexOf(h);
      renderWorld();
      return $('#hlWorld').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (a === 'world-replay') return (await import('./replay.js')).openReplayData(worldGameData(h), { publicGame: true, ply: h.ply });
    if (a === 'practice') return practice(h);
    if (a === 'eval') return evaluate(h);
    return undefined;
  });
  // Solo se recarga si cambia la cuenta (o se conecta); el resto de avisos de red no tocan los highlights.
  onNet(() => app.screen === 'home' && (net.user?.id ?? null) !== loadedFor && loadMine());
}

function renderHead() {
  const hello = $('#homeHello');
  if (hello) hello.textContent = net.user ? `Hola, ${net.user.name}` : 'Hola';
}

// La sección mundial se pinta cuando entra en pantalla: así el inicio no monta todos los tableros de golpe.
let worldObserver = null;
export function enterHighlights() {
  wire();
  renderHead();
  if (hs.mineState === 'ready' && net.user?.id === loadedFor && hs.loadedAt > Date.now() - 60_000) renderMine();
  else loadMine();
  if (hs.world) return renderWorld();
  const target = $('#hlWorld');
  if (!('IntersectionObserver' in window) || !target) {
    hs.world = true;
    return renderWorld();
  }
  worldObserver?.disconnect();
  worldObserver = new IntersectionObserver((entries) => {
    if (!entries.some((en) => en.isIntersecting)) return;
    worldObserver.disconnect();
    hs.world = true;
    renderWorld();
  }, { rootMargin: '200px' });
  worldObserver.observe(target);
  // Si el navegador no avisa (pestaña en segundo plano), no se deja la sección en el esqueleto para siempre.
  setTimeout(() => {
    if (hs.world || app.screen !== 'home') return;
    worldObserver.disconnect();
    hs.world = true;
    renderWorld();
  }, 3000);
  return undefined;
}
