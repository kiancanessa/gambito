// Entrar, crear cuenta y cerrar sesión (se carga a demanda).
//
// Las cuentas no llevan contraseña ni correo: cada cuenta tiene un código de recuperación (XXXX-XXXX-XXXX) que se muestra al crearla.
// «Entrar» es escribir ese código; «Crear cuenta» genera una cuenta nueva con el nombre público que elijas. Al cerrar sesión se
// recuerda guardar el código, porque es la única forma de volver a esa cuenta.
import { createAccount, logout, net, recoverAccount } from './net.js';
import { $, choice, copyText, esc, toast } from './ui.js';

const NAME_OK = /^[\p{L}\p{N} _.-]{3,16}$/u;
const reload = () => {
  history.replaceState(null, '', '/');
  location.reload(); // el estado de la sesión anterior (progreso, amigos, torneos) vive en varios módulos: se parte de cero
};

const errorBox = (msg = '') => `<p class="auth-err" id="authErr" role="alert" ${msg ? '' : 'hidden'}>${esc(msg)}</p>`;

function loginPane() {
  return `<form class="auth-form" data-auth-form="login" autocomplete="off">
      <label>Tu código de recuperación
        <input id="authCode" placeholder="XXXX-XXXX-XXXX" maxlength="14" autocapitalize="characters" spellcheck="false" aria-describedby="authHelp">
      </label>
      <p class="auth-help" id="authHelp">Lo viste al crear la cuenta y lo tienes en Perfil → Cuenta, en cualquier dispositivo donde ya estés dentro.</p>
      ${errorBox()}
      <button class="btn primary lg" type="submit" data-auth="login">Entrar</button>
    </form>`;
}

function createPane() {
  return `<form class="auth-form" data-auth-form="create" autocomplete="off">
      <label>Nombre público <small>(opcional)</small>
        <input id="authName" placeholder="Entre 3 y 16 letras o números" maxlength="16" spellcheck="false" aria-describedby="authHelp">
      </label>
      <p class="auth-help" id="authHelp">Es lo que verán los demás. No pedimos correo ni contraseña: al crear la cuenta te daremos un código para volver a entrar.</p>
      ${errorBox()}
      <button class="btn primary lg" type="submit" data-auth="create">Crear cuenta</button>
    </form>`;
}

/** Muestra el código de la cuenta recién creada y espera a que el jugador lo confirme. */
function codePane(user, code, note) {
  return `<div class="auth-done">
      <p class="eyebrow">Cuenta creada</p>
      <h3>Hola, ${esc(user.name)}</h3>
      ${note ? `<p class="auth-help">${esc(note)}</p>` : ''}
      <p class="auth-help">Este es tu código de recuperación. Guárdalo: es la única forma de volver a esta cuenta desde otro dispositivo o después de cerrar sesión.</p>
      <p class="auth-code"><code id="authShownCode">${esc(code)}</code><button class="btn" type="button" data-auth="copy">Copiar</button></p>
      <button class="btn primary lg" type="button" data-auth="done">Ya lo he guardado</button>
    </div>`;
}

/**
 * Diálogo de entrar / crear cuenta. Resuelve `true` si el jugador acaba con sesión (la página se recarga) y `false` si lo cierra.
 * `mode`: pestaña inicial ('login' | 'create').
 */
