// Repeticiones (Fase 3, flag `replays`): historial de tus partidas y visor sobre la misma escena 3D de las partidas.
import { TIME_CONTROLS, leagueOf } from './data.js';
import { api } from './net.js';
import { reportReview } from './progress.js';
import { setBanner, startSession } from './session.js';
import { shareGame } from './share.js';
import { $, app, esc, toast } from './ui.js';

export const tcName = (id) => {
  const t = TIME_CONTROLS.find((x) => x.id === id);
  return t ? (id === 'none' ? 'Sin reloj' : `${t.label} ${t.sub}`) : id;
};

const RESULT = { win: ['Victoria', 'ok'], loss: ['Derrota', 'bad'], draw: ['Tablas', ''] };
const SPEEDS = [1, 2, 0.5];
const STEP_MS = 1100;

// Lista de partidas recientes (la usa el lobby).
export function historyHtml(games) {
  return games
    .map((g) => {
      const [label, cls] = RESULT[g.result];
      return `<li><span class="pill ${cls === 'ok' ? 'ok' : cls === 'bad' ? 'bad' : ''}">${label}</span>
        <div class="vs"><b>vs ${esc(g.opponent)}</b><small>${g.rated ? 'Clasificatoria' : 'Con amigo'} · ${tcName(g.tc)} · ${Math.ceil(g.plies / 2)} jugadas · ${new Date(g.createdAt).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</small></div>
        <button class="btn" data-replay="${esc(g.id)}">▶ Ver</button></li>`;
    })
    .join('');
}

let rp = null; // repetición abierta: { moves, i, timer, speed, game, data }
let bound = false;

const stopPlay = () => {
  if (!rp) return;
  clearTimeout(rp.timer);
  rp.timer = null;
  $('#rpPlay').textContent = '⏵';
};

function resultText(data) {
  if (!data.winner) return `Tablas · ${data.reason}`;
  return `${data.winner === data.you ? 'Victoria' : 'Derrota'} · ${data.reason}`;
}

function paint() {
  const total = rp.moves.length;
  $('#rpSlider').max = String(total);
  $('#rpSlider').value = String(rp.i);
  $('#rpLabel').textContent = rp.i === 0 ? `Posición inicial · ${total} jugadas` : `Jugada ${Math.ceil(rp.i / 2)} · ${rp.i}/${total}`;
  $('#rpSpeed').textContent = `${rp.speed}×`;
  const d = rp.data;
  setBanner(`<span>🎬 Repetición · ${d.rated ? 'Clasificatoria' : 'Partida con amigo'} · ${esc(tcName(d.tc))}</span>${rp.i === total ? `<span>🏁 ${esc(resultText(d))}</span>` : ''}`);
}

function seek(n, { animate = false } = {}) {
  const total = rp.moves.length;
  const target = Math.max(0, Math.min(total, n));
  if (animate && target === rp.i + 1) rp.game.applyRemote(rp.moves[rp.i]);
  else rp.game.loadMoves(rp.moves.slice(0, target));
  rp.i = target;
  paint();
  // Llegar a la última jugada de una partida propia cuenta como revisarla (el servidor lo valida y lo da una sola vez).
  if (target === total && total > 0 && !rp.reported && !rp.publicGame) {
    rp.reported = true;
    reportReview(rp.data.id, total);
  }
}

function play() {
  if (!rp) return;
  if (rp.i >= rp.moves.length) seek(0);
  $('#rpPlay').textContent = '⏸';
  const tick = () => {
    if (!rp || app.game !== rp.game) return;
    seek(rp.i + 1, { animate: true });
    if (rp.i >= rp.moves.length) return stopPlay();
    rp.timer = setTimeout(tick, STEP_MS / rp.speed);
    return undefined;
  };
  rp.timer = setTimeout(tick, 500);
}

function bind() {
  if (bound) return;
  bound = true;
  $('#replayBar').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-rp]')?.dataset.rp;
    if (!act || !rp) return;
    if (act === 'play') return rp.timer ? stopPlay() : play();
    if (act === 'speed') {
      rp.speed = SPEEDS[(SPEEDS.indexOf(rp.speed) + 1) % SPEEDS.length];
      return paint();
    }
    stopPlay();
    if (act === 'start') return seek(0);
    if (act === 'prev') return seek(rp.i - 1);
    if (act === 'next') return seek(rp.i + 1, { animate: true });
    if (act === 'end') return seek(rp.moves.length);
    if (act === 'share') {
      const d = rp.data;
      const mine = rp.game.chess.history({ verbose: true }).filter((m) => m.color === d.you);
      const me = d.you === 'w' ? d.white : d.black;
      const opp = d.you === 'w' ? d.black : d.white;
      return shareGame({
        game: rp.game,
        summary: { moves: mine.length, checks: mine.filter((m) => /[+#]/.test(m.san)).length },
        headline: `Repetición de ${me.name}`,
        sub: `vs ${opp.name}`,
      });
    }
    return undefined;
  });
  $('#rpSlider').addEventListener('input', (e) => {
    if (!rp) return;
    stopPlay();
    seek(Number(e.target.value));
  });
}

// `publicGame`: repetición de una partida pública (clasificatoria o de torneo) que no es tuya; se ve desde las blancas.
export async function openReplay(id, { publicGame = false } = {}) {
  const res = await api(`/api/${publicGame ? 'public/' : ''}games/${encodeURIComponent(id)}`, { auth: !publicGame });
  if (!res.ok) return toast('No se pudo cargar la repetición');
  const d = res.json.game;
  bind();
  const opp = d.you === 'w' ? d.black : d.white;
  const me = d.you === 'w' ? d.white : d.black;
  const lg = leagueOf(opp.rating ?? 1000);
  const game = startSession({
    opp: { name: opp.name, title: `Liga ${lg.name} · ${opp.rating ?? '—'}`, glyph: lg.glyph, color: lg.color },
    playerColor: d.you,
    spectator: true,
    remote: { send() {} }, // sin motor ni envío: es solo un visor
    onEnd() {},
    onLeave: () => {
      stopPlay();
      $('#replayBar').hidden = true;
      rp = null;
    },
    ui: { hint: false, undo: false, resign: false, meName: me.name, meSub: `${d.you === 'w' ? 'Blancas' : 'Negras'} · ${me.rating ?? '—'} pts` },
  });
  game.over = true; // no hay nada que jugar ni que confirmar al salir
  rp = { moves: d.moves, i: 0, timer: null, speed: 1, game, data: d, publicGame };
  $('#replayBar').hidden = false;
  paint();
  play();
  return undefined;
}
