// Royale Circuit (flag `circuit`): torneos eliminatorios programados por el servidor.
// El servidor lleva el cuadro, los plazos y los resultados; aquí solo se pide inscribirse o salir, se mira el torneo
// en tiempo real (`circuit_list` / `circuit_state` por WebSocket), se entra a la partida propia (`circuit_match`)
// y se cobran los premios por la cartera verificada. El cliente nunca declara resultados.
import { TIME_CONTROLS } from './data.js';
import { flags } from './flags.js';
import { api, ensureOnline, net, socket } from './net.js';
import { joinRoom } from './online.js';
import { queueOp } from './store.js';
import { $, app, choice, confirmModal, copyText, esc, onScreen, showScreen, toast } from './ui.js';

const CLAIMED_KEY = 'gambito.circuit.claimed';
const STATUS = {
  scheduled: ['Programado', 'soon'],
  open: ['Inscripción abierta', 'todo'],
  closed: ['Inscripción cerrada', 'soon'],
  running: ['En curso', 'live'],
  finished: ['Finalizado', 'ok'],
  cancelled: ['Cancelado', 'bad'],
};
const MATCH = { pending: 'Pendiente', ready: 'Listo', playing: 'En juego', done: 'Finalizada' };
const PLACE_TEXT = {
  r32: 'Eliminado en dieciseisavos',
  r16: 'Eliminado en octavos',
  quarter: 'Eliminado en cuartos',
  semi: 'Eliminado en semifinales',
  final: 'Subcampeón',
  champion: '¡Campeón del Circuit!',
};
const PRIZE_ROWS = [['Octavos', 'r16'], ['Cuartos', 'quarter'], ['Semifinal', 'semi'], ['Final', 'final'], ['Campeón', 'champion']];

const cs = { list: null, detail: null, id: null, offset: 0, timer: null, claiming: false, watching: false, offline: false };
const subscribers = new Set();
export const onCircuit = (fn) => subscribers.add(fn);
const changed = () => subscribers.forEach((fn) => fn());

// Hora del servidor: las cuentas atrás no dependen del reloj del dispositivo.
const serverNow = () => Date.now() + cs.offset;
const syncClock = (now) => {
  if (Number.isFinite(now)) cs.offset = now - Date.now();
};
export const circuitClock = serverNow;

const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const countdown = (until) => `<b class="cd" data-until="${until}">${clock(until - serverNow())}</b>`;
const hhmm = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const shortDate = (ts) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
const tcLabel = (id) => {
  const t = TIME_CONTROLS.find((x) => x.id === id);
  return t ? `${t.label} ${t.sub}` : id;
};
const prizeText = (p) => (p ? `🪙 ${p.coins}${p.item ? ' + 👑 Corona del Circuit' : ''}` : '');
const pill = (status) => `<span class="pill ${STATUS[status][1]}">${STATUS[status][0]}</span>`;

const readClaimed = () => {
  try {
    return JSON.parse(localStorage.getItem(CLAIMED_KEY)) ?? [];
  } catch {
    return [];
  }
};
const markClaimed = (id) => {
  try {
    localStorage.setItem(CLAIMED_KEY, JSON.stringify([...readClaimed(), id].slice(-50)));
  } catch {
    /* sin almacenamiento */
  }
};

// ---------- Datos ----------
async function connect() {
  if (!(await ensureOnline())) {
    cs.offline = true;
    return false;
  }
  try {
    await socket.connect();
    cs.offline = false;
    return true;
  } catch {
    cs.offline = true;
    return false;
  }
}

// Premios pendientes: se cobran con la cartera del servidor (idempotente: una sola vez por torneo).
export async function claimPrizes() {
  if (cs.claiming || !net.user || !flags.wallet) return;
  cs.claiming = true;
  try {
    const res = await api('/api/circuit/me');
    if (!res.ok) return;
    const done = readClaimed();
    for (const r of res.json.results) {
      if (done.includes(r.id)) continue;
      queueOp({ t: 'earn', source: 'circuit', key: `circuit:${r.id}` });
      markClaimed(r.id);
      toast(`🏆 Premio del Circuit: +${r.coins} 🪙${r.item ? ' y la Corona del Circuit' : ''}`, 5000);
    }
  } finally {
    cs.claiming = false;
  }
}

