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
import { CircuitManager } from './tournaments.js';
import { createSocial } from './social.js';

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
  // Tiempos del Royale Circuit (pruebas). CIRCUIT_FILL_MS acorta la espera de inscripción para probarlo a mano.
  circuitOptions = process.env.CIRCUIT_FILL_MS ? { fillAfterMs: Number(process.env.CIRCUIT_FILL_MS) } : {},
} = {}) {
  let persistence = null;
  if (persistStore || databaseUrl) {
    persistence = createPersistence({ dbFile, store: persistStore ?? new PgStore(databaseUrl), intervalMs: persistIntervalMs, ...persistOptions });
    await persistence.restore();
  }
  const db = openDb(dbFile);
  persistence?.start(db);
  const rooms = new RoomManager(db);
  const social = createSocial(db);
  const matchmaker = new Matchmaker(rooms, { canMatch: (a, b) => !social.isBlocked(a.id, b.id) });
  const circuit = new CircuitManager({ rooms, db, options: circuitOptions });
  let ws = null;
  const api = createApi({
    db,
    rooms,
    matchmaker,
    circuit,
    social,
    presence: (ids) => ws?.presence(ids) ?? {},
    notify: (id, msg) => ws?.notify(id, msg),
    onlineCount: () => ws?.count() ?? 0,
    puzzles: puzzles ?? loadPuzzles(),
    persistStatus: () => persistence?.status() ?? null,
  });
  const serveStatic = createStatic(publicDir);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ip = fwd || req.socket.remoteAddress || 'unknown';
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const handled = await api(req, res, url, ip);
      if (handled !== false) return;
    }
    await serveStatic(req, res, url);
  });
  ws = attachWs(server, { db, rooms, matchmaker, circuit, social });

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
