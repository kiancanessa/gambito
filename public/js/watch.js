// Espectar (se carga a demanda): partidas públicas en directo, repeticiones de partidas públicas terminadas y torneos.
// Solo lectura: quien mira no puede mover, rendirse ni enviar nada a los jugadores; el servidor lo rechaza. En el Circuit la
// retransmisión lleva un retraso configurable (por defecto 20 s) para que nadie pueda ayudar en directo a un jugador.
import { GLYPH, leagueOf } from './data.js';
import { api } from './net.js';
import { joinRoom } from './online.js';
import { openReplay, tcName } from './replay.js';
import { $, app, copyText, esc, showScreen, toast, VS } from './ui.js';

const POLL_MS = 10_000;
const ws = { live: null, games: null, tournaments: null, error: false, timer: null, wired: false };
const glyph = (g, color) => `<span class="lg" style="color:${color}">${GLYPH[g]}${VS}</span>`;
const date = (t) => new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function load() {
  const [live, games, circuit] = await Promise.all([api('/api/live', { auth: false }), api('/api/public/games?limit=12', { auth: false }), api('/api/circuit', { auth: false })]);
  ws.error = !(live.ok || games.ok || circuit.ok);
  if (live.ok) ws.live = live.json.games;
  if (games.ok) ws.games = games.json.games;
  if (circuit.ok) ws.tournaments = circuit.json.tournaments.filter((t) => t.status === 'running' || t.status === 'open' || t.status === 'scheduled' || t.status === 'closed');
  if (app.screen === 'watch') render();
}

function liveRow(g) {
  const w = leagueOf(g.w.rating);
  const b = leagueOf(g.b.rating);
  const badge = g.kind === 'circuit' ? `<span class="pill live">🏆 ${esc(g.circuit?.tournament ?? 'Circuit')} · ${esc(g.circuit?.label ?? '')}</span>` : '<span class="pill">Clasificatoria</span>';
  const delay = g.delayMs ? `<small class="muted">⏱ retransmisión con ${Math.round(g.delayMs / 1000)} s de retraso</small>` : '<small class="muted">en directo</small>';
  return `<li><div class="vs">${glyph(w.glyph, w.color)}<b>${esc(g.w.name)}</b><em>${g.w.rating}</em><span class="x">vs</span>${glyph(b.glyph, b.color)}<b>${esc(g.b.name)}</b><em>${g.b.rating}</em></div>
    <div class="wt-meta">${badge}<small class="muted">${esc(tcName(g.tc))} · ${Math.ceil(g.moves / 2)} jugadas${g.spectators ? ` · 👀 ${g.spectators}` : ''}</small>${delay}</div>
    <button class="btn primary" data-wt="watch" data-code="${esc(g.code)}">👀 Ver</button></li>`;
}

function doneRow(g) {
  const res = g.winner === 'w' ? `${esc(g.white.name)} ganó` : g.winner === 'b' ? `${esc(g.black.name)} ganó` : 'Tablas';
  return `<li><div class="vs"><b>${esc(g.white.name)}</b><span class="x">vs</span><b>${esc(g.black.name)}</b></div>
    <div class="wt-meta"><span class="pill ${g.kind === 'circuit' ? 'live' : ''}">${g.kind === 'circuit' ? '🏆 Torneo' : 'Clasificatoria'}</span><small class="muted">${res} · ${esc(g.reason ?? '')} · ${esc(tcName(g.tc))} · ${date(g.at)}</small></div>
    <span class="row-actions"><button class="btn primary" data-wt="replay" data-id="${esc(g.id)}">▶ Repetir</button><button class="btn" data-wt="copy" data-path="/r/${esc(g.id)}" aria-label="Copiar enlace de la repetición">🔗</button></span></li>`;
}

function tournamentRow(t) {
  const status = { running: 'En curso', open: 'Inscripción abierta', scheduled: 'Programado', closed: 'Inscripción cerrada' }[t.status];
  return `<li><div><b>${esc(t.name)}</b>${t.community ? ` <span class="pill soon">Comunidad · ${esc(t.organizer?.name ?? '')}</span>` : ''}<small class="muted">${esc(status)} · ${t.players}/${t.size} jugadores${t.live ? ` · ${t.live} en directo` : ''}</small></div>
    <span class="row-actions"><button class="btn" data-wt="tournament" data-id="${esc(t.id)}">Ver torneo</button></span></li>`;
}

function render() {
  const body = $('#watchBody');
  if (!body) return;
  if (ws.error && !ws.live) {
    body.innerHTML = '<section class="lb-card" role="alert"><p class="eyebrow">Sin conexión</p><h3>No se pudo cargar</h3><p class="muted">Para ver partidas en directo hace falta el servidor.</p><button class="btn primary" data-wt="retry">Reintentar</button></section>';
    return;
  }
  const live = ws.live ?? [];
  const circuitLive = live.filter((g) => g.kind === 'circuit');
  const ranked = live.filter((g) => g.kind !== 'circuit');
  const section = (title, hint, rows, empty) => `<section class="lb-card"><div class="card-head"><p class="eyebrow">${title}</p></div>${hint ? `<p class="muted">${hint}</p>` : ''}${rows ? `<ul class="live-list wt-list">${rows}</ul>` : `<p class="muted">${empty}</p>`}</section>`;
  body.innerHTML = `
    <section class="lb-card wt-note"><p class="eyebrow">👀 Modo espectador</p><p class="muted">Ves el tablero, los relojes y el estado de la partida. Es solo lectura: no puedes mover ni intervenir. En los torneos la imagen llega con unos segundos de retraso para proteger a los jugadores.</p></section>
    ${section('<i class="dot live"></i> Torneos en directo', '', circuitLive.map(liveRow).join(''), 'Ahora mismo no hay partidas de torneo en juego.')}
    ${section('<i class="dot live"></i> Clasificatorias en directo', '', ranked.map(liveRow).join(''), 'No hay clasificatorias en curso. Las partidas con amigos son privadas por enlace.')}
    ${section('Torneos', 'Consulta cuadros, participantes y resultados.', (ws.tournaments ?? []).map(tournamentRow).join(''), 'No hay torneos activos o programados ahora mismo.')}
    ${section('Partidas públicas terminadas', 'Repite cualquier clasificatoria o partida de torneo.', (ws.games ?? []).map(doneRow).join(''), 'Todavía no hay partidas públicas terminadas.')}`;
}

export async function enterWatch() {
  showScreen('watch');
  render();
  if (!ws.wired) {
    ws.wired = true;
    $('#screen-watch').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-wt]');
      if (!b) return undefined;
      const a = b.dataset.wt;
      if (a === 'retry') return load();
      if (a === 'watch') return joinRoom(b.dataset.code);
      if (a === 'replay') return openReplay(b.dataset.id, { publicGame: true });
      if (a === 'tournament') return app.openCircuit?.(b.dataset.id);
      if (a === 'copy') {
        await copyText(`${location.origin}${b.dataset.path}`);
        return toast('🔗 Enlace copiado');
      }
      return undefined;
    });
  }
  await load();
  clearInterval(ws.timer);
  ws.timer = setInterval(() => (app.screen === 'watch' ? load() : clearInterval(ws.timer)), POLL_MS);
}

// Enlace compartido de una repetición (/r/ID).
export const openPublicReplay = (id, ply = null) => openReplay(id, { publicGame: true, ply });
