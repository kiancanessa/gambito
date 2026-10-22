// Controlador de una partida: tablero, reglas (chess.js), turnos de la IA y animaciones.
import { Chess } from '../vendor/chess.js';
import { GLYPH, PIECE_NAME, PIECE_VALUE, QUIPS } from './data.js';
import { feedback } from './feedback.js';
import { sfx, burst } from './fx.js';
import { prefs } from './prefs.js';

const FILES = 'abcdefgh';
const TEXT_VS = '︎'; // fuerza glifo de texto (no emoji) en ♟
const MIN_THINK_MS = 450;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Game {
  /**
   * @param {object} o
   * @param {object} o.els      { board, fxLayer, banner, quip, capOpp, capMe, moveList, thinking }
   * @param {Engine} o.engine
   * @param {object} o.ai       { skill, depth, movetime, blunder }
   * @param {'w'|'b'} o.playerColor
   * @param {object} o.opp      { name, check? } rival (frases opcionales)
   * @param {() => string} o.getFx          id del efecto de partículas equipado
   * @param {(color) => Promise<string>} o.askPromotion
   * @param {(summary) => void} o.onEnd
   */
  constructor(o) {
    this.o = o;
    this.els = o.els;
    this.pc = o.playerColor;
    this.chess = o.fen ? new Chess(o.fen) : new Chess();
    this.startFen = this.chess.fen();
    this.spectator = !!o.spectator;
    this.flipped = this.pc === 'b';
    this.selected = null;
    this.targets = [];
    this.lastMove = null;
    this.hintMove = null;
    this.over = false;
    this.busy = false; // true mientras la IA piensa o se resuelve una jugada
    this.token = 0; // invalida respuestas de la IA tras deshacer / rendirse
    this.usedUndo = false;
    this.quipTimer = null;
    this.bannerTimer = null;
    this.view = o.view || null; // vista 3D (Board3D); si es null se usa el tablero DOM
    this.cursor = null; // casilla del cursor de teclado
    this.pending = false; // mi última jugada está enviada pero el servidor aún no la ha confirmado
    this.dragSq = null;
    this.onBoardClick = (e) => {
      if (this.suppressClick) return;
      const sq = e.target.closest('[data-sq]')?.dataset.sq;
      if (sq) this.click(sq);
    };
    this.onKey = (e) => this.key(e);
    this.frame = this.els.board.parentElement;
    if (this.view) {
      this.view.setFlipped(this.flipped);
      this.view.onPick = (sq) => this.click(sq);
      this.view.onDragCheck = (sq) => this.canDrag(sq);
      this.view.onDragBegin = (sq) => this.beginDrag(sq);
      this.view.onDrop = (from, to) => this.dropOn(from, to);
    } else {
      this.els.board.addEventListener('click', this.onBoardClick);
      this.onDown2d = (e) => this.down2d(e);
      this.els.board.addEventListener('pointerdown', this.onDown2d);
    }
    // Teclado: el marco del tablero es enfocable; flechas mueven el cursor, Intro/Espacio eligen, Esc cancela.
    this.frame.tabIndex = 0;
    this.frame.setAttribute('role', 'application');
    this.frame.setAttribute('aria-label', 'Tablero de ajedrez. Usa las flechas para moverte, Intro para elegir pieza o destino y Escape para cancelar.');
    this.frame.addEventListener('keydown', this.onKey);
    this.onPointer = () => {
      this.kbd = false;
    };
    this.frame.addEventListener('pointerdown', this.onPointer, true);
  }

  start() {
    this.o.engine.newGame();
    this.render();
    this.updateSide();
    const o = this.o.opp;
    if (o?.start && this.view) {
      const oppKing = this.findKing(this.pc === 'w' ? 'b' : 'w');
      setTimeout(() => !this.destroyed && !this.over && this.say(o.name, o.start, GLYPH.k, oppKing, 'opp'), 1500);
    }
    if (this.chess.turn() !== this.pc && !this.o.remote && !this.o.scripted) this.engineTurn();
  }

  destroy() {
    this.destroyed = true;
    this.token += 1;
    this.over = true;
    this.o.engine.stop();
    this.els.board.removeEventListener('click', this.onBoardClick);
    this.els.board.removeEventListener('pointerdown', this.onDown2d);
    this.frame.removeEventListener('keydown', this.onKey);
    this.frame.removeEventListener('pointerdown', this.onPointer, true);
    this.frame.removeAttribute('tabindex');
    if (this.view) {
      this.view.onPick = null;
      this.view.onDragCheck = null;
      this.view.onDragBegin = null;
      this.view.onDrop = null;
    }
    clearTimeout(this.quipTimer);
    clearTimeout(this.bannerTimer);
    this.hideBubble();
  }

  // ---------- Interacción ----------
  get myTurn() {
    return !this.spectator && !this.over && !this.busy && this.chess.turn() === this.pc;
  }

  click(sq) {
    if (!this.myTurn) return;
    const piece = this.chess.get(sq);
    if (this.selected && this.targets.some((m) => m.to === sq)) {
      this.tryMove(this.selected, sq);
      return;
    }
    if (piece && piece.color === this.pc) {
      if (this.selected === sq) {
        this.deselect();
      } else {
        this.select(sq);
      }
    } else if (this.selected) {
      this.deselect();
    }
  }

  select(sq) {
    this.selected = sq;
    this.cursor = sq;
    this.targets = this.chess.moves({ square: sq, verbose: true });
    this.hintMove = null;
    sfx.select();
    this.render();
    const p = this.chess.get(sq);
    const dests = [...new Set(this.targets.map((m) => m.to))];
    this.announce(`${PIECE_NAME[p.type]} ${sq} seleccionado. ${dests.length ? `Destinos: ${dests.join(', ')}.` : 'No tiene movimientos legales.'}`);
  }

  deselect() {
    this.selected = null;
    this.targets = [];
    this.render();
    this.announce('Selección cancelada.');
  }

  // Texto para lectores de pantalla (región aria-live del tablero).
  announce(text) {
    if (this.els.live) this.els.live.textContent = text;
  }

  // ---------- Arrastrar y soltar ----------
  canDrag(sq) {
    const p = this.chess.get(sq);
    return !!p && p.color === this.pc && this.myTurn;
  }

  beginDrag(sq) {
    if (!this.canDrag(sq)) return;
    this.dragSq = sq;
    this.select(sq);
  }

  // Suelta la pieza sobre `to` (o fuera del tablero: null). Un destino ilegal no hace nada y deja la pieza elegida.
  dropOn(from, to) {
    this.dragSq = null;
    if (!to || to === from || this.selected !== from || !this.targets.some((m) => m.to === to)) {
      if (to && to !== from && this.selected === from) sfx.error();
      this.render();
      return;
    }
    this.tryMove(from, to);
  }

  // Tablero 2D: arrastre con eventos de puntero (ratón y táctil); se activa tras moverse más de 8 px.
  down2d(e) {
    if (!prefs.drag || (e.pointerType === 'mouse' && e.button !== 0) || !this.myTurn) return;
    const sqEl = e.target.closest('[data-sq]');
    const pieceEl = e.target.closest('.piece');
    if (!sqEl || !pieceEl || !this.canDrag(sqEl.dataset.sq)) return;
    const from = sqEl.dataset.sq;
    const start = { x: e.clientX, y: e.clientY };
    let ghost = null;
    const size = this.els.board.clientWidth / 8;
    const frameBox = () => this.els.fxLayer.getBoundingClientRect();
    const place = (ev) => {
      const b = frameBox();
      ghost.style.left = `${ev.clientX - b.left}px`;
      ghost.style.top = `${ev.clientY - b.top}px`;
    };
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) {
        ghost = pieceEl.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.cssText = `position:absolute;width:${size}px;height:${size}px;font-size:${size * 0.82}px;pointer-events:none;transform:translate(-50%,-55%);z-index:9;display:grid;place-items:center`;
        this.els.fxLayer.append(ghost);
        this.suppressClick = true;
        this.beginDrag(from);
        this.els.board.querySelector(`[data-sq="${from}"] .piece`)?.classList.add('drag-src');
      }
      if (ghost) place(ev);
    };
    const finish = (ev, cancel) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelFn);
      if (!ghost) return;
      ghost.remove();
      setTimeout(() => (this.suppressClick = false), 0);
      const under = cancel ? null : document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-sq]');
      this.dropOn(from, under?.dataset.sq ?? null);
    };
    const up = (ev) => finish(ev, false);
    const cancelFn = (ev) => finish(ev, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelFn);
  }

  // ---------- Teclado ----------
  key(e) {
    this.kbd = true;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (arrows[e.key]) {
      e.preventDefault();
      // Con las negras abajo, «arriba» en pantalla es hacia la fila 1.
      const [dx, dy] = arrows[e.key].map((v) => (this.flipped ? -v : v));
      const base = this.cursor ?? this.selected ?? (this.pc === 'w' ? 'e2' : 'e7');
      const f = Math.min(7, Math.max(0, FILES.indexOf(base[0]) + dx));
      const r = Math.min(8, Math.max(1, Number(base[1]) + dy));
      this.cursor = `${FILES[f]}${r}`;
      this.render();
      const p = this.chess.get(this.cursor);
      this.announce(`${this.cursor}, ${p ? `${PIECE_NAME[p.type]} ${p.color === 'w' ? 'blanco' : 'negro'}` : 'vacía'}${this.targets.some((m) => m.to === this.cursor) ? ', destino legal' : ''}`);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!this.cursor) this.cursor = this.pc === 'w' ? 'e2' : 'e7';
      this.click(this.cursor);
    } else if (e.key === 'Escape' && this.selected) {
      e.preventDefault();
      this.deselect();
    }
  }

  // El servidor confirmó mi jugada: la última jugada pasa de gris (pendiente) a amarillo (aceptada).
  confirmMove() {
    if (!this.pending) return;
    this.pending = false;
    this.render();
  }

  async tryMove(from, to) {
    const candidates = this.targets.filter((m) => m.to === to);
    let promotion;
    if (candidates.some((m) => m.promotion)) {
      this.busy = true;
      promotion = await this.o.askPromotion(this.pc);
      this.busy = false;
      if (this.over) return;
    }
    this.selected = null;
    this.targets = [];
    this.hintMove = null;
    this.cursor = to;
    this.play({ from, to, promotion });
  }

  // ---------- Jugar una jugada (jugador o IA) ----------
  play(move) {
    let result;
    try {
      result = this.chess.move(move);
    } catch {
      sfx.error();
      return null;
    }
    this.lastMove = { from: result.from, to: result.to };
    this.render(this.animationsFor(result), result);
    this.afterMove(result);
    return result;
  }

  animationsFor(m) {
    const list = [{ from: m.from, to: m.to }];
    if (m.isKingsideCastle() || m.isQueensideCastle()) {
      const rank = m.color === 'w' ? '1' : '8';
      list.push(m.isKingsideCastle() ? { from: `h${rank}`, to: `f${rank}` } : { from: `a${rank}`, to: `d${rank}` });
    }
    return list;
  }

  afterMove(m) {
    const c = this.chess;
    const mine = m.color === this.pc;
    const isMate = c.isCheckmate();
    const isCheck = c.inCheck();
    const fxId = this.o.getFx();
    // En 3D los efectos esperan a que la pieza llegue a su casilla.
    const d = this.view ? 420 : 0;
    const later = (fn, ms = d) => (ms ? setTimeout(() => !this.destroyed && fn(), ms) : fn());

    this.announce(`${mine ? 'Has jugado' : `${m.color === 'w' ? 'Blancas' : 'Negras'} juegan`} ${m.san}${isMate ? '. Jaque mate.' : isCheck ? '. Jaque.' : ''}`);
    if (m.captured) {
      feedback('capture', { text: `${PIECE_NAME[m.piece]} captura ${PIECE_NAME[m.captured]}`, ms: 1100 });
      later(() => {
        sfx.capture();
        const p = this.squareCenter(m.to);
        burst(this.els.fxLayer, p.x, p.y, fxId, 1);
      });
    } else {
      sfx.move();
    }
    if (m.promotion) {
      feedback('promotion', { pop: false });
      later(() => {
        sfx.promote();
        this.showBanner('¡CORONACIÓN!', 'gold');
        const p = this.squareCenter(m.to);
        burst(this.els.fxLayer, p.x, p.y, fxId, 2.2);
      }, d + 120);
    }
    if (isMate) {
      feedback('mate', { pop: false });
      const k = this.findKing(c.turn());
      later(() => {
        const p = this.squareCenter(k);
        burst(this.els.fxLayer, p.x, p.y, fxId, 3);
        this.showBanner('¡JAQUE MATE!', 'mate');
        this.view?.checkmate(k);
      }, d + 80);
    } else if (isCheck) {
      feedback('check', { pop: false });
      const k = this.findKing(c.turn());
      later(() => {
        sfx.check();
        this.showBanner('¡JAQUE!', 'check');
        this.shake();
        this.view?.checkShake(k);
      }, d + 40);
    }

    if (mine) this.maybeQuip(m, isCheck, isMate);
    else if (isCheck && !isMate && this.o.opp?.check && Math.random() < 0.6) this.say(this.o.opp.name, this.o.opp.check, GLYPH[m.piece], m.to, 'opp');

    this.updateSide();
    // Modos sin IA local: tutorial guiado y partidas online (el servidor decide el resultado).
    if (this.o.scripted) {
      if (mine) this.o.scripted(m, this);
      return;
    }
    if (this.o.remote) {
      if (mine && !this.spectator) {
        this.pending = true;
        this.o.remote.send(m.from + m.to + (m.promotion || ''));
        this.render();
      }
      return;
    }
    if (this.checkEnd()) return;
    if (this.o.limitMoves && mine) {
      const used = c.history({ verbose: true }).filter((h) => h.color === this.pc).length;
      if (used >= this.o.limitMoves) {
        this.finish('loss', 'Sin mate a tiempo');
        return;
      }
    }
    if (c.turn() !== this.pc) this.engineTurn();
  }

  // ---------- Carga externa (online, tutorial, resincronización) ----------
  applyRemote(uci) {
    return this.play({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }

  // Reconstruye la partida desde la posición inicial con la lista de jugadas UCI (sin animar).
  loadMoves(ucis) {
    this.chess = new Chess(this.startFen);
    for (const u of ucis) this.chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    const last = ucis.at(-1);
    this.lastMove = last ? { from: last.slice(0, 2), to: last.slice(2, 4) } : null;
    this.selected = null;
    this.targets = [];
    this.hintMove = null;
    this.pending = false;
    this.render();
    this.updateSide();
  }

  loadFen(fen) {
    this.chess = new Chess(fen);
    this.startFen = this.chess.fen();
    this.selected = null;
    this.targets = [];
    this.lastMove = null;
    this.hintMove = null;
    this.render();
    this.updateSide();
  }

  undoLast() {
    this.chess.undo();
    const h = this.chess.history({ verbose: true }).at(-1);
    this.lastMove = h ? { from: h.from, to: h.to } : null;
    this.selected = null;
    this.targets = [];
    this.render();
    this.updateSide();
  }

  // ---------- IA ----------
  async engineTurn() {
    if (this.over) return;
    const token = ++this.token;
    this.busy = true;
    this.o.onThinking?.(true);
    this.render();

    const moves = this.chess.moves({ verbose: true });
    let chosen = null;

    if (moves.length) {
      const { ai } = this.o;
      const blunder = Math.random() < (ai.blunder || 0);
      const [uci] = await Promise.all([
        blunder ? null : this.o.engine.bestMove(this.chess.fen(), ai),
        wait(MIN_THINK_MS),
      ]);
      if (token !== this.token || this.over) return; // cancelada (deshacer, rendirse...)
      if (blunder) {
        chosen = pick(moves);
      } else if (uci) {
        chosen = moves.find((m) => m.from === uci.slice(0, 2) && m.to === uci.slice(2, 4) && (m.promotion || '') === (uci[4] || ''));
      }
      chosen ??= this.fallbackMove(moves);
    }

    this.busy = false;
    this.o.onThinking?.(false);
    if (chosen) this.play({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
  }

  // Si Stockfish falla: captura más valiosa o jugada al azar.
  fallbackMove(moves) {
    const caps = moves.filter((m) => m.captured).sort((a, b) => PIECE_VALUE[b.captured] - PIECE_VALUE[a.captured]);
    return caps[0] || pick(moves);
  }

  async hint() {
    if (!this.myTurn) return false;
    this.busy = true;
    const uci = await this.o.engine.bestMove(this.chess.fen(), { skill: 20, depth: 12, movetime: 700 });
    this.busy = false;
    if (!uci || this.over) return false;
    this.hintMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    this.selected = null;
    this.targets = [];
    this.render();
    return true;
  }

  undo() {
    if (this.over || !this.chess.history().length) return false;
    this.token += 1;
    this.o.engine.stop();
    this.busy = false;
    this.o.onThinking?.(false);
    const lastColor = () => this.chess.history({ verbose: true }).at(-1)?.color;
    if (lastColor() && lastColor() !== this.pc) this.chess.undo();
    if (lastColor() === this.pc) this.chess.undo();
    this.usedUndo = true;
    this.selected = null;
    this.targets = [];
    this.hintMove = null;
    const h = this.chess.history({ verbose: true }).at(-1);
    this.lastMove = h ? { from: h.from, to: h.to } : null;
    this.render();
    this.updateSide();
    if (this.chess.turn() !== this.pc) this.engineTurn();
    return true;
  }

  resign() {
    if (this.over) return;
    this.finish('loss', 'Te rendiste');
  }

  // ---------- Fin de partida ----------
  checkEnd() {
    const c = this.chess;
    if (c.isCheckmate()) {
      const winner = c.turn() === 'w' ? 'b' : 'w';
      this.finish(winner === this.pc ? 'win' : 'loss', 'Jaque mate');
    } else if (c.isStalemate()) this.finish('draw', 'Rey ahogado');
    else if (c.isInsufficientMaterial()) this.finish('draw', 'Material insuficiente');
    else if (c.isThreefoldRepetition()) this.finish('draw', 'Triple repetición');
    else if (c.isDraw()) this.finish('draw', 'Regla de las 50 jugadas');
    else return false;
    return true;
  }

  finish(result, reason) {
    if (this.over) return;
    this.over = true;
    this.token += 1;
    this.o.engine.stop();
    this.o.onThinking?.(false);
    this.render();
    if (result === 'win') sfx.win();
    else if (result === 'loss') sfx.lose();
    const hist = this.chess.history({ verbose: true });
    const mine = hist.filter((m) => m.color === this.pc);
    const theirs = hist.filter((m) => m.color !== this.pc);
    const summary = {
      result,
      reason,
      moves: mine.length,
      checks: mine.filter((m) => /[+#]/.test(m.san)).length,
      captures: mine.filter((m) => m.captured).length,
      promotions: mine.filter((m) => m.promotion).length,
      lost: theirs.filter((m) => m.captured).length,
      usedUndo: this.usedUndo,
      plies: hist.length,
      uci: hist.map((m) => m.from + m.to + (m.promotion || '')),
      startFen: this.startFen,
    };
    setTimeout(() => this.o.onEnd(summary), result === 'win' || reason === 'Jaque mate' ? 1400 : 700);
  }

  // ---------- Render ----------
  findKing(color) {
    for (const row of this.chess.board()) {
      for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
    }
    return null;
  }

  coords(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = Number(sq[1]) - 1;
    return { col: this.flipped ? 7 - f : f, row: this.flipped ? r : 7 - r };
  }

  squareCenter(sq) {
    if (this.view) return this.view.project(sq);
    const size = this.els.board.clientWidth / 8;
    const { col, row } = this.coords(sq);
    return { x: (col + 0.5) * size, y: (row + 0.5) * size };
  }

  render(anims = [], move = null) {
    const c = this.chess;
    const checkSq = c.inCheck() ? this.findKing(c.turn()) : null;
    if (this.view) {
      this.view.update({
        chess: c,
        selected: this.selected,
        targets: prefs.showLegal ? this.targets : [],
        lastMove: prefs.showLast ? this.lastMove : null,
        hintMove: this.hintMove,
        checkSq,
        move,
        interactive: !this.over && !this.busy && c.turn() === this.pc,
        cursor: this.focusedCursor(),
        pending: this.pending,
      });
      return;
    }
    const board = this.els.board;
    const targetMap = new Map((prefs.showLegal ? this.targets : []).map((m) => [m.to, m]));
    const cursor = this.focusedCursor();
    let html = '';
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const file = this.flipped ? 7 - col : col;
        const rank = this.flipped ? row : 7 - row;
        const sq = `${FILES[file]}${rank + 1}`;
        const p = c.get(sq);
        const dark = (file + rank) % 2 === 0;
        const cls = ['sq', dark ? 'dark' : 'light'];
        if (this.selected === sq) cls.push('selected');
        if (prefs.showLast && this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) cls.push(this.pending ? 'last-pending' : 'last');
        if (cursor === sq) cls.push('cursor');
        if (checkSq === sq) cls.push('check');
        if (this.hintMove && (this.hintMove.from === sq || this.hintMove.to === sq)) cls.push('hint');
        if (targetMap.has(sq)) cls.push(p ? 'target-cap' : 'target');
        const label = p ? `${sq}, ${PIECE_NAME[p.type]} ${p.color === 'w' ? 'blanco' : 'negro'}` : sq;
        const filelabel = row === 7 ? `<span class="coord f">${FILES[file]}</span>` : '';
        const ranklabel = col === 0 ? `<span class="coord r">${rank + 1}</span>` : '';
        const piece = p ? `<span class="piece ${p.color} t-${p.type}">${GLYPH[p.type]}${TEXT_VS}</span>` : '';
        html += `<div class="${cls.join(' ')}" data-sq="${sq}" role="gridcell" aria-label="${label}">${filelabel}${ranklabel}${piece}</div>`;
      }
    }
    board.innerHTML = html;
    board.classList.toggle('locked', this.over || this.busy || c.turn() !== this.pc);

    const size = board.clientWidth / 8;
    for (const a of anims) {
      const el = board.querySelector(`[data-sq="${a.to}"] .piece`);
      if (!el) continue;
      const from = this.coords(a.from);
      const to = this.coords(a.to);
      el.style.zIndex = 5;
      el.animate(
        [{ transform: `translate(${(from.col - to.col) * size}px, ${(from.row - to.row) * size}px) scale(1.12)` }, { transform: 'translate(0,0) scale(1)' }],
        { duration: 240, easing: 'cubic-bezier(.3,.7,.3,1)' },
      );
    }
  }

  // El cursor de teclado solo se pinta mientras el tablero tiene el foco (no estorba a quien juega con ratón o dedo).
  focusedCursor() {
    return this.kbd && this.cursor && this.frame === document.activeElement ? this.cursor : null;
  }

  updateSide() {
    this.o.onTurn?.(!this.over && this.chess.turn() === this.pc);
    const hist = this.chess.history({ verbose: true });
    const group = (list) => {
      const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
      return [...list].sort((a, b) => order[a.captured] - order[b.captured]);
    };
    const tray = (moves, color) => {
      const caps = group(moves.filter((m) => m.captured));
      const value = caps.reduce((s, m) => s + PIECE_VALUE[m.captured], 0);
      return { html: caps.map((m) => `<span class="piece mini ${color} t-${m.captured}">${GLYPH[m.captured]}${TEXT_VS}</span>`).join(''), value };
    };
    const opp = this.pc === 'w' ? 'b' : 'w';
    const mine = tray(hist.filter((m) => m.color === this.pc), opp); // piezas del rival que capturé
    const theirs = tray(hist.filter((m) => m.color !== this.pc), this.pc); // mis piezas capturadas
    const diff = mine.value - theirs.value;
    this.els.capMe.innerHTML = mine.html + (diff > 0 ? `<em>+${diff}</em>` : '');
    this.els.capOpp.innerHTML = theirs.html + (diff < 0 ? `<em>+${-diff}</em>` : '');

    // Lista de jugadas (en una repetición la dibuja el visor, con la lista completa y la jugada actual marcada)
    if (this.els.moveList.classList.contains('rp-moves')) return;
    const sans = hist.map((m) => m.san);
    let out = '';
    for (let i = 0; i < sans.length; i += 2) {
      out += `<span class="mv"><i>${i / 2 + 1}.</i> ${sans[i]} ${sans[i + 1] ?? ''}</span>`;
    }
    this.els.moveList.innerHTML = out || '<span class="muted">Sin jugadas todavía</span>';
    this.els.moveList.scrollTop = this.els.moveList.scrollHeight;
  }

  // ---------- Narrativa y efectos ----------
  maybeQuip(m, isCheck, isMate) {
    const lines = QUIPS[m.piece];
    if (!lines) return;
    let event = 'move';
    if (m.promotion) event = 'promote';
    else if (m.isKingsideCastle() || m.isQueensideCastle()) event = 'castle';
    else if (isCheck) event = 'check';
    else if (m.captured) event = 'capture';
    const chance = { promote: 1, castle: 1, check: 0.85, capture: 0.55, move: 0.07 }[event];
    if (isMate || !lines[event] || Math.random() > chance) return;
    this.say(PIECE_NAME[m.piece], pick(lines[event]), GLYPH[m.piece], m.to, 'me');
  }

  // Un mensaje sale de una pieza concreta: globo de diálogo anclado a ella en el tablero 3D.
  say(who, text, glyph = '', anchorSq = null, tone = 'me') {
    const obj = this.view && this.els.bubble && anchorSq ? this.view.pieces.get(anchorSq) : null;
    if (obj) {
      clearTimeout(this.quipTimer);
      this.quipTimer = setTimeout(() => {
        if (this.destroyed) return;
        const b = this.els.bubble;
        b.innerHTML = `<b class="who">${glyph ? `<i>${glyph}${TEXT_VS}</i>` : ''}${esc(who)}</b><span>${esc(text)}</span>`;
        b.className = `bubble ${tone}`;
        b.hidden = false;
        this.bubbleObj = obj;
        if (!this.bubbleHook) this.bubbleHook = () => this.placeBubble();
        this.view.addHook(this.bubbleHook);
        this.placeBubble();
        this.view.talk(obj);
        this.quipTimer = setTimeout(() => this.hideBubble(), 3400 + text.length * 45);
      }, 520); // espera a que la pieza llegue a su casilla
      return;
    }
    const el = this.els.quip;
    el.innerHTML = `${glyph ? `<span class="q-ico">${glyph}${TEXT_VS}</span>` : ''}<b>${esc(who)}:</b> ${esc(text)}`;
    el.hidden = false;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    clearTimeout(this.quipTimer);
    this.quipTimer = setTimeout(() => (el.hidden = true), 4800);
  }

  placeBubble() {
    const b = this.els.bubble;
    if (!b || b.hidden || !this.bubbleObj) return;
    const p = this.view.projectObj(this.bubbleObj);
    const W = b.parentElement.clientWidth;
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const half = bw / 2 + 8;
    const x = Math.min(Math.max(p.x, half), W - half);
    const y = Math.max(p.y, bh + 24);
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.style.setProperty('--tail', `${Math.max(-bw / 2 + 20, Math.min(bw / 2 - 20, p.x - x))}px`);
  }

  hideBubble() {
    if (this.bubbleHook) this.view?.removeHook(this.bubbleHook);
    if (this.els.bubble) this.els.bubble.hidden = true;
    this.bubbleObj = null;
  }

  showBanner(text, kind) {
    const b = this.els.banner;
    b.textContent = text;
    b.className = `banner ${kind}`;
    b.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => (b.hidden = true), kind === 'mate' ? 1800 : 1000);
  }

  shake() {
    const f = this.els.board.parentElement;
    f.classList.remove('shake');
    void f.offsetWidth;
    f.classList.add('shake');
  }
}
