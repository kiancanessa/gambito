// Cartera del jugador verificada en el servidor: oros, XP, inventario y objetos equipados (Fase 2).
//
// El cliente sigue guardando su copia (para jugar sin conexión), pero la fuente de verdad es esta cartera:
// el cliente envía *operaciones* (comprar, equipar, ganar) y el servidor las valida y devuelve el estado real.
// - Compras, equipar y recompensas de temporada/partidas online/desafío diario se comprueban de verdad.
// - Las recompensas que dependen de partidas contra la IA (que el servidor no ve) llevan topes por evento y por día:
//   no se pueden probar, pero se acota lo que se podría falsear.
import { Chess } from 'chess.js';
import { DAILY_REWARDS, DEFAULT_EQUIPPED, DEFAULT_OWNED, XP_PER_LEVEL } from '../public/js/data.js';
import { ITEMS, isGranted, itemKey } from '../public/js/cosmetics-data.js';

// Catálogo de cosméticos (cosmetics-data.js): TODOS los artículos conocidos, los comprables con precio fijado aquí y los que
// solo concede el servidor (nivel, logro, temporada, circuito). El cliente nunca puede otorgarse un artículo: ni comprar uno
// que no se vende, ni importarlo desde un guardado, ni equipar uno que no tiene.
const KNOWN = new Set(ITEMS.filter((it) => it.status === 'active').map((it) => itemKey(it.category, it.id)));
const CATALOG = new Map(); // artículos que se pueden comprar con oros (o incluidos por defecto): clave → precio
const EXCLUSIVE = new Set(); // artículos que no se compran
for (const it of ITEMS) {
  const key = itemKey(it.category, it.id);
  if (it.status !== 'active') continue;
  if (it.unlock.type === 'purchase') CATALOG.set(key, it.unlock.price);
  else if (it.unlock.type === 'default') CATALOG.set(key, 0);
  else if (isGranted(it)) EXCLUSIVE.add(key);
}

const START_COINS = 100;
const MIGRATION_MAX_COINS = 20_000; // tope al importar el guardado antiguo (que el cliente podía falsear)
const MAX_COINS = 1_000_000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_OPS = 50;

// Fuentes sin verificación posible: tope por evento y por ventana de 24 h.
// Práctica local (IA, Academia): el servidor no la ve, así que da poca XP y con tope diario. La XP «de verdad» (partidas online,
// desafío diario, torneos, misiones) la concede el servidor por su cuenta: ver progression.js.
const CAPPED = {
  game: { coins: 500, xp: 60, dayCoins: 3000, dayXp: 300 },
  tutorial: { coins: 100, xp: 0, dayCoins: 100, dayXp: 0 },
  login: { coins: Math.max(...DAILY_REWARDS), xp: 0, dayCoins: 400, dayXp: 0 },
};
const SPEND = { hint: 50 };

const int = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(n)) || 0));
const KEY_RE = /^[\w:.-]{1,64}$/;

function levelFrom(xp, level) {
  let l = level;
  let x = xp;
  while (x >= XP_PER_LEVEL(l)) {
    x -= XP_PER_LEVEL(l);
    l += 1;
  }
  return { xp: x, level: l };
}

// Convierte el guardado antiguo del cliente en una cartera válida (clamp + catálogo).
export function walletFromSave(save) {
  const s = save && typeof save === 'object' ? save : null;
  const owned = new Set(DEFAULT_OWNED);
  if (s && Array.isArray(s.owned)) for (const id of s.owned) if (CATALOG.has(id) && !EXCLUSIVE.has(id)) owned.add(id);
  const equipped = { ...DEFAULT_EQUIPPED };
  if (s?.equipped && typeof s.equipped === 'object') {
    for (const kind of Object.keys(DEFAULT_EQUIPPED)) {
      const id = s.equipped[kind];
      if (typeof id === 'string' && owned.has(`${kind}:${id}`)) equipped[kind] = id;
    }
  }
  const level = int(s?.level, 1, 200) || 1;
  return {
    coins: s ? int(s.coins, 0, MIGRATION_MAX_COINS) : START_COINS,
    xp: int(s?.xp, 0, XP_PER_LEVEL(level) - 1),
    level,
    owned: [...owned],
    equipped,
  };
}

