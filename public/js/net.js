// Conexión con el servidor: cuenta de invitado, guardado en la nube y WebSocket de partidas.
import { onChange, progressScore, replaceState, save, state } from './store.js';

const AUTH_KEY = 'gambito.auth.v1';

// URL base del servidor. Vacía = mismo origen que la página. Si el cliente se sirve aparte (Vercel),
// `public/config.js` define `window.GAMBITO_API` con la URL del servidor.
const apiBase = () => String(window.GAMBITO_API || '').replace(/\/$/, '');
export const apiUrl = (path) => `${apiBase()}${path}`;
const wsUrl = () => {
  const u = apiBase() ? new URL(apiBase()) : location;
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`;
};

export const net = {
  auth: null, // { token, recovery }
  user: null, // { id, name, rating, games, wins, ... }
  online: false, // el servidor responde
  syncing: false,
  lastSync: 0,
};

const readAuth = () => {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY));
  } catch {
    return null;
  }
};
const writeAuth = (auth) => {
  net.auth = auth;
  try {
    if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    /* sin almacenamiento */
  }
};

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  try {
    const res = await fetch(apiUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth && net.auth ? { Authorization: `Bearer ${net.auth.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    net.online = true;
    return { ok: res.ok, status: res.status, json };
  } catch {
    net.online = false;
    return { ok: false, status: 0, json: null };
  }
}

const listeners = new Set();
export const onNet = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(net));

async function createGuest() {
  const res = await api('/api/guest', { method: 'POST', body: {}, auth: false });
  if (!res.ok) return false;
  writeAuth({ token: res.json.token, recovery: res.json.recovery });
  net.user = res.json.user;
  return true;
}

// Crea o recupera la sesión. Devuelve true si hay servidor y sesión válida.
export async function bootstrap() {
  net.auth = readAuth();
  if (net.auth?.token) {
    const me = await api('/api/me');
    if (me.ok) net.user = me.json.user;
    else if (me.status === 401) writeAuth(null); // token caducado o servidor reiniciado sin base de datos
    else if (me.status === 0) {
      emit();
      return false;
    }
  }
  if (!net.user && !(await createGuest())) {
    emit();
    return false;
  }
  await syncDown();
  emit();
  return true;
}

export const ensureOnline = async () => (net.user ? true : bootstrap());

export async function refreshUser() {
  const me = await api('/api/me');
  if (me.ok) {
    net.user = me.json.user;
    emit();
  }
  return net.user;
}

export async function renameUser(name) {
  const res = await api('/api/me', { method: 'PATCH', body: { name } });
  if (res.ok) {
    net.user = res.json.user;
    emit();
  }
  return res;
}

export async function recoverAccount(code) {
  const res = await api('/api/recover', { method: 'POST', body: { code }, auth: false });
  if (!res.ok) return res;
  writeAuth({ token: res.json.token, recovery: code.toUpperCase() });
  net.user = res.json.user;
  state.cloud.rev = 0; // fuerza a comparar con el guardado de esa cuenta
  await syncDown(true);
  emit();
  return res;
}

export async function newRecoveryCode() {
  const res = await api('/api/me/recovery', { method: 'POST' });
  if (res.ok) writeAuth({ ...net.auth, recovery: res.json.recovery });
  return res;
}

// ----- Guardado en la nube -----
const cloudData = () => {
  const { cloud, ...rest } = state;
  return rest;
};

export async function syncDown(preferRemote = false) {
  if (!net.user) return;
  net.syncing = true;
  const res = await api('/api/save');
  net.syncing = false;
  if (!res.ok) return;
  const { data, updatedAt } = res.json;
  if (!data) {
    await pushNow();
    return;
  }
  if (state.cloud.rev === updatedAt) {
    // Misma revisión: si hubo cambios locales posteriores, se suben.
    if (state.updatedAt > updatedAt) await pushNow();
    return;
  }
  // Revisiones distintas (otro dispositivo o cuenta recuperada): manda el guardado con más progreso.
  const remoteWins = preferRemote || progressScore(data) >= progressScore(state);
  if (remoteWins) {
    replaceState(data, updatedAt);
    net.lastSync = Date.now();
  } else {
    await pushNow();
  }
}

export async function pushNow() {
  if (!net.user) return;
  const res = await api('/api/save', { method: 'PUT', body: { data: cloudData(), updatedAt: state.updatedAt } });
  if (res.ok) {
    state.cloud = { rev: res.json.updatedAt };
    net.lastSync = Date.now();
    save({ touch: false }); // guarda la revisión sin marcarla como cambio local (no dispara otra subida)
    emit();
  }
}

let pushTimer = null;
onChange(() => {
  if (!net.user || state.updatedAt <= state.cloud.rev) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 4000);
});
window.addEventListener('visibilitychange', () => {
  if (document.hidden && net.user && state.updatedAt > state.cloud.rev) pushNow();
});

// ----- WebSocket -----
export class Socket {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.wanted = false;
    this.room = null; // código de la sala actual (para reingresar tras reconectar)
    this.retry = 0;
    this.ready = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, msg) {
    this.handlers.get(type)?.forEach((fn) => fn(msg));
  }

  connect() {
    this.wanted = true;
    if (this.ws && this.ws.readyState <= 1 && this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      this.ws = ws;
      let authed = false;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: net.auth?.token }));
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'authed') {
          authed = true;
          this.retry = 0;
          net.user = { ...net.user, ...msg.user };
          this.emit('connection', { open: true });
          if (this.room) this.send({ t: 'join', code: this.room }); // reingreso tras corte
          resolve();
        }
        this.emit(msg.t, msg);
        this.emit('*', msg);
      };
      ws.onclose = () => {
        this.emit('connection', { open: false });
        if (!authed) reject(new Error('No se pudo conectar'));
        if (this.wanted) {
          const delay = Math.min(15000, 800 * 2 ** this.retry++);
          setTimeout(() => this.wanted && this.connect().catch(() => {}), delay);
        }
      };
      ws.onerror = () => {};
    });
    return this.ready;
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.wanted = false;
    this.room = null;
    this.ws?.close();
    this.ws = null;
    this.ready = null;
  }
}

export const socket = new Socket();
