// Perfil: nombre, liga, código de recuperación, sincronización e instalación como app.
import { LEAGUES, GLYPH, leagueOf } from './data.js';
import { net, newRecoveryCode, onNet, recoverAccount, renameUser, syncDown, pushNow } from './net.js';
import { state } from './store.js';
import { $, app, avatar, closeModal, copyText, esc, toast, VS } from './ui.js';

const ago = (t) => {
  if (!t) return 'aún no';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'hace un momento' : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`;
};

function html() {
  const u = net.user;
  const lg = leagueOf(u.rating);
  return `<div class="profile-modal">
    <div class="pf-head">${avatar(lg.glyph, lg.color)}<div><b>${esc(u.name)}</b><small>Liga ${lg.name} · ${u.rating} pts</small></div></div>
    <div class="pf-stats"><span><b>${u.wins}</b>victorias</span><span><b>${u.losses}</b>derrotas</span><span><b>${u.draws}</b>tablas</span></div>
    <label class="pf-field">Nombre público
      <span class="pf-row"><input id="pfName" value="${esc(u.name)}" maxlength="16" autocomplete="off"><button class="btn primary" data-pf="rename">Guardar</button></span>
    </label>
    <div class="pf-field">Código de recuperación
      <span class="pf-row"><code id="pfCode">${esc(net.auth?.recovery ?? '—')}</code><button class="btn" data-pf="copy">Copiar</button></span>
      <small class="muted">Guárdalo: con él recuperas tu cuenta y tu progreso en otro dispositivo.</small>
      <button class="link-btn" data-pf="regen">Generar un código nuevo</button>
    </div>
    <div class="pf-field">Usar otra cuenta
      <span class="pf-row"><input id="pfRecover" placeholder="XXXX-XXXX-XXXX" maxlength="14" autocomplete="off"><button class="btn" data-pf="recover">Recuperar</button></span>
    </div>
    <p class="muted pf-sync">☁ Progreso sincronizado: ${ago(net.lastSync)} · <button class="link-btn" data-pf="sync">Sincronizar ahora</button></p>
    <div class="modal-actions"><button class="btn" data-choice="close">Cerrar</button></div>
  </div>`;
}

export async function openProfile() {
  if (!net.user) return toast('Conéctate al servidor para ver tu perfil');
  const modal = $('#modal');
  const card = $('#modalCard');
  card.className = 'modal-card profile-card';
  card.innerHTML = html();
  modal.hidden = false;
  const close = () => {
    card.removeEventListener('click', onClick);
    modal.hidden = true;
  };
  async function onClick(e) {
    if (e.target.closest('[data-choice]')) return close();
    const b = e.target.closest('[data-pf]');
    if (!b) return;
    const act = b.dataset.pf;
    if (act === 'rename') {
      const res = await renameUser($('#pfName').value);
      toast(res.ok ? '✓ Nombre actualizado' : res.json?.error ?? 'No se pudo cambiar el nombre');
    } else if (act === 'copy') {
      toast((await copyText(net.auth?.recovery ?? '')) ? '📋 Código copiado' : 'No se pudo copiar');
    } else if (act === 'regen') {
      const res = await newRecoveryCode();
      toast(res.ok ? 'Nuevo código generado: guárdalo' : 'No se pudo generar');
    } else if (act === 'recover') {
      const code = $('#pfRecover').value.trim();
      if (code.replace(/[^A-Za-z0-9]/g, '').length !== 12) return toast('El código tiene 12 caracteres (XXXX-XXXX-XXXX)');
      const res = await recoverAccount(code);
      toast(res.ok ? `✓ Sesión de ${res.json.user.name} recuperada` : res.json?.error ?? 'No se pudo recuperar');
      if (res.ok) {
        close();
        app.refreshHome();
        return;
      }
    } else if (act === 'sync') {
      await pushNow();
      await syncDown();
      toast('☁ Sincronizado');
    }
    card.innerHTML = html();
  }
  card.addEventListener('click', onClick);
}

export function initProfile() {
  $('#profileChip').addEventListener('click', openProfile);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open="profile"]')) openProfile();
  });
  onNet(() => {
    const chip = $('#profileChip');
    chip.hidden = !net.user;
    if (net.user) {
      const lg = leagueOf(net.user.rating);
      $('#profileGlyph').textContent = GLYPH[lg.glyph] + VS;
      $('#profileGlyph').style.color = lg.color;
      $('#profileName').textContent = net.user.name;
    }
  });

  // Instalación como app (PWA).
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#installBtn').hidden = true;
  });
  void state;
  void LEAGUES;
  void closeModal;
}
