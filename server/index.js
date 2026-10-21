// Punto de entrada: HTTP (estáticos + API) y WebSocket en el mismo puerto.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApi } from './api.js';
import { DB_FILE, HOST, PORT, PUBLIC_DIR, TRUST_PROXY } from './config.js';
import { loadPuzzles } from './daily.js';
import { openDb } from './db.js';
import { Matchmaker } from './matchmaker.js';
import { PgStore, createPersistence } from './persist.js';
import { RoomManager } from './rooms.js';
import { createStatic } from './static.js';
import { attachWs } from './ws.js';
import { CIRCUIT, CircuitManager } from './tournaments.js';
import { createSocial } from './social.js';
import { createProgression } from './progression.js';
import { createWallets } from './wallet.js';
import { createMetrics } from './metrics.js';

function circuitEnvOptions() {
  const every = Number(process.env.CIRCUIT_EVERY_MS);
  const min = Number(process.env.CIRCUIT_MIN_PLAYERS);
  const lead = Number(process.env.CIRCUIT_LEAD_MS);
  if (!every && !min && !lead) return {};
  return {
    formats: CIRCUIT.formats.map((f) => ({ ...f, everyMs: every || f.everyMs, minPlayers: min || f.minPlayers })),
    ...(lead ? { minLeadMs: lead, closeLeadMs: Math.round(lead / 2) } : {}),
  };
}

// Persistencia opcional para alojamientos sin disco (Render Free): con DATABASE_URL (Postgres de Neon) la base de datos
// SQLite se restaura al arrancar y se copia periódicamente (ver server/persist.js).
export async function startServer({
  port = PORT,
  host = HOST,
  dbFile = DB_FILE,
  publicDir = PUBLIC_DIR,
  puzzles = null,
  databaseUrl = process.env.DATABASE_URL,
  persistStore = null,
  // 3 min, y solo si hubo cambios: Neon gratis (100 CU-h/mes) se suspende a los 5 min sin consultas, así que de noche, sin
  // actividad, no gasta cuota. Además se guarda siempre al apagar (SIGTERM). Ajustable con PERSIST_INTERVAL_MS.
  persistIntervalMs = Number(process.env.PERSIST_INTERVAL_MS) || 3 * 60_000,
  persistOptions = {},
  // Tiempos del Royale Circuit (pruebas). CIRCUIT_EVERY_MS / CIRCUIT_MIN_PLAYERS / CIRCUIT_LEAD_MS acortan el calendario para probarlo a mano.
  circuitOptions = circuitEnvOptions(),
  // Cada cuántos ms se escribe una línea de métricas en el log (0 la desactiva).
  metricsLogMs = process.env.METRICS_LOG_MS === undefined ? 300_000 : Number(process.env.METRICS_LOG_MS),
} = {}) {
  const metrics = createMetrics();
  let persistence = null;
  if (persistStore || databaseUrl) {
    persistence = createPersistence({ dbFile, store: persistStore ?? new PgStore(databaseUrl), intervalMs: persistIntervalMs, ...persistOptions });
    await persistence.restore();
  }
  const db = openDb(dbFile);
  persistence?.start(db);
  const rooms = new RoomManager(db, { metrics });
  const social = createSocial(db);
  // No se empareja a quien se ha bloqueado ni, con BLOCK_SAME_IP_RANKED=1, a dos cuentas de la misma IP (reparto de puntos entre cuentas propias).
  const matchmaker = new Matchmaker(rooms, {
    canMatch: (a, b, wa, wb) => !social.isBlocked(a.id, b.id) && !(process.env.BLOCK_SAME_IP_RANKED === '1' && wa?.ip && wa.ip === wb?.ip),
  });
  let ws = null;
  const wallets = createWallets(db);
  const progression = createProgression({ db, wallets, notify: (id, msg) => ws?.notify(id, msg) });
  rooms.onGameSaved = (room) => progression.recordGame(room);
  const circuit = new CircuitManager({ rooms, db, options: circuitOptions, metrics, progression });
  const api = createApi({
    db,
    rooms,
    matchmaker,
    circuit,
    social,
    metrics,
    wallets,
    progression,
    presence: (ids) => ws?.presence(ids) ?? {},
    notify: (id, msg) => ws?.notify(id, msg),
    onlineCount: () => ws?.count() ?? 0,
    puzzles: puzzles ?? loadPuzzles(),
    persistStatus: () => persistence?.status() ?? null,
  });
  const serveStatic = createStatic(publicDir);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const t0 = performance.now();
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
    if (isApi) {
      res.on('finish', () => {
        metrics.observeHttp(performance.now() - t0);
        metrics.inc('http_requests_total', { status: `${Math.floor(res.statusCode / 100)}xx` });
      });
    }
    const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ip = fwd || req.socket.remoteAddress || 'unknown';
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const handled = await api(req, res, url, ip);
      if (handled !== false) return;
    }
    await serveStatic(req, res, url);
  });
  ws = attachWs(server, { db, rooms, matchmaker, circuit, social, metrics });
  const countRooms = (status) => [...rooms.rooms.values()].filter((r) => r.status === status).length;
  metrics.gauge('ws_connections', () => ws?.count() ?? 0);
  metrics.gauge('rooms_total', () => rooms.rooms.size);
  metrics.gauge('rooms_playing', () => countRooms('playing'));
  metrics.gauge('rooms_waiting', () => countRooms('waiting'));
  metrics.gauge('queue_size', () => matchmaker.size());
  metrics.gauge('circuit_running', () => [...circuit.tournaments.values()].filter((t) => t.status === 'running').length);
  metrics.gauge('persist_degraded', () => (persistence?.status().degraded ? 1 : 0));
  const metricsTimer = metricsLogMs > 0 ? setInterval(() => console.log(metrics.line()), metricsLogMs) : null;
  metricsTimer?.unref();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server,
        db,
        rooms,
        matchmaker,
        circuit,
        persistence,
        port: actual,
        url: `http://localhost:${actual}`,
        async close() {
          matchmaker.close();
          circuit.close();
          clearInterval(metricsTimer);
          metrics.stop();
          ws.close(); // primero los sockets: al caer, las salas programan avisos de desconexión que rooms.close() debe limpiar
          rooms.close();
          // Se dejan de aceptar conexiones y se cortan las que siguen abiertas (keep-alive de proxys y monitores):
          // esperar a que se cierren solas bloqueaba el apagado y la copia final nunca se hacía.
          const closed = new Promise((r) => server.close(r));
          server.closeAllConnections?.();
          await closed;
          await persistence?.stop(); // copia final antes de cerrar la base de datos
          db.close();
        },
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startServer();
  console.log(`Gambito escuchando en ${app.url}`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
