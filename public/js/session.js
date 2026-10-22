// Prepara la pantalla de partida y crea el controlador `Game` para cualquier modo
// (campaña, rápida, online, desafío diario, tutorial).
import { GLYPH, PIECE_NAME } from './data.js';
import { Game } from './game.js';
import { state } from './store.js';
import { stopDemo } from './stage.js';
import { $, app, choice, esc, showScreen, toast, VS } from './ui.js';

export async function askPromotion(color) {
  const pieces = ['q', 'r', 'b', 'n'];
  const html = `<h3>¡Corona a tu peón!</h3><div class="promo">${pieces
    .map((p) => `<button class="promo-btn" data-choice="${p}" aria-label="${PIECE_NAME[p]}"><span class="piece ${color} t-${p}">${GLYPH[p]}${VS}</span><small>${PIECE_NAME[p]}</small></button>`)
    .join('')}</div>`;
  return choice(html, `promo-card set-${state.equipped.set}`);
}

/**
 * @param {object} cfg
 * @param {object} cfg.opp           { name, title, glyph, color, check?, start?, win?, lose? }
 * @param {'w'|'b'} cfg.playerColor
 * @param {string} [cfg.fen]         posición inicial (desafío diario, tutorial)
 * @param {object} [cfg.ai]          { skill, depth, movetime, blunder }
 * @param {object} [cfg.remote]      { send(uci) } → partida online
 * @param {boolean} [cfg.spectator]
 * @param {number} [cfg.limitMoves]  máximo de jugadas propias (mates del desafío diario)
 * @param {Function} [cfg.scripted]  callback del tutorial
 * @param {Function} cfg.onEnd
 * @param {object} [cfg.ui]          { banner, meSub, hint, undo, resign, resignLabel, draw, emotes, clocks }
 */
export function startSession(cfg) {
  app.game?.destroy();
  app.resignHandler = cfg.onResign ?? null;
  app.leaveHook = cfg.onLeave ?? null;
  stopDemo();
  showScreen('game');
  // El tablero competitivo es 2D (#board); la escena 3D ya no se usa en las partidas.
  $('#boardCol').classList.remove('is3d');

  const ui = { banner: null, meSub: cfg.playerColor === 'w' ? 'Blancas' : 'Negras', hint: true, undo: true, resign: true, resignLabel: '🏳 Rendirse', draw: false, emotes: false, clocks: false, ...cfg.ui };
  $('#oppAvatar').style.setProperty('--c', cfg.opp.color);
  $('#oppAvatar').textContent = GLYPH[cfg.opp.glyph] + VS;
  $('#oppName').textContent = cfg.opp.name;
  $('#oppTitle').textContent = cfg.opp.title ?? '';
  $('#meName').textContent = ui.meName ?? 'Tú';
  $('#meSub').textContent = ui.meSub;
  $('#quip').hidden = true;
  $('#banner').hidden = true;
  $('#bubble').hidden = true;
  $('#hintBtn').hidden = !ui.hint;
  $('#hintBtn').disabled = false;
  $('#undoBtn').hidden = !ui.undo;
  $('#resignBtn').hidden = !ui.resign;
  $('#resignBtn').textContent = ui.resignLabel;
  $('#drawBtn').hidden = !ui.draw;
  $('#emoteBar').hidden = !ui.emotes;
  $('#replayBar').hidden = true;
  $('#oppClock').hidden = !ui.clocks;
  $('#meClock').hidden = !ui.clocks;
  $('#drawPrompt').hidden = true;
  $('#waitOverlay').hidden = true;
  $('#meCard').classList.remove('active');
  $('#oppCard').classList.remove('active');
  setBanner(ui.banner);

  const game = new Game({
    els: {
      board: $('#board'), fxLayer: $('#fxLayer'), banner: $('#banner'), quip: $('#quip'), bubble: $('#bubble'),
      capOpp: $('#capOpp'), capMe: $('#capMe'), moveList: $('#moveList'), live: $('#boardLive'),
    },
    engine: app.engine,
    ai: cfg.ai,
    playerColor: cfg.playerColor,
    fen: cfg.fen,
    opp: cfg.opp,
    remote: cfg.remote,
    spectator: cfg.spectator,
    limitMoves: cfg.limitMoves,
    scripted: cfg.scripted,
    view: null,
    onTurn: (mine) => {
      $('#meCard').classList.toggle('active', mine);
      $('#oppCard').classList.toggle('active', !mine && !app.game?.over);
    },
    getFx: () => state.equipped.fx,
    askPromotion,
    onThinking: (on) => ($('#thinking').hidden = !on),
    onEnd: cfg.onEnd,
  });
  app.game = game;
  game.start();
  if (cfg.ai && app.engine?.failed) toast('Stockfish no disponible: la IA jugará en modo simple.');
  return game;
}

// Franja informativa sobre el tablero (modo, objetivo del puzzle, instrucciones del tutorial...).
export function setBanner(html) {
  const el = $('#modeBanner');
  el.hidden = !html;
  el.innerHTML = html ?? '';
}

export const safeName = esc;