export function openAuth({ mode = 'login', title = 'Entra a CHECKPOINT' } = {}) {
  let tab = mode;
  let resolveLogged = false;
  const shell = () => `<h3>${esc(title)}</h3>
    <div class="seg auth-tabs" role="tablist" aria-label="Cuenta">
      <button type="button" role="tab" data-auth-tab="login" aria-selected="${tab === 'login'}" class="${tab === 'login' ? 'on' : ''}">Entrar</button>
      <button type="button" role="tab" data-auth-tab="create" aria-selected="${tab === 'create'}" class="${tab === 'create' ? 'on' : ''}">Crear cuenta</button>
    </div>
    <div id="authPane">${tab === 'login' ? loginPane() : createPane()}</div>
    <p class="auth-foot"><button class="btn ghost" data-choice="close" type="button">Seguir sin cuenta</button></p>`;

  const done = choice(shell(), 'auth-card');
  const card = $('#modalCard');
  const off = new AbortController();
  const showError = (msg) => {
    const box = $('#authErr');
    if (!box) return;
    box.textContent = msg;
    box.hidden = !msg;
  };
  const busy = (btn, on, label) => {
    btn.disabled = on;
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    if (label) btn.textContent = label;
  };

  card.addEventListener(
    'click',
    (e) => {
      const t = e.target.closest('[data-auth-tab]');
      if (t) {
        tab = t.dataset.authTab;
        card.innerHTML = shell();
        $(tab === 'login' ? '#authCode' : '#authName')?.focus();
        return;
      }
      if (e.target.closest('[data-auth="copy"]')) {
        copyText($('#authShownCode').textContent).then((ok) => toast(ok ? 'Código copiado' : 'No se pudo copiar: selecciónalo a mano'));
        return;
      }
      if (e.target.closest('[data-auth="done"]')) {
        resolveLogged = true;
        reload();
      }
    },
    { signal: off.signal },
  );

  card.addEventListener(
    'submit',
    async (e) => {
      e.preventDefault();
      const form = e.target.closest('[data-auth-form]');
      if (!form) return;
      const btn = form.querySelector('button[type="submit"]');
      showError('');
      if (form.dataset.authForm === 'login') {
        const code = $('#authCode').value.trim();
        if (code.replace(/[^A-Za-z0-9]/g, '').length !== 12) return showError('El código tiene 12 caracteres: XXXX-XXXX-XXXX.');
        busy(btn, true, 'Entrando…');
        const res = await recoverAccount(code);
        if (!res.ok) {
          busy(btn, false, 'Entrar');
          return showError(res.status === 0 ? 'No hay conexión con el servidor. Inténtalo de nuevo.' : res.status === 429 ? 'Demasiados intentos: espera unos minutos.' : 'Ese código no corresponde a ninguna cuenta.');
        }
        resolveLogged = true;
        return reload();
      }
      const wanted = $('#authName').value.trim();
      if (wanted && !NAME_OK.test(wanted)) return showError('El nombre debe tener entre 3 y 16 letras, números, espacios, «.», «_» o «-».');
      busy(btn, true, 'Creando…');
      const res = await createAccount(wanted);
      if (!res.ok) {
        busy(btn, false, 'Crear cuenta');
        return showError(res.status === 0 ? 'No hay conexión con el servidor. Inténtalo de nuevo.' : res.status === 429 ? 'Demasiadas cuentas nuevas desde esta red: espera un rato.' : 'No se pudo crear la cuenta.');
      }
      // El servidor puede rechazar un nombre (palabras no permitidas) y asignar uno automático: se avisa.
      const note = wanted && res.json.user.name !== wanted ? `Ese nombre no está permitido, así que te hemos asignado «${res.json.user.name}». Puedes cambiarlo en tu perfil.` : '';
      $('#authPane').innerHTML = codePane(res.json.user, res.json.recovery, note);
      card.querySelector('h3').hidden = true;
      card.querySelector('.auth-tabs').hidden = true;
      card.querySelector('.auth-foot').hidden = true;
      return undefined;
    },
    { signal: off.signal },
  );

  $(tab === 'login' ? '#authCode' : '#authName')?.focus();
  return done.then(() => {
    off.abort();
    return resolveLogged;
  });
}

/** Cierra la sesión tras avisar de que el código de recuperación es la única forma de volver. */
export async function confirmLogout() {
  const code = net.auth?.recovery;
  const html = `<h3>¿Cerrar sesión?</h3>
    <p class="muted">Tu cuenta y tu progreso se quedan guardados en el servidor. Para volver a entrar necesitarás tu código de recuperación${code ? ':' : '.'}</p>
    ${code ? `<p class="auth-code"><code id="authShownCode">${esc(code)}</code><button class="btn" type="button" data-auth="copy">Copiar</button></p>` : ''}
    <div class="modal-actions"><button class="btn" data-choice="no">Cancelar</button><button class="btn danger" data-choice="yes">Cerrar sesión</button></div>`;
  const pending = choice(html, 'auth-card');
  const off = new AbortController();
  $('#modalCard').addEventListener(
    'click',
    (e) => {
      if (!e.target.closest('[data-auth="copy"]')) return;
      copyText($('#authShownCode').textContent).then((ok) => toast(ok ? 'Código copiado' : 'No se pudo copiar: selecciónalo a mano'));
    },
    { signal: off.signal },
  );
  const answer = await pending;
  off.abort();
  if (answer !== 'yes') return false;
  await logout();
  reload();
  return true;
}
