// Estado persistente del jugador (localStorage con respaldo en memoria) + gancho para el guardado en la nube.
import { DEFAULT_OWNED, DAILY_REWARDS, XP_PER_LEVEL } from './data.js';

const KEY = 'gambito.save.v1';

const fresh = () => ({
  coins: 100,
  xp: 0,
  level: 1,
  owned: [...DEFAULT_OWNED],
  equipped: { set: 'classic', board: 'wood', fx: 'sparks' },
  campaign: { cleared: 0, stars: {}, seen: 0 }, // nodos superados, mejores estrellas por rival y último avance mostrado
  stats: { games: 0, wins: 0, losses: 0, draws: 0, checks: 0, captures: 0, promotions: 0, onlineGames: 0, onlineWins: 0, dailySolved: 0 },
  daily: { last: null, streak: 0 }, // recompensa de entrada diaria
  dailyPuzzle: { streak: 0, best: 0, lastDay: -1 }, // desafío diario (puzzle)
  missions: { dayKey: '', daily: [], weekKey: '', weekly: [] },
  season: { id: 1, xp: 0, claimed: [] },
  tutorialDone: false,
  muted: false,
  cloud: { rev: 0 }, // última revisión sincronizada con el servidor
  updatedAt: 0,
});

// Mezcla recursiva de objetos planos (los arrays y valores del guardado ganan).
function merge(base, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return base;
  const out = { ...base };
  for (const k of Object.keys(data)) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], data[k]) : data[k];
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? merge(fresh(), JSON.parse(raw)) : fresh();
  } catch {
    return fresh();
  }
}

export const state = load();
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* sin almacenamiento: el progreso vive solo en esta sesión */
  }
}

// `touch` marca que hubo un cambio local real (lo usa la sincronización en la nube).
export function save({ touch = true } = {}) {
  if (touch) state.updatedAt = Date.now();
  persist();
  listeners.forEach((fn) => fn(state));
}

export const onChange = (fn) => listeners.add(fn);

// Con el flag `wallet`, cada cambio de oros/XP/inventario se envía también al servidor como operación.
let opSink = null;
export const setOpSink = (fn) => {
  opSink = fn;
};
export const queueOp = (op) => opSink?.(op);

// Sustituye oros, XP e inventario por la cartera verificada del servidor (sin marcarlo como cambio local).
export function applyWallet(w) {
  Object.assign(state, { coins: w.coins, xp: w.xp, level: w.level, owned: [...w.owned], equipped: { ...w.equipped } });
  save({ touch: false });
}

// Sustituye el estado por el recibido de la nube (sin marcarlo como cambio local).
export function replaceState(data, rev) {
  const next = merge(fresh(), data);
  Object.keys(state).forEach((k) => delete state[k]);
  Object.assign(state, next);
  state.cloud = { rev };
  state.updatedAt = rev;
  save({ touch: false });
}

// Puntuación de progreso para decidir qué guardado manda si hay conflicto entre dispositivos.
export const progressScore = (s) =>
  (s.level ?? 1) * 1000 + (s.xp ?? 0) + (s.owned?.length ?? 0) * 50 + (s.campaign?.cleared ?? 0) * 500 + (s.stats?.games ?? 0) * 5;

export const owns = (kind, id) => state.owned.includes(`${kind}:${id}`);

export function grantItem(kind, id) {
  if (!owns(kind, id)) state.owned.push(`${kind}:${id}`);
}

export function buy(kind, item) {
  if (owns(kind, item.id)) return { ok: false, reason: 'owned' };
  if (state.coins < item.price) return { ok: false, reason: 'coins' };
  state.coins -= item.price;
  state.owned.push(`${kind}:${item.id}`);
  save();
  queueOp({ t: 'buy', kind, id: item.id });
  return { ok: true };
}

export function equip(kind, id) {
  if (!owns(kind, id)) return false;
  state.equipped[kind] = id;
  save();
  queueOp({ t: 'equip', kind, id });
  return true;
}

// `src` ({ source, key? }) indica de dónde viene el cambio para que el servidor lo valide (ver server/wallet.js).
export function addCoins(n, src) {
  state.coins += n;
  save();
  if (src) queueOp(n < 0 ? { t: 'spend', source: src.source, amount: -n } : { t: 'earn', source: src.source, key: src.key, coins: n });
}

// Suma XP y devuelve cuántos niveles se subieron.
export function addXp(n, src) {
  if (src) queueOp({ t: 'earn', source: src.source, xp: n });
  state.xp += n;
  let ups = 0;
  while (state.xp >= XP_PER_LEVEL(state.level)) {
    state.xp -= XP_PER_LEVEL(state.level);
    state.level += 1;
    ups += 1;
  }
  save();
  return ups;
}

const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// Recompensa de entrada diaria: devuelve { amount, streak } si hay una por reclamar, o null.
export function dailyAvailable() {
  return state.daily.last !== dayKey();
}

export function claimDaily() {
  if (!dailyAvailable()) return null;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  // Racha con 1 día de gracia: se mantiene si entraste ayer o anteayer.
  const twoAgo = new Date();
  twoAgo.setDate(twoAgo.getDate() - 2);
  const keeps = [dayKey(yesterday), dayKey(twoAgo)].includes(state.daily.last);
  state.daily.streak = keeps ? state.daily.streak + 1 : 1;
  state.daily.last = dayKey();
  const amount = DAILY_REWARDS[(state.daily.streak - 1) % DAILY_REWARDS.length];
  state.coins += amount;
  save();
  queueOp({ t: 'earn', source: 'login', key: `login:${dayKey()}`, coins: amount });
  return { amount, streak: state.daily.streak };
}

export function resetAll() {
  const cloud = state.cloud;
  Object.keys(state).forEach((k) => delete state[k]);
  Object.assign(state, fresh());
  state.cloud = cloud;
  save();
  queueOp({ t: 'reset' });
}
