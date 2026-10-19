// Escena 3D compartida (inicio ↔ partida), partida de demostración y miniaturas de la tienda.
import { Chess } from '../vendor/chess.js';
import { Board3D, webglSupported } from './board3d.js';
import { sfx } from './fx.js';
import { state } from './store.js';
import { $, app } from './ui.js';

export let stage = null;
let demoTimer = null;
let thumbStage = null;
const thumbCache = new Map();

// Preferencia del usuario (Ajustes → Tablero 2D).
const prefers2d = () => {
  try {
    return localStorage.getItem('checkpoint.2d') === '1';
  } catch {
    return false;
  }
};

export function initStage() {
  // `?2d` fuerza el tablero 2D de respaldo (útil para probarlo o en equipos sin GPU).
  if (new URLSearchParams(location.search).has('2d') || prefers2d() || !webglSupported()) return null;
  try {
    stage = new Board3D();
    app.stage = stage;
  } catch (err) {
    console.warn('WebGL no disponible, se usa el tablero 2D:', err);
  }
  return stage;
}

// Partida de demostración (la "Ópera" de Morphy) que se reproduce sola en el inicio.
const DEMO = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' ');

export function stopDemo() {
  clearTimeout(demoTimer);
  demoTimer = null;
}

function startDemo() {
  stopDemo();
  if (!stage) return;
  const chess = new Chess();
  let i = 0;
  stage.setPosition(chess);
  stage.highlight({});
  const step = () => {
    if (app.screen !== 'home') return;
    if (i >= DEMO.length) {
      demoTimer = setTimeout(() => {
        chess.reset();
        i = 0;
        stage.setPosition(chess);
        stage.highlight({});
        demoTimer = setTimeout(step, 1200);
      }, 3500);
      return;
    }
    const move = chess.move(DEMO[i]);
    i += 1;
    stage.update({ chess, move, lastMove: { from: move.from, to: move.to }, interactive: false });
    if (move.captured) sfx.capture();
    else sfx.move();
    if (chess.isCheckmate()) {
      const king = chess.board().flat().find((p) => p && p.type === 'k' && p.color === chess.turn());
      setTimeout(() => stage.checkmate(king.square), 650);
    }
    demoTimer = setTimeout(step, 1500);
  };
  demoTimer = setTimeout(step, 1600);
}

export function mountHome() {
  if (!stage) return;
  stage.mount($('#heroStage'));
  stage.setFlipped(false);
  stage.setMode('showcase');
  startDemo();
}

export function mountGame() {
  stage.mount($('#stage3d'));
  stage.setMode('play');
}

// Miniaturas 3D para la tienda.
const THUMB_FEN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 5';
export function thumbFor(kind, id) {
  if (!stage) return null;
  const other = kind === 'set' ? state.equipped.board : state.equipped.set;
  const key = `${kind}:${id}:${other}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  try {
    if (!thumbStage) {
      thumbStage = new Board3D({ thumb: true });
      thumbStage.setPosition(new Chess(THUMB_FEN));
    }
    thumbStage.setSkins(kind === 'set' ? { set: id, board: other } : { set: other, board: id });
    const url = thumbStage.snapshot(440, 300);
    thumbCache.set(key, url);
    return url;
  } catch (err) {
    console.warn('No se pudo generar la miniatura 3D:', err);
    thumbCache.set(key, null);
    return null;
  }
}
