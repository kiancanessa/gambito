// Prueba de humo contra un servidor en marcha (local o desplegado): estáticos, API, cuentas, WebSocket y una jugada.
// Uso: node scripts/smoke.js [URL] [--origin=https://cliente.example]
//   npm run smoke                      → http://localhost:5173
//   npm run smoke -- https://gambito.onrender.com --origin=https://gambito-five.vercel.app
// `--origin` simula el cliente alojado aparte (Vercel) para comprobar ALLOWED_ORIGINS en el WebSocket.
// Crea dos cuentas de invitado de prueba ("Smoke ...") en el servidor.
import WebSocket from 'ws';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173').replace(/\/$/, '');
const origin = args.find((a) => a.startsWith('--origin='))?.slice(9);
let failed = 0;

const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed += 1;
  return cond;
};

const json = async (path, opts = {}) => {
  const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
  return { res, body: await res.json().catch(() => null) };
};

function openSocket(token) {
  const url = `${base.replace(/^http/, 'ws')}/ws`;
  const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
  const msgs = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    msgs.push(m);
    waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
  });
  const waitFor = (pred, ms = 8000) =>
    new Promise((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error(`sin respuesta; últimos mensajes: ${JSON.stringify(msgs.slice(-2))}`)), ms);
      waiters.push({ test: pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'auth', token }));
      waitFor((m) => m.t === 'authed').then(() => resolve({ ws, msgs, waitFor, send: (m) => ws.send(JSON.stringify(m)) }), reject);
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`el servidor rechazó el WebSocket (HTTP ${res.statusCode})`)));
  });
}

async function main() {
  console.log(`Probando ${base}${origin ? ` (origen simulado ${origin})` : ''}\n`);

  const health = await fetch(`${base}/healthz`).catch(() => null);
  if (!check('GET /healthz', health?.ok)) return;

  const home = await fetch(`${base}/`);
  const html = await home.text();
  check('La app se sirve en /', home.ok && html.includes('Gambito'));
  check('Cabecera Content-Security-Policy', !!home.headers.get('content-security-policy'));
  const wasm = await fetch(`${base}/vendor/stockfish/stockfish-nnue-16-single.wasm`, { method: 'HEAD' });
  check('Stockfish (wasm) con tipo correcto', wasm.ok && wasm.headers.get('content-type') === 'application/wasm', wasm.headers.get('content-type') ?? '');
  const cfg = await fetch(`${base}/config.js`);
  check('/config.js disponible', cfg.ok);

  const stats = await json('/api/stats');
  check('GET /api/stats', stats.res.ok && typeof stats.body?.users === 'number', `${stats.body?.users} cuentas`);
  const persist = stats.body?.persist;
  if (persist) {
    check(
      'Copia de la base de datos (Neon) sin errores',
      !persist.lastError && !persist.lostOwnership,
      persist.lastError ?? (persist.lastOkAt ? `última copia hace ${Math.round((Date.now() - persist.lastOkAt) / 1000)} s` : 'aún sin copia (se hace cada 3 min si hay cambios y al apagar)'),
    );
  } else {
    console.log('• Copia de la base de datos: desactivada (sin DATABASE_URL; usa el disco local)');
  }

  const a = await json('/api/guest', { method: 'POST', body: JSON.stringify({ name: 'Smoke Blancas' }) });
  const b = await json('/api/guest', { method: 'POST', body: JSON.stringify({ name: 'Smoke Negras' }) });
  if (!check('Crear cuentas de invitado', a.res.status === 201 && b.res.status === 201)) return;

  const me = await json('/api/me', { headers: { Authorization: `Bearer ${a.body.token}` } });
  check('GET /api/me con token', me.res.ok && me.body.user.name === 'Smoke Blancas');

  const daily = await json('/api/daily', { headers: { Authorization: `Bearer ${a.body.token}` } });
  check('GET /api/daily', daily.res.ok && !!daily.body?.fen, `desafío #${daily.body?.number}, mate en ${daily.body?.mateIn}`);

  const save = await json('/api/save', { method: 'PUT', headers: { Authorization: `Bearer ${a.body.token}` }, body: JSON.stringify({ data: { smoke: true } }) });
  check('Guardado en la nube (PUT /api/save)', save.res.ok);

  // Partida real por WebSocket: crear, unirse, mover y ver el movimiento en el otro cliente.
  const t0 = Date.now();
  const ca = await openSocket(a.body.token).catch((e) => check('WebSocket del jugador 1', false, e.message));
  if (!ca) return;
  check('WebSocket autenticado', true, `${Date.now() - t0} ms`);
  const cb = await openSocket(b.body.token).catch((e) => check('WebSocket del jugador 2', false, e.message));
  if (!cb) return;

  ca.send({ t: 'create', tc: 'none', color: 'w' });
  const { code } = await ca.waitFor((m) => m.t === 'created');
  cb.send({ t: 'join', code });
  const playing = await cb.waitFor((m) => m.t === 'state' && m.status === 'playing').catch(() => null);
  check('Sala creada y rival unido', !!playing, `código ${code}`);

  const t1 = Date.now();
  ca.send({ t: 'move', uci: 'e2e4' });
  const seen = await cb.waitFor((m) => m.t === 'state' && m.moves?.length === 1).catch(() => null);
  check('Jugada validada y recibida por el rival', !!seen, `${Date.now() - t1} ms`);

  ca.send({ t: 'leave' });
  cb.send({ t: 'leave' });
  ca.ws.close();
  cb.ws.close();
}

const timer = setTimeout(() => {
  console.log('✗ Tiempo de espera agotado (30 s)');
  process.exit(1);
}, 30_000);

try {
  await main();
} catch (err) {
  check('Ejecución sin errores', false, err.message);
}
clearTimeout(timer);
console.log(failed ? `\n${failed} comprobación(es) fallida(s)` : '\nTodo correcto ✔');
process.exit(failed ? 1 : 0);
