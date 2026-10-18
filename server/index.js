// Punto de entrada: HTTP (estáticos + API) y WebSocket en el mismo puerto.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApi } from './api.js';
import { DB_FILE, HOST, PORT, PUBLIC_DIR, TRUST_PROXY } from './config.js';
import { loadPuzzles } from './daily.js';
import { openDb } from './db.js';
import { Matchmaker } from './matchmaker.js';
import { RoomManager } from './rooms.js';
import { createStatic } from './static.js';
import { attachWs } from './ws.js';

export function startServer({ port = PORT, host = HOST, dbFile = DB_FILE, publicDir = PUBLIC_DIR, puzzles = null } = {}) {
  const db = openDb(dbFile);
  const rooms = new RoomManager(db);
  const matchmaker = new Matchmaker(rooms);
  let ws = null;
  const api = createApi({ db, rooms, matchmaker, onlineCount: () => ws?.count() ?? 0, puzzles: puzzles ?? loadPuzzles() });
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
  ws = attachWs(server, { db, rooms, matchmaker });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server,
        db,
        rooms,
        matchmaker,
        port: actual,
        url: `http://localhost:${actual}`,
        async close() {
          matchmaker.close();
          rooms.close();
          ws.close();
          await new Promise((r) => server.close(r));
          server.closeAllConnections?.();
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