export async function refreshCircuitPublic() {
  const res = await api('/api/circuit');
  if (res.ok) {
    cs.list = res.json;
    syncClock(res.json.now);
    changed();
    if (app.screen === 'circuit') render();
  }
  return cs.list;
}

async function loadDetail(id) {
  const res = await api(`/api/circuit/t/${encodeURIComponent(id)}`);
  if (res.ok && cs.id === id) {
    cs.detail = res.json;
    syncClock(res.json.now);
  } else if (!res.ok && cs.id === id) {
    cs.id = null;
    cs.detail = null;
    toast('Ese torneo ya no está disponible');
  }
  if (app.screen === 'circuit') render();
}

function watch() {
  cs.watching = true;
  socket.send({ t: 'circuit_watch', id: cs.id });
}

// Resumen para el lobby: qué torneo mostrar en el HUD.
export function circuitHud() {
  const l = cs.list;
  if (!l) return { kind: 'unknown' };
  const mine = l.tournaments.find((t) => t.id === l.mine);
  if (mine) return { kind: mine.status === 'running' ? 'playing' : 'joined', t: mine };
  const open = l.tournaments.find((t) => t.status === 'open');
  if (open) return { kind: 'open', t: open };
  const next = l.tournaments.find((t) => t.status === 'scheduled' || t.status === 'closed');
  if (next) return { kind: 'next', t: next };
  const running = l.tournaments.filter((t) => t.status === 'running');
  if (running.length) return { kind: 'running', running };
  return { kind: 'idle' };
}
export const circuitList = () => cs.list;

// Abre el Circuit en un torneo concreto (o en la lista) desde otras pantallas.
export function openCircuit(id = null) {
  cs.id = id;
  cs.detail = null;
  return app.go('circuit');
}

// El lobby escucha la lista de torneos en tiempo real mientras está abierto.
export async function watchCircuitList() {
  if (!(await connect())) return;
  cs.id = null;
  watch();
}

// ---------- Interfaz ----------
const entrantRow = (e, mine) => `<li class="${e.id === mine ? 'me' : ''}"><b>${e.seed ? `<i>${e.seed}</i> ` : ''}${esc(e.name)}</b>${e.rating ? `<em>${e.rating}</em>` : ''}</li>`;

function timeLine(t) {
  const at = hhmm(t.startsAt);
  switch (t.status) {
    case 'scheduled':
      return `Abre la inscripción en ${countdown(t.regOpensAt)} · empieza a las ${at}`;
    case 'open':
      return `Inscripción abierta: cierra en ${countdown(t.regClosesAt)} · empieza a las ${at}`;
    case 'closed':
      return `Empieza en ${countdown(t.startsAt)}`;
    case 'running':
      return `${t.roundName ?? 'En juego'}${t.live ? ` · ${t.live} partida${t.live > 1 ? 's' : ''} en directo` : ''}`;
    case 'finished':
      return `Terminó el ${shortDate(t.finishedAt)} · campeón: <b>${esc(t.champion?.name ?? '—')}</b>`;
    default:
      return esc(t.cancelReason ?? 'Cancelado');
  }
}

const communityBadge = (t) => (t.community ? `<span class="pill soon" title="Torneo de la comunidad: sin premios ni XP">Comunidad · ${esc(t.organizer?.name ?? '')}</span>` : '');

