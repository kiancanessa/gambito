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
