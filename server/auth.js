// Cuentas de invitado: token secreto + código de recuperación. No se guardan secretos en claro.
import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const newToken = () => crypto.randomBytes(24).toString('hex');

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const newId = () => Array.from(crypto.randomBytes(10), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newRecoveryCode() {
  const chars = Array.from(crypto.randomBytes(12), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-');
}

export const normalizeCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Lista mínima de palabras prohibidas en nombres públicos (ampliable).
const BLOCKED = ['nazi', 'hitler', 'puta', 'puto', 'mierda', 'fuck', 'shit', 'nigg', 'pedo', 'violad', 'cabron', 'admin', 'gambito'];

export function cleanName(raw, fallback = null) {
  if (typeof raw !== 'string') return fallback;
  const name = raw
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  if (name.length < 3) return fallback;
  const flat = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (BLOCKED.some((w) => flat.includes(w))) return fallback;
  return name;
}

export const defaultName = () => `Peón-${Math.floor(1000 + Math.random() * 9000)}`;

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