function card(t, joined, mine, featured = false) {
  const open = t.status === 'open';
  let cta = `<button class="btn" data-cir-open="${esc(t.id)}">Ver torneo</button>`;
  if (open && joined) cta = `<button class="btn danger" data-cir="leave" data-id="${esc(t.id)}">Cancelar inscripción</button>${cta}`;
  else if (open && mine) cta = `<button class="btn" disabled title="Ya estás en otro torneo del Circuit">Ya estás en otro torneo</button>${cta}`;
  else if (open) cta = `<button class="btn ${featured ? 'primary' : ''}" data-cir="join" data-id="${esc(t.id)}">Inscribirme</button>${cta}`;
  return `<article class="cir-card ${t.status} ${joined ? 'joined' : ''} ${featured ? 'cir-feature' : ''}">
    ${featured ? '<p class="cir-kicker">Torneo destacado</p>' : ''}
    <div class="card-head"><p class="eyebrow">${esc(t.name)} · ${esc(tcLabel(t.tc))}</p>${pill(t.status)}</div>
    <h3>Eliminatoria de hasta ${t.size} ${communityBadge(t)}</h3>
    ${t.description ? `<p class="muted">${esc(t.description)}</p>` : ''}
    <ul class="cir-facts"><li>👥 <b>${t.players}/${t.size}</b> inscritos <small>(mínimo ${t.minPlayers})</small></li><li>⏱ ${timeLine(t)}</li>${joined ? '<li class="ok">✔ Estás inscrito</li>' : ''}</ul>
    <div class="cir-actions">${cta}</div></article>`;
}

function hero() {
  return `<section class="lb-card circuit-hero"><p class="eyebrow">Cómo funciona</p>
    <p class="muted">Eliminación simple: pierdes una partida y quedas fuera. El servidor programa los torneos, valida cada resultado y reparte los premios. La Corona del Circuit es un set de piezas que no se vende en la tienda y nunca da ventaja de juego.</p>
    <ul class="prize-row"><li>Cuartos <b>🪙 30</b></li><li>Semifinal <b>🪙 60</b></li><li>Final <b>🪙 120</b></li><li class="top">Campeón <b>🪙 250 + 👑</b></li></ul></section>`;
}

// El torneo que más te importa ahora (en el que estás, o el que tiene la inscripción abierta) va primero y en grande;
// el resto, compactos; cómo funciona y los premios, después.
function featuredOf(l) {
  return l.tournaments.find((t) => t.id === l.mine) ?? l.tournaments.find((t) => t.status === 'open') ?? l.tournaments.find((t) => t.status === 'running') ?? l.tournaments[0] ?? null;
}

function renderList() {
  const l = cs.list;
  if (!l) return '<section class="lb-card" aria-busy="true"><p class="muted">Cargando torneos…</p></section>';
  const top = featuredOf(l);
  const others = l.tournaments.filter((t) => t !== top).map((t) => card(t, t.joined, l.mine && l.mine !== t.id)).join('');
  const recent = l.recent
    .map((r) => `<li><button class="link-row" data-cir-open="${esc(r.id)}"><b>${esc(r.name)}</b>${r.community ? ` <span class="pill soon">Comunidad · ${esc(r.organizer ?? '')}</span>` : ''}<small class="muted">${shortDate(r.finishedAt)} · ${r.status === 'cancelled' ? esc(r.cancelReason ?? 'Cancelado') : `👑 ${esc(r.champion ?? '—')} · ${r.players} jugadores`}</small></button></li>`)
    .join('');
  const champs = l.champions.map((x) => `<li>👑 <b>${esc(x.name)}</b> <small class="muted">${shortDate(x.at)}</small></li>`).join('');
  return `${top ? card(top, top.joined, l.mine && l.mine !== top.id, true) : '<section class="lb-card"><p class="muted">No hay torneos programados ahora mismo. El organizador abrirá el siguiente en breve.</p></section>'}
    ${others ? `<section class="cir-grid">${others}</section>` : ''}
    ${champs ? `<section class="lb-card"><p class="eyebrow">Campeones</p><ul class="champs">${champs}</ul></section>` : ''}
    ${hero()}
    <section class="lb-card"><div class="card-head"><p class="eyebrow">Torneos de la comunidad</p><button class="btn" data-cir="new-event">Crear un evento</button></div><p class="muted">Organiza tu propio torneo eliminatorio e invita a quien quieras. Es el mismo cuadro y las mismas reglas que el Circuit, pero sin premios ni XP. Hace falta el nivel 3 de cuenta.</p></section>
    ${recent ? `<section class="lb-card"><p class="eyebrow">Historial de torneos</p><ul class="cir-recent">${recent}</ul></section>` : ''}`;
}

