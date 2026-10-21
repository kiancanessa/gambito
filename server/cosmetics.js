// Inventario de cosméticos: el servidor decide qué tiene cada jugador y qué lleva equipado.
//
// · Los artículos que se desbloquean por nivel o por logro se conceden aquí, solos, comprobando los datos del servidor
//   (nivel de la cartera, tabla `achievements`). `sync` es idempotente: no duplica nada.
// · Los de temporada y circuito llegan por sus propios flujos (reclamo del pase, premio del torneo).
// · Equipar exige poseer el artículo (se comprueba en la cartera) y que el artículo exista.
// · El cliente nunca puede otorgarse un artículo: no hay ninguna ruta que lo permita.
import { CATEGORY_IDS, ITEMS, findItem, isObtainable, itemKey } from '../public/js/cosmetics-data.js';

const REASON = {
  unknown: 'Ese artículo no existe',
  unavailable: 'Ese artículo aún no está disponible',
  owned: 'Todavía no tienes ese artículo',
  invalid: 'Petición no válida',
};
export const cosmeticMessage = (reason) => REASON[reason] ?? 'No se pudo completar la acción';

/**
 * @param {object} o
 * @param {ReturnType<import('./db.js').openDb>} o.db
 * @param {ReturnType<import('./wallet.js').createWallets>} o.wallets
 * @param {(userId: string, msg: object) => unknown} [o.notify]
 */
export function createCosmetics({ db, wallets, notify = () => {} }) {
  const raw = db.raw;
  const achievementsOf = raw.prepare('SELECT id FROM achievements WHERE user_id = ?');

  /** Concede los artículos que el jugador ya merece por nivel o logros. Devuelve los nuevos. */
  function sync(userId) {
    const w = wallets.ensure(userId);
    const owned = new Set(w.owned);
    const done = new Set(achievementsOf.all(userId).map((r) => r.id));
    const due = ITEMS.filter((it) => {
      if (!isObtainable(it) || owned.has(itemKey(it.category, it.id))) return false;
      if (it.unlock.type === 'level') return w.level >= it.unlock.level;
      if (it.unlock.type === 'achievement') return done.has(it.unlock.id);
      return false;
    });
    if (!due.length) return [];
    const granted = [];
    raw.exec('BEGIN IMMEDIATE');
    try {
      for (const it of due) {
        const key = itemKey(it.category, it.id);
        const g = wallets.grantInTx(userId, { ref: `cosm:${key}`, source: 'cosmetic', item: key });
        if (g.ok && g.item) granted.push({ category: it.category, id: it.id, name: it.name });
      }
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
    if (granted.length) notify(userId, { t: 'cosmetics', unlocked: granted });
    return granted;
  }

  /** Estado del inventario para la pantalla de personalización (el catálogo es estático y lo conoce el cliente). */
  function view(userId) {
    const newly = sync(userId);
    const w = wallets.ensure(userId);
    const done = achievementsOf.all(userId).map((r) => r.id);
    return { owned: w.owned.filter((k) => k.split(':')[0] && findItem(...k.split(':'))), equipped: w.equipped, level: w.level, coins: w.coins, achievements: done, newly };
  }

  /** Equipa un artículo que el jugador posee. La propiedad se valida en la cartera, no en lo que diga el cliente. */
  function equip(userId, { category, id }) {
    if (typeof category !== 'string' || typeof id !== 'string' || !CATEGORY_IDS.includes(category)) return { ok: false, reason: 'invalid' };
    const item = findItem(category, id);
    if (!item) return { ok: false, reason: 'unknown' };
    if (item.status !== 'active') return { ok: false, reason: 'unavailable' };
    sync(userId); // por si acaba de cumplir el requisito
    const res = wallets.apply(userId, [{ oid: `eq-${Date.now()}`, t: 'equip', kind: category, id }]);
    if (!res.results[0]?.ok) return { ok: false, reason: 'owned' };
    return { ok: true, equipped: res.wallet.equipped };
  }

  return { sync, view, equip };
}