export function createWallets(db) {
  const raw = db.raw;
  const q = {
    get: raw.prepare('SELECT coins, xp, level, owned, equipped, rev FROM wallets WHERE user_id = ?'),
    insert: raw.prepare('INSERT INTO wallets (user_id, coins, xp, level, owned, equipped, rev, updated_at) VALUES (?,?,?,?,?,?,?,?)'),
    update: raw.prepare('UPDATE wallets SET coins=?, xp=?, level=?, owned=?, equipped=?, rev=rev+1, updated_at=? WHERE user_id=?'),
    ref: raw.prepare('SELECT 1 FROM ledger WHERE user_id = ? AND ref = ?'),
    log: raw.prepare('INSERT INTO ledger (user_id, ref, source, coins, xp, created_at) VALUES (?,?,?,?,?,?)'),
    window: raw.prepare('SELECT COALESCE(SUM(coins),0) AS coins, COALESCE(SUM(xp),0) AS xp FROM ledger WHERE user_id = ? AND source = ? AND created_at > ?'),
    clearLedger: raw.prepare('DELETE FROM ledger WHERE user_id = ?'),
  };

  // Cuentas anteriores a un cosmético nuevo: se completan con lo que todas las cuentas tienen (idempotente, sin duplicados).
  const view = (row) => ({
    coins: row.coins,
    xp: row.xp,
    level: row.level,
    owned: [...new Set([...DEFAULT_OWNED, ...JSON.parse(row.owned)])],
    equipped: { ...DEFAULT_EQUIPPED, ...JSON.parse(row.equipped) },
    rev: row.rev,
  });

  // Devuelve la cartera; si no existe se crea a partir del guardado en la nube (migración idempotente).
  function ensure(userId) {
    const row = q.get.get(userId);
    if (row) return view(row);
    const w = walletFromSave(db.getSave(userId)?.data);
    q.insert.run(userId, w.coins, w.xp, w.level, JSON.stringify(w.owned), JSON.stringify(w.equipped), 1, Date.now());
    return view(q.get.get(userId));
  }

  const store = (userId, w) => q.update.run(w.coins, w.xp, w.level, JSON.stringify(w.owned), JSON.stringify(w.equipped), Date.now(), userId);

  // Recompensa de una partida online, calculada solo con lo que el servidor vio.
  function onlineReward(userId, code) {
    const g = db.gameByCode(code, userId);
    if (!g || g.reason === 'abortada') return null;
    const moves = JSON.parse(g.moves);
    if (moves.length < 6) return { coins: 0, xp: 0 };
    const mine = g.white_id === userId ? 'w' : 'b';
    const result = g.winner === mine ? 'win' : g.winner ? 'loss' : 'draw';
    let coins = Math.round({ win: 60, draw: 20, loss: 10 }[result] * (g.rated ? 1.5 : 1));
    if (result === 'win') {
      let checks = 0;
      const chess = new Chess();
      try {
        moves.forEach((uci, i) => {
          const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
          if (m && (i % 2 === 0) === (mine === 'w') && /[+#]$/.test(m.san)) checks += 1;
        });
      } catch {
        /* partida guardada ilegible: sin bonificación */
      }
      coins += Math.min(25, checks * 5);
    }
    return { coins, xp: 0 }; // la XP de las partidas online la concede el servidor (progression.js)
  }

  // Cada operación lleva `oid` (identificador único del cliente, para reintentos) y `t` (tipo).
  // Resuelve una operación a { coins, xp, grant? } o devuelve un motivo de rechazo.
  function earnOf(userId, op) {
    const key = typeof op.key === 'string' && KEY_RE.test(op.key) ? op.key : null;
    switch (op.source) {
      case 'online': {
        const code = key?.startsWith('game:') ? key.slice(5) : null;
        const r = code && onlineReward(userId, code);
        return r ? { ref: key, ...r } : { reason: 'unverified' };
      }
      case 'puzzle': {
        const day = Number(key?.startsWith('daily:') ? key.slice(6) : NaN);
        if (!Number.isInteger(day) || !db.dailyMine(day, userId)) return { reason: 'unverified' };
        return { ref: key, coins: int(op.coins, 60, 100), xp: 0 };
      }
      case 'circuit': {
        const tid = key?.startsWith('circuit:') ? key.slice(8) : null;
        const prize = tid && db.tournamentResult(tid, userId);
        if (!prize) return { reason: 'unverified' };
        return { ref: key, coins: prize.coins, xp: 0, grant: prize.item }; // la XP del torneo la concede el servidor al terminar
      }
      case 'season': // las recompensas de temporada se reclaman en /api/progress/claim (el servidor comprueba el nivel)
        return { reason: 'moved' };
      default: {
        const cap = CAPPED[op.source];
        if (!cap) return { reason: 'unknown' };
        const ref = key ?? (typeof op.oid === 'string' && KEY_RE.test(op.oid) ? `op:${op.oid}` : null);
        if (!ref) return { reason: 'invalid' };
        let coins = int(op.coins, 0, cap.coins);
        const xp = int(op.xp, 0, cap.xp);
        if (op.source === 'login' && coins && !DAILY_REWARDS.includes(coins)) return { reason: 'invalid' };
        if (op.source === 'tutorial') coins = Math.min(coins, 100);
        const used = q.window.get(userId, op.source, Date.now() - DAY_MS);
        if (used.coins + coins > cap.dayCoins || used.xp + xp > cap.dayXp) return { reason: 'cap' };
        return { ref, coins, xp };
      }
    }
  }

  function applyOp(userId, w, op) {
    switch (op?.t) {
      case 'buy': {
        const id = `${op.kind}:${op.id}`;
        if (EXCLUSIVE.has(id)) return 'exclusive';
        const price = CATALOG.get(id);
        if (price === undefined) return 'unknown';
        if (w.owned.includes(id)) return 'owned';
        if (w.coins < price) return 'coins';
        w.coins -= price;
        w.owned.push(id);
        return null;
      }
      case 'equip': {
        if (!(op.kind in DEFAULT_EQUIPPED) || !w.owned.includes(`${op.kind}:${op.id}`)) return 'owned';
        w.equipped[op.kind] = op.id;
        return null;
      }
      case 'spend': {
        const max = SPEND[op.source];
        const n = int(op.amount, 0, max ?? 0);
        if (!max || n <= 0) return 'invalid';
        if (w.coins < n) return 'coins';
        w.coins -= n;
        return null;
      }
      case 'earn': {
        const r = earnOf(userId, op);
        if (r.reason) return r.reason;
        if (q.ref.get(userId, r.ref)) return 'dup';
        w.coins = Math.min(MAX_COINS, w.coins + r.coins);
        if (r.xp) Object.assign(w, levelFrom(w.xp + r.xp, w.level));
        if (r.grant && KNOWN.has(r.grant) && !w.owned.includes(r.grant)) w.owned.push(r.grant);
        q.log.run(userId, r.ref, op.source, r.coins, r.xp, Date.now());
        return null;
      }
      default:
        return 'unknown';
    }
  }

  // Aplica un lote de operaciones en orden y de forma atómica. Cada resultado dice si se aceptó.
  function apply(userId, ops) {
    const list = Array.isArray(ops) ? ops.slice(0, MAX_OPS) : [];
    const results = [];
    raw.exec('BEGIN');
    try {
      let w = ensure(userId);
      const before = JSON.stringify(w);
      for (const op of list) {
        if (op?.t === 'reset') {
          q.clearLedger.run(userId);
          w = { ...walletFromSave(null), rev: w.rev };
          results.push({ oid: op.oid, ok: true });
          continue;
        }
        const reason = applyOp(userId, w, op);
        results.push({ oid: op?.oid, ok: !reason || reason === 'dup', ...(reason ? { reason } : {}) });
      }
      if (JSON.stringify(w) !== before) store(userId, w);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
    return { wallet: view(q.get.get(userId)), results };
  }

  // Concede monedas, XP y un objeto una sola vez por `ref` (el libro de cuentas lo impide), dentro de la transacción en curso.
  // Si el jugador ya tiene el objeto, `fallbackCoins` lo compensa.
  function grantInTx(userId, { ref, source, coins = 0, xp = 0, item = null, fallbackCoins = 0 }) {
    if (q.ref.get(userId, ref)) return { ok: false, reason: 'dup' };
    const w = ensure(userId);
    const levelBefore = w.level;
    let gained = coins;
    let granted = null;
    if (item && KNOWN.has(item)) {
      if (w.owned.includes(item)) gained += fallbackCoins;
      else {
        w.owned.push(item);
        granted = item;
      }
    }
    w.coins = Math.min(MAX_COINS, w.coins + gained);
    if (xp) Object.assign(w, levelFrom(w.xp + xp, w.level));
    store(userId, w);
    q.log.run(userId, ref, source, gained, xp, Date.now());
    return { ok: true, level: w.level, levelBefore, coins: gained, xp, item: granted };
  }

  function grant(userId, g) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const r = grantInTx(userId, g);
      raw.exec('COMMIT');
      return r;
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }

  return { ensure, apply, grant, grantInTx };
}