function actionPanel(c) {
  const you = c.you;
  const mineElsewhere = cs.list?.mine && cs.list.mine !== c.id;
  if (c.status === 'cancelled') return `<section class="lb-card circuit-end"><p class="eyebrow">Torneo cancelado</p><h3>${esc(c.cancelReason ?? 'Cancelado')}</h3><p class="muted">No se ha jugado ninguna partida. Las inscripciones quedan libres para el siguiente torneo.</p></section>`;
  if (c.status === 'finished') {
    return `<section class="lb-card circuit-end champion"><p class="eyebrow">Torneo terminado</p><h3>🏆 Campeón: ${esc(c.champion?.name ?? '—')}</h3>
      ${you?.placement ? `<p><b>${PLACE_TEXT[you.placement] ?? 'Participante'}</b> · premio ${prizeText(you.prize)}</p>${flags.wallet ? '' : '<p class="warn">Activa la cartera verificada (flag wallet) para cobrar los premios.</p>'}` : '<p class="muted">Gracias por seguirlo en directo.</p>'}</section>`;
  }
  if (c.status === 'running') {
    if (you && !you.out) {
      return you.matchCode
        ? `<section class="lb-card circuit-end"><p class="eyebrow">¡Te toca!</p><h3>Tu partida está en juego</h3><button class="play-now sm" data-cir-watch="${esc(you.matchCode)}"><span class="pn-main">Ir a la partida</span><small>Tu rival te espera</small></button></section>`
        : '<section class="lb-card circuit-end"><p class="eyebrow">Sigues dentro</p><h3>Esperando tu próxima partida</h3><p class="muted">Mantén esta pestaña abierta: entrarás a tu sala automáticamente cuando esté lista.</p></section>';
    }
    if (you?.out) return `<section class="lb-card circuit-end"><p class="eyebrow">Estás fuera</p><h3>${PLACE_TEXT[you.placement] ?? 'Eliminado'}</h3><p class="muted">Premio: ${prizeText(you.prize)} (se cobra al terminar el torneo). Puedes seguir las partidas en directo desde el cuadro.</p></section>`;
    return '';
  }
  if (c.status === 'open') {
    if (you) return `<section class="lb-card circuit-end"><p class="eyebrow">Inscrito</p><h3>Estás dentro (${c.players}/${c.size})</h3><p class="muted">Puedes cancelar hasta que cierre la inscripción, en ${countdown(c.regClosesAt)}. Estar conectado al cerrarse es obligatorio.</p><button class="btn danger" data-cir="leave" data-id="${esc(c.id)}">Cancelar inscripción</button></section>`;
    if (mineElsewhere) return '<section class="lb-card circuit-end"><p class="eyebrow">Inscripción</p><h3>Ya participas en otro torneo</h3><p class="muted">Solo puedes estar en un torneo a la vez.</p></section>';
    return `<section class="lb-card circuit-end"><p class="eyebrow">Inscripción abierta</p><h3>${c.players}/${c.size} jugadores</h3><button class="play-now sm" data-cir="join" data-id="${esc(c.id)}"><span class="pn-main">Inscribirme</span><small>Cierra en ${clock(c.regClosesAt - serverNow())} · mínimo ${c.minPlayers} para jugar</small></button></section>`;
  }
  if (c.status === 'closed') return `<section class="lb-card circuit-end"><p class="eyebrow">Inscripción cerrada</p><h3>${you ? 'Estás dentro: no cierres esta pestaña' : 'Ya no se admiten jugadores'}</h3><p class="muted">Empieza en ${countdown(c.startsAt)}. Solo continúan los jugadores conectados y hacen falta ${c.minPlayers} para que se juegue.</p></section>`;
  return `<section class="lb-card circuit-end"><p class="eyebrow">Programado</p><h3>La inscripción abre en ${countdown(c.regOpensAt)}</h3></section>`;
}

