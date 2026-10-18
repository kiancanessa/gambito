// Ejecuta Stockfish.js (WASM, un hilo) en Node con un protocolo UCI sencillo por stdin/stdout.
// El binario de línea de comandos del paquete no responde a los comandos, así que se usa su API:
// en la versión "single" los comandos entran por `onCustomMessage`.
const path = require('node:path');
const readline = require('node:readline');

const dir = path.resolve(__dirname, '..', 'node_modules', 'stockfish', 'src');
const file = path.join(dir, 'stockfish-nnue-16-single.js');
const wasm = path.join(dir, 'stockfish-nnue-16-single.wasm');

const queue = [];
let engine = null;

require(file)()({ locateFile: (f) => (f.includes('.wasm') ? wasm : file) }).then((e) => {
  engine = e;
  engine.addMessageListener((line) => process.stdout.write(`${line}\n`));
  queue.splice(0).forEach((cmd) => engine.onCustomMessage(cmd));
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line) return;
  if (line === 'quit') process.exit(0);
  if (engine) engine.onCustomMessage(line);
  else queue.push(line);
});
