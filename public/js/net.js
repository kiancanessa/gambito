// Conexión con el servidor: cuenta de invitado, guardado en la nube y WebSocket de partidas.
import { onChange, progressScore, replaceState, save, state } from './store.js';

const AUTH_KEY = 'gambito.auth.v1';
const LOGOUT_KEY = 'gambito.loggedout.v1'; // «1» = el jugador cerró la sesión a propósito: no se crea una cuenta sola
const WELCOMED_KEY = 'gambito.welcomed.v1'; // «1» = ya eligió cómo entrar alguna vez (si no, quien llega nuevo ve la bienvenida)
const GUEST_KEY = 'gambito.guest.v1'; // «1» = juega como invitado (cuenta creada sin elegir nombre ni guardar el código)

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
  booted: false, // ya se intentó conectar al menos una vez (para no mostrar "sin conexión" mientras se conecta)
  loggedOut: false, // sin sesión (nuevo o cerrada a propósito): hay que entrar, crear una cuenta o jugar como invitado
  firstVisit: false, // nunca ha elegido cómo entrar en este dispositivo
  guest: false, // juega como invitado: puede reclamar la cuenta con nombre y código en cualquier momento
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
    if (auth) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      localStorage.setItem(WELCOMED_KEY, '1');
      localStorage.removeItem(LOGOUT_KEY);
    } else localStorage.removeItem(AUTH_KEY);
  } catch {
    /* sin almacenamiento */
  }
  if (auth) net.loggedOut = false;
};
const setLoggedOut = (on) => {
  net.loggedOut = on;
  try {
    if (on) localStorage.setItem(LOGOUT_KEY, '1');
    else localStorage.removeItem(LOGOUT_KEY);
  } catch {
    /* sin almacenamiento */
  }
};
const setGuest = (on) => {
  net.guest = on;
  try {
    if (on) localStorage.setItem(GUEST_KEY, '1');
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* sin almacenamiento */
  }
};
try {
  const hasAuth = !!localStorage.getItem(AUTH_KEY);
  // Quien llega por primera vez (sin cuenta y sin haber elegido nunca) ve la bienvenida; no se le crea una cuenta sin preguntar.
  net.loggedOut = !hasAuth && (localStorage.getItem(LOGOUT_KEY) === '1' || localStorage.getItem(WELCOMED_KEY) !== '1');
  net.firstVisit = net.loggedOut && localStorage.getItem(LOGOUT_KEY) !== '1' && localStorage.getItem(WELCOMED_KEY) !== '1';
  net.guest = hasAuth && localStorage.getItem(GUEST_KEY) === '1';
} catch {
  /* sin almacenamiento */
}

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
// Se ejecutan tras conectar y sincronizar el guardado (p. ej. la cartera del servidor).
const readyHooks = new Set();
export const onReady = (fn) => readyHooks.add(fn);
const emit = () => listeners.forEach((fn) => fn(net));

async function createGuest(name, { guest = !name } = {}) {
  const res = await api('/api/guest', { method: 'POST', body: name ? { name } : {}, auth: false });
  if (!res.ok) return res;
  writeAuth({ token: res.json.token, recovery: res.json.recovery });
  setGuest(guest);
  net.user = res.json.user;
  return res;
}

// Crea o recupera la sesión. Devuelve true si hay servidor y sesión válida.
export async function bootstrap() {
  try {
    return await connectSession();
  } finally {
    net.booted = true;
    emit();
  }
}

async function connectSession() {
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
  // Quien cerró la sesión a propósito decide si entra o crea una cuenta: no se le crea una invitada por detrás.
  if (!net.user && net.loggedOut) {
    emit();
    return false;
  }
  if (!net.user && !(await createGuest()).ok) {
    emit();
    return false;
  }
  await syncDown();
  for (const fn of readyHooks) await fn();
  emit();
  return true;
}

// Con sesión cerrada se abre el diálogo de entrar / crear cuenta; devuelve true si acaba con sesión.
export async function ensureOnline() {
  if (net.user) return true;
  if (net.loggedOut) return (await import('./auth.js')).openAuth();
  return bootstrap();
}

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
  const flat = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  setGuest(false);
  writeAuth({ token: res.json.token, recovery: flat.length === 12 ? `${flat.slice(0, 4)}-${flat.slice(4, 8)}-${flat.slice(8)}` : flat }); // siempre con el formato XXXX-XXXX-XXXX
  net.user = res.json.user;
  state.cloud.rev = 0; // fuerza a comparar con el guardado de esa cuenta
  await syncDown(true);
  emit();
  return res;
}

// Crea una cuenta nueva (con el nombre elegido, si lo hay) y devuelve su código de recuperación para que el jugador lo guarde.
export async function createAccount(name) {
  const res = await createGuest(name, { guest: false });
  if (res.ok) emit();
  return res;
}

// «Jugar como invitado»: cuenta sin nombre elegido (el nombre es automático). Puede reclamarla después con `claimAccount`.
export async function createGuestAccount() {
  const res = await createGuest('', { guest: true });
  if (res.ok) emit();
  return res;
}

// Convierte la cuenta de invitado en una cuenta propia: nombre público elegido y código de recuperación guardado.
export async function claimAccount(name) {
  if (name) {
    const res = await renameUser(name);
    if (!res.ok) return res;
  }
  setGuest(false);
  emit();
  return { ok: true, status: 200, json: { user: net.user, recovery: net.auth?.recovery } };
}

// Antes de salir de una cuenta, los módulos con datos pendientes (la cartera) los envían y vacían su cola local.
const leaveHooks = new Set();
export const onLeave = (fn) => leaveHooks.add(fn);

// Cierra la sesión: sube lo pendiente, olvida la cuenta en este dispositivo y deja el progreso local limpio, para que la siguiente
// cuenta (otra persona, o la misma desde su código) no herede nada de esta. La cuenta sigue existiendo en el servidor.
export async function logout() {
  for (const fn of leaveHooks) await Promise.resolve(fn()).catch(() => {});
  if (net.user && state.updatedAt > state.cloud.rev) await pushNow();
  socket.close();
  writeAuth(null);
  setGuest(false);
  net.user = null;
  setLoggedOut(true);
  replaceState({}, 0);
  emit();
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

  // Abre el socket. Si el servidor no reconoce la sesión (p. ej. perdió su base de datos tras un reinicio) se crea una
  // cuenta nueva con `bootstrap()` y se reintenta una vez, en vez de quedarse esperando para siempre.
  async connect() {
    this.wanted = true;
    try {
      return await this.open();
    } catch (err) {
      if (err.code !== 'auth') throw err;
      writeAuth(null);
      net.user = null;
      if (!(await bootstrap())) throw err;
      return this.open();
    }
  }

  open() {
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
        if (msg.t === 'error' && msg.code === 'auth' && !authed) {
          this.ready = null;
          ws.close();
          reject(Object.assign(new Error('Sesión no válida'), { code: 'auth' }));
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