function renderRegistration(c) {
  const rows = Array.from({ length: c.size }, (_, i) => {
    const e = c.entrants[i];
    return e ? entrantRow(e, c.you?.id) : `<li class="free ${i < c.minPlayers ? 'needed' : ''}"><span>${i < c.minPlayers ? '— plaza necesaria —' : '— plaza libre —'}</span></li>`;
  });
  return `<section class="lb-card circuit-reg"><div class="card-head"><p class="eyebrow">Participantes</p><span class="pill todo">${c.players}/${c.size}</span></div>
    <ul class="slots">${rows.join('')}</ul>
    <p class="muted">Cabezas de serie por rating al cerrar la inscripción. Con menos de ${c.size} jugadores, los mejores pasan la primera ronda sin jugar.</p></section>`;
}

function matchCard(m, mine, roundName) {
  const row = (e) => {
    if (!e) return `<div class="cm-row empty"><span>${m.bye ? 'Pase directo' : 'Por definir'}</span></div>`;
    const win = m.winner === e.id;
    const lose = m.winner && !win;
    return `<div class="cm-row ${win ? 'win' : ''} ${lose ? 'lose' : ''} ${e.id === mine ? 'me' : ''}"><i>${e.seed ?? ''}</i><b>${esc(e.name)}</b>${win ? '<span aria-label="Ganador">✔</span>' : ''}</div>`;
  };
  const isMine = mine && (m.a?.id === mine || m.b?.id === mine);
  let foot = `<small class="muted">${m.bye ? 'Pase directo' : MATCH[m.status]}${m.status === 'done' && m.reason && !m.bye ? ` · ${esc(m.reason)}` : ''}${m.draws && m.status !== 'done' ? ` · repetida ${m.draws}×` : ''}</small>`;
  if (m.status === 'playing' && m.code) foot = `<button class="btn" data-cir-watch="${esc(m.code)}">${isMine ? '▶ Volver a tu partida' : '👀 Ver en vivo'}</button>`;
  return `<article class="cm ${m.status}" aria-label="${esc(roundName)}: ${esc(m.a?.name ?? 'por definir')} contra ${esc(m.b?.name ?? 'por definir')}"><span class="cm-state ${m.status}">${m.bye ? 'Bye' : MATCH[m.status]}</span>${row(m.a)}${row(m.b)}${foot}</article>`;
}

function renderBracket(c) {
  const mine = c.you?.id;
  const cols = c.matches.map((round, i) => `<div class="cm-col"><h4>${esc(c.roundNames[i])}</h4>${round.map((m) => matchCard(m, mine, c.roundNames[i])).join('')}</div>`).join('');
  const results = c.matches
    .map((round, i) => {
      const done = round.filter((m) => m.status === 'done' && !m.bye);
      if (!done.length) return '';
      const items = done.map((m) => {
        const w = m.a?.id === m.winner ? m.a : m.b;
        const l = w === m.a ? m.b : m.a;
        return `<li><b>${esc(w?.name)}</b> venció a ${esc(l?.name)} <small class="muted">${esc(m.reason ?? '')}</small></li>`;
      });
      return `<div><h4>${esc(c.roundNames[i])}</h4><ul>${items.join('')}</ul></div>`;
    })
    .join('');
  return `<section class="lb-card"><div class="card-head"><p class="eyebrow">Cuadro</p>${pill(c.status)}</div><div class="bracket" style="--rounds:${c.matches.length}">${cols}</div></section>
    ${results ? `<section class="lb-card"><details class="cir-results" open><summary class="eyebrow">Resultados de rondas anteriores</summary><div class="cir-results-grid">${results}</div></details></section>` : ''}`;
}

