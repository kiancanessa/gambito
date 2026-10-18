// Bot de desarrollo: se une a una sala y juega jugadas legales al azar (con preferencia por capturas).
// Uso: node scripts/dev-bot.js CODIGO|queue:CONTROL [http://localhost:5173] [ms-entre-jugadas=1200]
//   - CODIGO: se une a esa sala (partida con amigo).
//   - queue:blitz5: entra en la cola clasificatoria (controles: bullet, blitz3, blitz3_2, blitz5, rapid10, rapid15_10).
// Útil para probar el modo online con una sola persona.
import { Chess } from 'chess.js';
import WebSocket from 'ws';

const [code, base = 'http://localhost:5173', delay = '1200'] = process.argv.slice(2);
if (!code) {
  console.error('Uso: node scripts/dev-bot.js CODIGO [url] [ms]');
  process.exit(1);
}

const res = await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bot Dev' }) });
const { token, user } = await res.json();
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
const send = (m) => ws.send(JSON.stringify(m));
let busy = false;

ws.on('open', () => send({ t: 'auth', token }));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'authed') send(code.startsWith('queue:') ? { t: 'queue', tc: code.slice(6) } : { t: 'join', code: code.toUpperCase() });
  if (m.t === 'error') console.log('error:', m.message);
  if (m.t !== 'state') return;
  if (m.status === 'over') {
    console.log('Partida terminada:', m.result);
    process.exit(0);
  }
  if (m.status !== 'playing' || m.you === 's' || m.turn !== m.you || busy) return;
  busy = true;
  setTimeout(() => {
    const chess = new Chess(m.fen);
    const moves = chess.moves({ verbose: true });
    const caps = moves.filter((x) => x.captured);
    const pick = (caps.length && Math.random() < 0.6 ? caps : moves)[Math.floor(Math.random() * (caps.length && Math.random() < 0.6 ? caps.length : moves.length))] ?? moves[0];
    send({ t: 'move', uci: pick.from + pick.to + (pick.promotion || '') });
    busy = false;
  }, Number(delay));
});
console.log(`Bot ${user.name} entrando en la sala ${code}...`);
