// Cola de emparejamiento clasificatorio por rating (la ventana se amplía con la espera).
export const WINDOW_BASE = 100;
export const WINDOW_PER_SECOND = 25;
export const WINDOW_MAX = 600;

export class Matchmaker {
  constructor(rooms, { intervalMs = 1500, canMatch = () => true } = {}) {
    this.rooms = rooms;
    this.canMatch = canMatch; // (userA, userB) => boolean: p. ej. no emparejar a quien se ha bloqueado
    this.queue = []; // { user, ws, tcId, since }
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  size() {
    return this.queue.length;
  }

  enqueue(user, ws, tcId) {
    this.dequeue(user.id);
    this.queue.push({ user, ws, tcId, since: Date.now() });
    ws.meta.queued = true;
    this.tick();
  }

  dequeue(userId) {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => {
      if (e.user.id !== userId) return true;
      e.ws.meta.queued = false;
      return false;
    });
    return this.queue.length !== before;
  }

  removeSocket(ws) {
    this.queue = this.queue.filter((e) => e.ws !== ws);
  }

  tick(now = Date.now()) {
    const used = new Set();
    const sorted = [...this.queue].sort((a, b) => a.since - b.since);
    for (const a of sorted) {
      if (used.has(a)) continue;
      const waited = (now - a.since) / 1000;
      const window = Math.min(WINDOW_MAX, WINDOW_BASE + WINDOW_PER_SECOND * waited);
      let best = null;
      for (const b of sorted) {
        if (b === a || used.has(b) || b.tcId !== a.tcId || b.user.id === a.user.id || !this.canMatch(a.user, b.user)) continue;
        const wb = Math.min(WINDOW_MAX, WINDOW_BASE + WINDOW_PER_SECOND * ((now - b.since) / 1000));
        const diff = Math.abs(a.user.rating - b.user.rating);
        if (diff <= Math.max(window, wb) && (!best || diff < best.diff)) best = { entry: b, diff };
      }
      if (best) {
        used.add(a);
        used.add(best.entry);
        this.match(a, best.entry);
      }
    }
    this.queue = this.queue.filter((e) => !used.has(e));
  }

  match(a, b) {
    const room = this.rooms.create({ tcId: a.tcId, rated: true, colorPref: 'r' });
    for (const e of [a, b]) {
      e.ws.meta.queued = false;
      room.seat(e.user, e.ws);
      room.send(e.ws, { t: 'matched', code: room.code });
    }
    room.broadcast();
  }

  close() {
    clearInterval(this.timer);
  }
}
