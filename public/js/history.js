// Historial y repeticiones: tus últimas partidas online, con filtro por resultado y acceso al visor 3D.
import { api, ensureOnline, net } from './net.js';
import { historyHtml, openReplay } from './replay.js';
import { $, $$, app, showScreen } from './ui.js';

let games = [];
let filter = 'all';
let loaded = false;

function paint() {
  $$('#historyFilter button').forEach((b) => b.classList.toggle('on', b.dataset.hf === filter));
  const body = $('#historyBody');
  if (!net.user) {
    body.innerHTML = '<section class="lb-card"><p class="eyebrow">Sin conexión</p><h3>No se pudo cargar tu historial</h3><p class="muted">Las partidas online se guardan en el servidor para poder repetirlas.</p><button class="btn primary" data-hs="retry">Reintentar</button></section>';
    return;
  }
  const w = games.filter((g) => g.result === 'win').length;
  const l = games.filter((g) => g.result === 'loss').length;
  const d = games.length - w - l;
  const shown = filter === 'all' ? games : games.filter((g) => g.result === filter);
  body.innerHTML = `<div class="history-layout">
    <section class="lb-card">
      <div class="card-head"><p class="eyebrow">${games.length === 1 ? 'Tu última partida' : `Tus últimas ${games.length} partidas`}</p><span class="pill">${w}V · ${d}T · ${l}D</span></div>
      ${shown.length
        ? `<ul class="live-list history-list">${historyHtml(shown)}</ul>`
        : `<p class="muted">${loaded && !games.length ? 'Aún no has jugado partidas online. Cuando termines una, podrás verla aquí paso a paso, compartirla o grabar un clip.' : 'No hay partidas con este filtro.'}</p>`}
      ${loaded && !games.length ? '<button class="btn primary" data-go="lobby">Jugar ahora</button>' : ''}
    </section>
    <aside class="lb-card"><p class="eyebrow">Cómo funciona</p>
      <p class="muted">Pulsa <b>Ver</b> para abrir la repetición en el tablero 3D: reproducción automática, saltos, velocidad y un clip para compartir.</p>
      <p class="muted">Solo tú y tu rival podéis ver cada partida.</p></aside></div>`;
}

export async function enterHistory() {
  showScreen('history');
  paint();
  if (!(await ensureOnline())) return paint();
  const res = await api('/api/me/games?limit=50');
  if (res.ok) {
    games = res.json.games;
    loaded = true;
  }
  if (app.screen === 'history') paint();
  return undefined;
}

export function initHistory() {
  $('#historyFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hf]');
    if (!b) return;
    filter = b.dataset.hf;
    paint();
  });
  $('#historyBody').addEventListener('click', (e) => {
    const r = e.target.closest('[data-replay]');
    if (r) return openReplay(r.dataset.replay);
    if (e.target.closest('[data-hs="retry"]')) return enterHistory();
    return undefined;
  });
}
