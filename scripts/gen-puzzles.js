// Genera server/puzzles.json: posiciones con mate forzado en 2-3 y primera jugada única.
// Uso: node scripts/gen-puzzles.js [cantidad=200] [procesos=4]
// Juega partidas rápidas Stockfish (nivel bajo, MultiPV) y se queda con las posiciones que Stockfish
// confirma como "mate en 2/3" con una única jugada ganadora. Necesita la devDependency `stockfish`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'scripts', 'sf-runner.cjs');
const OUT = path.join(ROOT, 'server', 'puzzles.json');
const TARGET = Number(process.argv[2]) || 200;
const WORKERS = Number(process.argv[3]) || 4;

class Engine {
  constructor() {
    this.proc = spawn(process.execPath, [ENGINE], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = '';
    this.waiter = null;
    this.lines = [];
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        this.lines.push(line);
        if (this.waiter && this.waiter.test(line)) {
          const w = this.waiter;
          this.waiter = null;
          w.resolve(this.lines.splice(0));
        }
      }
    });
  }

  send(cmd) {
    this.proc.stdin.write(`${cmd}\n`);
  }

  until(re) {
    return new Promise((resolve) => {
      this.waiter = { test: (l) => re.test(l), resolve };
    });
  }

  async init() {
    this.send('uci');
    await this.until(/^uciok/);
    this.send('setoption name Hash value 16');
    this.send('isready');
    await this.until(/^readyok/);
  }

  // Devuelve las líneas principales (MultiPV) al máximo depth alcanzado.
  async analyze(fen, depth, multipv) {
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);
    const lines = await this.until(/^bestmove/);
    const best = new Map();
    for (const l of lines) {
      const m = l.match(/^info depth (\d+) .*?multipv (\d+) score (cp|mate) (-?\d+).* pv (.+)$/);
      if (!m) continue;
      const [, d, pv, type, score, moves] = m;
      const prev = best.get(+pv);
      if (!prev || +d >= prev.depth) best.set(+pv, { depth: +d, type, score: +score, pv: moves.split(' ') });
    }
    return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }

  quit() {
    this.send('quit');
    this.proc.kill();
  }
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const key = (fen) => fen.split(' ').slice(0, 4).join(' ');

async function worker(id, found, seen) {
  const eng = new Engine();
  await eng.init();
  while (found.length < TARGET) {
    const chess = new Chess();
    // Aperturas variadas: las primeras jugadas son aleatorias.
    for (let i = 0; i < 4 + Math.floor(Math.random() * 6); i += 1) chess.move(pick(chess.moves()));
    for (let ply = 0; ply < 90 && !chess.isGameOver() && found.length < TARGET; ply += 1) {
      const fen = chess.fen();
      const [top] = await eng.analyze(fen, 8, 1);
      if (!top) break;
      if (top.type === 'mate' && (top.score === 2 || top.score === 3) && !seen.has(key(fen))) {
        // Confirmación más profunda y unicidad: la 2ª mejor jugada no debe mater igual de rápido.
        const deep = await eng.analyze(fen, 14, 2);
        const [a, b] = deep;
        const unique = a && a.type === 'mate' && a.score === top.score && (!b || b.type !== 'mate' || b.score <= 0 || b.score > a.score);
        if (unique && a.pv.length >= a.score * 2 - 1) {
          seen.add(key(fen));
          found.push({ id: found.length + 1, fen, mateIn: a.score, solution: a.pv.slice(0, a.score * 2 - 1) });
          writeFileSync(OUT, `${JSON.stringify(found, null, 1)}\n`);
          process.stdout.write(`\r[${found.length}/${TARGET}] mate en ${a.score} (worker ${id})   `);
        }
      }
      // Sigue la partida: elige entre las 3 mejores jugadas (búsqueda rápida) con sesgo hacia la mejor.
      const lines = await eng.analyze(fen, 2, 3);
      if (!lines.length) break;
      const r = Math.random();
      const choice = lines[r < 0.6 ? 0 : r < 0.9 ? Math.min(1, lines.length - 1) : Math.min(2, lines.length - 1)];
      const uci = choice.pv[0];
      try {
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      } catch {
        break;
      }
    }
  }
  eng.quit();
}

const found = existsSync(OUT) && process.argv[4] === '--append' ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const seen = new Set(found.map((p) => key(p.fen)));
console.log(`Generando ${TARGET} puzzles con ${WORKERS} procesos de Stockfish...`);
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1, found, seen)));
// Reparte mates en 2 y en 3 mezclados, y numera de nuevo.
const shuffled = found.sort(() => Math.random() - 0.5).map((p, i) => ({ ...p, id: i + 1 }));
writeFileSync(OUT, `${JSON.stringify(shuffled, null, 1)}\n`);
console.log(`\nListo: ${shuffled.length} puzzles en ${path.relative(ROOT, OUT)}`);
process.exit(0);