function renderDetail() {
  const c = cs.detail;
  if (!c) return `<section class="lb-card"><button class="back" data-cir="back">← Torneos</button><p class="muted">Cargando torneo…</p></section>`;
  const prizes = PRIZE_ROWS.filter(([, key]) => c.prizes[key] && (key !== 'r16' || c.size >= 16)).map(([label, key]) => `<li class="${key === 'champion' ? 'top' : ''}">${label} <b>${prizeText(c.prizes[key])}</b></li>`).join('');
  const body = ['scheduled', 'open', 'closed', 'cancelled'].includes(c.status) ? renderRegistration(c) : c.matches.length ? renderBracket(c) : '';
  return `<section class="lb-card circuit-hero"><button class="back" data-cir="back">← Torneos</button>
      <div class="card-head"><p class="eyebrow">${esc(c.name)} · ${esc(tcLabel(c.tc))}</p>${pill(c.status)}</div>
      <h3>Eliminatoria de hasta ${c.size} ${communityBadge(c)}</h3>
      ${c.description ? `<p class="muted">${esc(c.description)}</p>` : ''}
      ${c.organizer ? `<p class="muted">Organiza: <button class="link-btn" data-user="${esc(c.organizer.id)}">${esc(c.organizer.name)}</button> · sin premios ni XP</p>` : ''}
      <div class="cir-actions"><button class="btn" data-cir="share" data-id="${esc(c.id)}">🔗 Copiar enlace</button>${c.organizer?.id === net.user?.id && ['scheduled', 'open', 'closed'].includes(c.status) ? `<button class="btn danger" data-cir="cancel-event" data-id="${esc(c.id)}">Cancelar evento</button>` : ''}</div>
      <ul class="cir-facts"><li>👥 <b>${c.players}/${c.size}</b> participantes <small>(mínimo ${c.minPlayers})</small></li><li>⏱ ${timeLine(c)}</li></ul>
      <ul class="prize-row">${prizes}</ul></section>
    ${actionPanel(c)}
    ${body}
    <section class="lb-card"><details class="cir-rules"><summary class="eyebrow">Reglas y desempates</summary><ul>${Object.values(c.rules).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details></section>`;
}

function render() {
  const body = $('#circuitBody');
  if (!body || app.screen !== 'circuit') return;
  if (cs.offline) {
    body.innerHTML = '<section class="lb-card circuit-hero"><h3>Sin conexión con el servidor</h3><p class="muted">El Royale Circuit necesita conexión. El resto del juego funciona sin ella.</p><button class="btn primary" data-cir="retry">Reintentar</button></section>';
    return;
  }
  const open = body.querySelector('details[open]') ? [...body.querySelectorAll('details')].map((d) => d.open) : null;
  body.innerHTML = cs.id ? renderDetail() : renderList();
  if (open) body.querySelectorAll('details').forEach((d, i) => (d.open = open[i] ?? d.open)); // el usuario conserva lo que desplegó
}

function tick() {
  if (app.screen !== 'circuit') {
    clearInterval(cs.timer);
    cs.timer = null;
    return;
  }
  for (const el of document.querySelectorAll('#circuitBody .cd')) el.textContent = clock(Number(el.dataset.until) - serverNow());
}

export async function enterCircuit(id = null) {
  cs.id = id ?? cs.id;
  showScreen('circuit');
  render();
  if (!(await connect())) return render();
  await refreshCircuitPublic();
  if (!cs.id && cs.list?.mine) cs.id = cs.list.mine; // si ya estás en un torneo, se abre directamente
  watch();
  if (cs.id) loadDetail(cs.id);
  render();
  claimPrizes();
  clearInterval(cs.timer);
  cs.timer = setInterval(tick, 1000);
  return undefined;
}

