// Configuración del servidor (todo por variables de entorno, con valores por defecto de desarrollo).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.PORT) || 5173;
export const HOST = process.env.HOST || '0.0.0.0';
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'gambito.db');
export const PUBLIC_DIR = path.join(ROOT, 'public');
// Detrás de un proxy (Fly, Render, Railway...) la IP real viene en X-Forwarded-For.
export const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production';
export const SAVE_LIMIT_BYTES = 64 * 1024;

// Orígenes (otras webs) autorizados a usar la API y el WebSocket, p. ej. el cliente alojado en Vercel:
//   ALLOWED_ORIGINS=https://gambito-five.vercel.app,https://gambito.com
// Se lee en cada petición para poder cambiarlo en pruebas. El propio origen del servidor siempre está permitido.
export const allowedOrigins = () =>
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

// Topes anti-abuso (objeto mutable para poder ajustarlo en pruebas).
export const LIMITS = {
  roomsPerUser: 3, // partidas abiertas (esperando o en juego) por jugador
  totalRooms: 5000, // salas simultáneas en todo el servidor
  wsPerIp: 20, // conexiones WebSocket simultáneas por IP
  socketsPerUser: 6, // conexiones simultáneas por cuenta (varias pestañas/dispositivos)
  createsPerMinute: 8, // salas nuevas por minuto y conexión
  spectatorsPerRoom: 200,
};
