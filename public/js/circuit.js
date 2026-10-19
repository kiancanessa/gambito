// Royale Circuit (Fase 4, flag `circuit`): torneo eliminatorio de 8 jugadores, bajo demanda.
// El servidor lleva el cuadro; aquí se inscribe el jugador, se ve el bracket en directo, se entra solo a cada partida
// (`circuit_match`) y se cobran los premios por la cartera verificada.
import { flags } from './flags.js';
import { api, ensureOnline, net, socket } from './net.js';
import { joinRoom } from './online.js';
import { queueOp } from './store.js';
import { $, app, esc, showScreen, toast } from './ui.js';

const CLAIMED_KEY = 'gambito.circuit.claimed';
const PLACE_TEXT = { quarter: 'Eliminado en cuartos', semi: 'Eliminado en semifinales', final: 'Subcampeón', champion: '¡Campeón del Circuit!' };

const cs = { circuit: null, pub: null, deadline: 0, timer: null, claiming: false };

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

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const prizeText = (p) => (p ? `🪙 ${p.coins}${p.item ? ' + 👑 Corona del Circuito' : ''}` : '');

// ---------- Datos ----------
async function connect() {
  if (!(await ensureOnline())) {
    toast('Sin conexión con el servidor');
    return false;
  }
  try {
    await socket.connect();
    return true;
  } catch {
    toast('No se pudo conectar al servidor');
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
      toast(`🏆 Premio del Circuit: +${r.coins} 🪙${r.item ? ' y la Corona del Circuito' : ''}`, 5000);
    }
  } finally {
    cs.claiming = false;
  }
}

async function loadPublic() {
  const res = await api('/api/circuit', { auth: false });
  if (res.ok) cs.pub = res.json;
  if (app.screen === 'circuit') render();
  return cs.pub;
}
export const circuitPublic = () => cs.pub;
export const circuitMine = () => cs.circuit;
export const refreshCircuitPublic = loadPublic;

// ---------- Interfaz ----------
const slot = (e) => (e ? `<li class="${e.bot ? 'bot' : ''}"><b>${e.bot ? '🤖 ' : ''}${esc(e.name)}</b>${e.rating ? `<em>${e.rating}</em>` : ''}</li>` : '<li class="free"><span>— plaza libre —</span></li>');

function renderRegistration() {
  const c = cs.circuit;
  const open = cs.pub?.open;
  const names = c?.status === 'registering' ? c.entrants : (open?.names ?? []).map((name) => ({ name }));
  const size = cs.pub?.size ?? c?.size ?? 8;
  const rows = Array.from({ length: size }, (_, i) => slot(names[i]));
  const left = c?.status === 'registering' ? cs.deadline - Date.now() : (open?.fillInMs ?? 0);
  const joined = c?.status === 'registering';
  return `<section class="lb-card circuit-reg">
    <div class="card-head"><p class="eyebrow">Inscripción abierta</p><span class="pill todo">${names.length}/${size}</span></div>
    <ul class="slots">${rows.join('')}</ul>
    <p class="muted">${names.length ? `Empieza al llegar a ${size} jugadores o en <b id="cirCount">${fmt(left)}</b>, rellenando con bots.` : 'Sé el primero: el torneo arranca 1 minuto después de la primera inscripción (se completa con bots).'}</p>
    ${joined ? '<button class="btn danger" data-cir="leave">Salir de la inscripción</button>' : '<button class="lb-cta" data-cir="join">🏆 Entrar al Circuit<small>Blitz 3+2 · eliminatoria de 8 · premios cosméticos</small></button>'}
  </section>`;
}

function matchCard(m, mine, roundName) {
  const row = (e) => {
    if (!e) return '<div class="cm-row empty"><span>Por definir</span></div>';
    const win = m.winner === e.id;
    const lose = m.winner && !win;
    return `<div class="cm-row ${win ? 'win' : ''} ${lose ? 'lose' : ''} ${e.id === mine ? 'me' : ''}"><i>${e.seed ?? ''}</i><b>${e.bot ? '🤖 ' : ''}${esc(e.name)}</b>${win ? '<span>✔</span>' : ''}</div>`;
  };
  let foot = '';
  if (m.status === 'playing' && m.code) foot = `<button class="btn" data-cir-watch="${esc(m.code)}">${mine && (m.a?.id === mine || m.b?.id === mine) ? '▶ Volver a tu partida' : '👀 Ver en vivo'}</button>`;
  else if (m.status === 'playing') foot = '<small class="muted">Simulada…</small>';
  else if (m.status === 'done' && m.reason) foot = `<small class="muted">${esc(m.reason)}</small>`;
  return `<article class="cm ${m.status}" aria-label="${esc(roundName)}">${row(m.a)}${row(m.b)}${foot}</article>`;
}

