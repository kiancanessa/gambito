// Envoltorio de Stockfish.js (WASM, un solo hilo) con protocolo UCI.
const ENGINE_URL = '/vendor/stockfish/stockfish-nnue-16-single.js';

export class Engine {
  constructor() {
    this.worker = null;
    this.ready = null;
    this.pending = null;
    this.failed = false;
  }

  init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      try {
        this.worker = new Worker(ENGINE_URL);
      } catch (err) {
        this.failed = true;
        console.warn('No se pudo iniciar Stockfish:', err);
        resolve(false);
        return;
      }
      let stage = 'uci';
      const timeout = setTimeout(() => {
        this.failed = true;
        console.warn('Stockfish no respondió a tiempo.');
        resolve(false);
      }, 15000);
      this.worker.onerror = (e) => {
        this.failed = true;
        console.warn('Error en Stockfish:', e.message || e);
        clearTimeout(timeout);
        resolve(false);
      };
      this.worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (stage === 'uci' && line === 'uciok') {
          stage = 'isready';
          this.send('setoption name Hash value 16');
          this.send('isready');
        } else if (stage === 'isready' && line === 'readyok') {
          stage = 'ready';
          clearTimeout(timeout);
          this.worker.onmessage = (ev) => this.onLine(typeof ev.data === 'string' ? ev.data : '');
          resolve(true);
        }
      };
      this.send('uci');
    });
    return this.ready;
  }

  send(cmd) {
    this.worker?.postMessage(cmd);
  }

  onLine(line) {
    if (!this.pending) return;
    if (this.pending.analysis && line.startsWith('info') && !/ (lower|upper)bound/.test(line)) {
      const m = line.match(/ score (cp|mate) (-?\d+)/);
      if (m) this.pending.score = { [m[1]]: Number(m[2]) };
    }
    if (line.startsWith('bestmove')) {
      const uci = line.split(' ')[1];
      const { resolve, analysis, score } = this.pending;
      this.pending = null;
      const best = uci && uci !== '(none)' ? uci : null;
      resolve(analysis ? { ...(score ?? {}), best } : best);
    }
  }

  newGame() {
    this.stop();
    this.send('ucinewgame');
  }

  // Cancela la búsqueda en curso (la promesa se resuelve con null).
  stop() {
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = null;
      this.send('stop');
      resolve(null);
    }
  }

  // Evalúa una posición (análisis de partidas): `{ cp }` o `{ mate }` desde quien mueve, y la mejor jugada UCI. null si el motor no está.
  async evaluate(fen, { depth = 12, movetime = 300 } = {}) {
    const ok = await this.init();
    if (!ok) return null;
    this.stop();
    return new Promise((resolve) => {
      this.pending = { resolve, analysis: true, score: null };
      this.send('setoption name Skill Level value 20');
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth} movetime ${movetime}`);
    });
  }

  // Cierra el hilo del motor (el análisis usa uno propio para no molestar a ninguna partida).
  dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }

  // Devuelve la mejor jugada UCI (p. ej. "e2e4" o "e7e8q") para un FEN.
  async bestMove(fen, { skill = 20, depth = 12, movetime = 800 } = {}) {
    const ok = await this.init();
    if (!ok) return null;
    this.stop();
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.send(`setoption name Skill Level value ${skill}`);
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth} movetime ${movetime}`);
    });
  }
}