// ---------- Arranque ----------
// Formulario de torneo de creador: el servidor valida nivel, texto, tamaño, control de tiempo, hora y límites.
async function createEvent() {
  const tomorrow = new Date(Date.now() + 3600_000 * 24 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const html = `<h3>Crear un evento</h3>
    <form id="evForm" class="ev-form" novalidate><label>Título<input name="title" maxlength="40" required placeholder="Copa de los viernes" autocomplete="off"></label>
      <label>Descripción (opcional)<input name="description" maxlength="200" placeholder="Torneo amistoso, todos los niveles" autocomplete="off"></label>
      <label>Jugadores<select name="size"><option>4</option><option selected>8</option><option>16</option></select></label>
      <label>Control de tiempo<select name="tc"><option value="blitz3_2">Blitz 3+2</option><option value="blitz5" selected>Blitz 5</option><option value="rapid10">Rápida 10</option></select></label>
      <label>Empieza<input name="startsAt" type="datetime-local" value="${tomorrow}" required></label>
      <p class="muted">Sin enlaces. Máximo 2 eventos activos y 3 al día. Sin premios ni XP.</p>
      <div class="modal-actions"><button class="btn primary" type="button" data-choice="go">Crear</button><button class="btn" type="button" data-choice="no">Cancelar</button></div></form>`;
  // El diálogo se cierra al elegir: se van guardando los valores del formulario mientras se escribe.
  const vals = {};
  const answer = choice(html, 'ev-card');
  const form = document.querySelector('#evForm');
  const grab = () => Object.assign(vals, Object.fromEntries(new FormData(form)));
  form.addEventListener('input', grab);
  form.addEventListener('change', grab);
  form.addEventListener('submit', (e) => e.preventDefault());
  grab();
  if ((await answer) !== 'go') return;
  const res = await api('/api/events', { method: 'POST', body: { title: vals.title, description: vals.description, size: Number(vals.size), tc: vals.tc, startsAt: new Date(vals.startsAt).getTime() } });
  if (!res.ok) return toast(res.json?.error ?? 'No se pudo crear el evento', 4500);
  toast('🎉 Evento creado');
  return openCircuit(res.json.id);
}

export function initCircuit() {
  app.openCircuit = openCircuit;
  if (!flags.circuit) return;
  onScreen((name) => {
    if (name !== 'circuit' && name !== 'lobby' && cs.watching) {
      socket.send({ t: 'circuit_unwatch' });
      cs.watching = false;
    }
  });
  socket.on('circuit_list', (m) => {
    cs.list = m.list;
    syncClock(m.list.now);
    changed();
    if (app.screen === 'circuit') render();
  });
  socket.on('circuit_state', (m) => {
    const c = m.circuit;
    if (!c) return;
    syncClock(c.now);
    if (cs.id === c.id) cs.detail = c;
    if (c.status === 'finished' && c.you) setTimeout(claimPrizes, 800);
    if (app.screen === 'circuit') render();
  });
  socket.on('circuit_error', (m) => toast(m.message ?? 'No se pudo completar la acción', 3500));
  socket.on('circuit_match', (m) => {
    toast(`🏆 ${m.label}: tu partida contra ${m.opponent} está lista`, 4000);
    joinRoom(m.code);
  });
  socket.on('connection', (c) => {
    if (c.open && cs.watching) watch();
  });
  $('#screen-circuit').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-cir-open]')?.dataset.cirOpen;
    if (open) {
      cs.id = open;
      cs.detail = null;
      render();
      watch();
      return loadDetail(open);
    }
    const btn = e.target.closest('[data-cir]');
    const act = btn?.dataset.cir;
    if (act === 'back') {
      cs.id = null;
      cs.detail = null;
      watch();
      return render();
    }
    if (act === 'retry') return enterCircuit(cs.id);
    if (act === 'share') {
      await copyText(`${location.origin}/t/${btn.dataset.id}`);
      return toast('🔗 Enlace del torneo copiado');
    }
    if (act === 'new-event') return createEvent();
    if (act === 'cancel-event') {
      if (!(await confirmModal('¿Cancelar el evento?', 'Los inscritos quedarán libres. No se puede deshacer.', 'Cancelar evento', 'Volver'))) return undefined;
      const res = await api(`/api/events/${encodeURIComponent(btn.dataset.id)}/cancel`, { method: 'POST', body: {} });
      toast(res.ok ? 'Evento cancelado' : (res.json?.error ?? 'No se pudo cancelar'));
      return undefined;
    }
    if (act === 'join' || act === 'leave') {
      if (!(await connect())) return render();
      socket.send({ t: act === 'join' ? 'circuit_join' : 'circuit_leave', id: btn.dataset.id });
      return undefined;
    }
    const watchCode = e.target.closest('[data-cir-watch]')?.dataset.cirWatch;
    if (watchCode) return joinRoom(watchCode);
    return undefined;
  });
}