function renderBracket() {
  const c = cs.circuit;
  const mine = c.you?.id;
  const cols = c.matches
    .map((round, i) => `<div class="cm-col"><h4>${esc(c.roundNames[i])}</h4>${round.map((m) => matchCard(m, mine, c.roundNames[i])).join('')}</div>`)
    .join('');
  let banner = '';
  if (c.status === 'finished') {
    const you = c.you;
    banner = `<section class="lb-card circuit-end"><p class="eyebrow">Torneo terminado</p><h3>🏆 Campeón: ${esc(c.champion?.name ?? '—')}</h3>
      ${you?.placement ? `<p><b>${PLACE_TEXT[you.placement]}</b> · premio ${prizeText(you.prize)}</p>${flags.wallet ? '' : '<p class="warn">Activa la cartera verificada (flag wallet) para cobrar los premios.</p>'}` : ''}
      <button class="lb-cta" data-cir="again">Jugar otro torneo<small>Se abre una nueva inscripción</small></button></section>`;
  } else if (c.you?.out) {
    banner = `<section class="lb-card circuit-end"><p class="eyebrow">Estás fuera</p><h3>${PLACE_TEXT[c.you.placement] ?? 'Eliminado'}</h3><p class="muted">Premio: ${prizeText(c.you.prize)}. Puedes seguir el torneo en directo.</p></section>`;
  } else if (c.you?.matchCode) {
    banner = `<section class="lb-card circuit-end"><p class="eyebrow">¡Te toca!</p><h3>Tu partida está en juego</h3><button class="lb-cta" data-cir-watch="${esc(c.you.matchCode)}">▶ Ir a la partida</button></section>`;
  }
  return `${banner}<section class="lb-card"><div class="card-head"><p class="eyebrow">Cuadro</p><span class="pill ${c.status === 'finished' ? 'ok' : 'live'}">${c.status === 'finished' ? 'Final' : 'En curso'}</span></div><div class="bracket">${cols}</div></section>`;
}

function render() {
  const body = $('#circuitBody');
  if (!body) return;
  const c = cs.circuit;
  const champs = (cs.pub?.champions ?? []).map((x) => `<li>👑 <b>${esc(x.name)}</b> <small class="muted">${new Date(x.at).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</small></li>`).join('');
  const live = (cs.pub?.running ?? []).flatMap((t) => t.live).map((g) => `<li><b>${esc(g.a)}</b> vs <b>${esc(g.b)}</b> <small class="muted">${esc(g.label)}</small> <button class="btn" data-cir-watch="${esc(g.code)}">Ver</button></li>`).join('');
  const main = c && c.status !== 'registering' ? renderBracket() : renderRegistration();
  body.innerHTML = `
    <section class="lb-card circuit-hero"><p class="eyebrow">Royale Circuit</p><h3>Eliminatoria de 8 · Blitz 3+2</h3>
      <p class="muted">Cuartos, semifinales y final. Gana la Corona del Circuito, un set de piezas que no se vende en la tienda. Nunca da ventaja de juego.</p>
      <ul class="prize-row"><li>Cuartos <b>🪙 30</b></li><li>Semifinal <b>🪙 60</b></li><li>Final <b>🪙 120</b></li><li>Campeón <b>🪙 250 + 👑</b></li></ul></section>
    ${main}
    ${live && !(c && c.status !== 'registering') ? `<section class="lb-card"><p class="eyebrow">Partidas en directo</p><ul class="live-list">${live}</ul></section>` : ''}
    ${champs ? `<section class="lb-card"><p class="eyebrow">Últimos campeones</p><ul class="champs">${champs}</ul></section>` : ''}`;
}

function tick() {
  const el = $('#cirCount');
  if (el) el.textContent = fmt(cs.deadline - Date.now());
  if (app.screen !== 'circuit') {
    clearInterval(cs.timer);
    cs.timer = null;
  }
}

export async function enterCircuit() {
  showScreen('circuit');
  render();
  if (!(await connect())) return;
  socket.send({ t: 'circuit_sync' });
  await loadPublic();
  claimPrizes();
  clearInterval(cs.timer);
  cs.timer = setInterval(tick, 1000);
}

// ---------- Arranque ----------
export function initCircuit() {
  if (!flags.circuit) return;
  socket.on('circuit_state', (m) => {
    cs.circuit = m.circuit;
    if (m.circuit?.status === 'registering') cs.deadline = Date.now() + m.circuit.fillInMs;
    if (m.circuit?.status === 'finished') setTimeout(claimPrizes, 800);
    if (app.screen === 'circuit') render();
  });
  socket.on('circuit_match', (m) => {
    toast(`🏆 ${m.label}: tu partida contra ${m.opponent} está lista`, 4000);
    joinRoom(m.code);
  });
  socket.on('connection', (c) => {
    if (c.open && cs.circuit && cs.circuit.status !== 'finished') socket.send({ t: 'circuit_sync' });
  });
  $('#screen-circuit').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-cir]')?.dataset.cir;
    if (act === 'join' || act === 'again') {
      if (await connect()) {
        cs.circuit = null;
        socket.send({ t: 'circuit_join' });
      }
      return;
    }
    if (act === 'leave') {
      socket.send({ t: 'circuit_leave' });
      return loadPublic();
    }
    const watch = e.target.closest('[data-cir-watch]')?.dataset.cirWatch;
    if (watch) return joinRoom(watch);
    return undefined;
  });
}
