// Cartera verificada en el servidor (Fase 2, flag `wallet`).
// El cliente sigue aplicando los cambios al instante (para jugar sin esperar ni sin conexión) y los envía al servidor
// como operaciones. Cuando el servidor responde, su cartera manda: el estado local pasa a ser un espejo.
import { flags } from './flags.js';
import { api, net, onLeave, onReady } from './net.js';
import { applyWallet, setOpSink } from './store.js';
import { toast } from './ui.js';

const KEY = 'gambito.wallet.q.v1';
const MAX_QUEUE = 200;
const BATCH = 50;

let queue = readQueue();
let timer = null;
let flushing = false;

function readQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function persistQueue() {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    /* sin almacenamiento: la cola vive solo en esta sesión */
  }
}

const newOid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(flush, ms);
}

export function enqueue(op) {
  if (op.t === 'reset') queue = []; // lo anterior ya no importa
  queue.push({ oid: newOid(), ...op });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  persistQueue();
  schedule(1200);
}

// Envía las operaciones pendientes. Con la cola vacía, aplica la cartera que devuelve el servidor.
export async function flush() {
  if (flushing || !net.user || !queue.length) return;
  flushing = true;
  let wallet = null;
  let rejected = 0;
  try {
    do {
      const batch = queue.slice(0, BATCH);
      const res = await api('/api/wallet/ops', { method: 'POST', body: { ops: batch } });
      if (!res.ok) {
        // Sin conexión o servidor ocupado: se conserva la cola y se reintenta. Un lote que el servidor rechaza entero se descarta.
        if (res.status === 0 || res.status === 401 || res.status === 429 || res.status >= 500) schedule(15_000);
        else {
          queue.splice(0, batch.length);
          persistQueue();
        }
        return;
      }
      queue.splice(0, batch.length);
      persistQueue();
      wallet = res.json.wallet;
      rejected += res.json.results.filter((r) => !r.ok).length;
    } while (queue.length);
  } finally {
    flushing = false;
  }
  if (wallet && !queue.length) {
    applyWallet(wallet);
    if (rejected) toast('El servidor no validó alguna recompensa y ajustó tus oros.', 4000);
  }
}

// Al arrancar (con sesión): sube lo pendiente y trae la cartera real.
async function init() {
  if (!net.user) return;
  if (queue.length) {
    await flush();
    if (queue.length) return;
  }
  const res = await api('/api/wallet');
  if (res.ok && !queue.length) applyWallet(res.json.wallet);
}

// Trae la cartera real del servidor (tras una reclamación o un premio concedido por el servidor).
export async function syncWallet() {
  if (!net.user || queue.length) return;
  const res = await api('/api/wallet');
  if (res.ok && !queue.length) applyWallet(res.json.wallet);
}

export function initWallet() {
  if (!flags.wallet) return;
  setOpSink(enqueue);
  onReady(init);
  // Al cerrar sesión: se envía lo pendiente y la cola se vacía (nada de una cuenta debe acabar en otra).
  onLeave(async () => {
    await flush();
    queue = [];
    persistQueue();
  });
  window.addEventListener('online', () => schedule(500));
  window.addEventListener('visibilitychange', () => {
    if (document.hidden && queue.length) flush();
  });
  if (queue.length) schedule(3000);
}
