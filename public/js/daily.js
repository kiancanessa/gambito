// Desafío diario: el mismo mate en 2-3 para todo el mundo, con ranking por tiempo y racha.
import { sfx } from './fx.js';
import { track } from './missions.js';
import { api, ensureOnline, net } from './net.js';
import { addSeasonXp } from './season.js';
import { startSession } from './session.js';
import { shareText } from './share.js';
import { addCoins, save, state } from './store.js';
import { $, app, celebrate, choice, esc, fmtCountdown, fmtDuration, showScreen, toast } from './ui.js';

const run = { data: null, t0: 0, attempts: 0 };
let tick = null;

const shareString = (d, seconds, attempts) =>
  `🧩 Gambito Diario #${d.number} · Mate en ${d.mateIn}\n⏱ ${fmtDuration(seconds)}  🔁 ${attempts} intento${attempts > 1 ? 's' : ''}  🔥 ${state.dailyPuzzle.streak}\n${location.origin}`;

function renderBoard(d) {
  const rows = d.top.map((r) => `<li class="${r.id === net.user?.id ? 'me' : ''}"><span class="rk">${r.rank}</span><b>${esc(r.name)}</b><em>${fmtDuration(r.seconds)}</em></li>`).join('');
  $('#dailyBoard').innerHTML = `<p class="eyebrow">Ranking de hoy</p>
    <ol class="lb">${rows || '<li class="empty">Nadie lo ha resuelto todavía. ¡Sé el primero!</li>'}</ol>
    <p class="next-line muted">${d.solvedCount} jugador${d.solvedCount === 1 ? '' : 'es'} lo han resuelto${d.mine ? ` · tu puesto: <b>#${d.mine.rank}</b>` : ''}</p>`;
}

function renderCard(d) {
  const dp = state.dailyPuzzle;
  const turn = d.fen.split(' ')[1] === 'w' ? 'blancas' : 'negras';
  const left = d.nextResetAt - Date.now();
  $('#dailyCard').innerHTML = `
    <p class="eyebrow">Desafío #${d.number}</p>
    <h2 class="daily-title">Mate en ${d.mateIn}</h2>
    <p class="muted">Juegan ${turn}. Da jaque mate en como máximo <b>${d.mateIn}</b> jugada${d.mateIn > 1 ? 's' : ''}. El rival se defenderá con Stockfish.</p>
    <ul class="mini-stats">
      <li><span>🔥 Racha</span><b>${dp.streak} día${dp.streak === 1 ? '' : 's'}</b></li>
      <li><span>🏆 Mejor racha</span><b>${dp.best}</b></li>
      <li><span>⏳ Nuevo desafío en</span><b id="dailyCountdown">${fmtCountdown(left)}</b></li>
    </ul>
    ${d.mine
      ? `<div class="daily-done"><b>✅ ¡Resuelto!</b> ${fmtDuration(d.mine.seconds)} · ${d.mine.attempts} intento${d.mine.attempts > 1 ? 's' : ''} · puesto #${d.mine.rank}</div>
         <div class="modal-actions"><button class="btn" data-daily="share">📤 Compartir resultado</button><button class="btn primary" data-daily="play">Practicar otra vez</button></div>`
      : `<button class="big-btn primary center" data-daily="play">🧩 Resolver ahora</button>`}`;
}

export async function enterDaily() {
  showScreen('daily');
  $('#dailyBody').hidden = true;
  $('#dailyOffline').hidden = true;
  const ok = await ensureOnline();
  const res = ok ? await api('/api/daily') : { ok: false };
  if (app.screen !== 'daily') return;
  $('#dailyOffline').hidden = res.ok;
  $('#dailyBody').hidden = !res.ok;
  if (!res.ok) return;
  run.data = res.json;
  renderCard(res.json);
  renderBoard(res.json);
  clearInterval(tick);
  tick = setInterval(() => {
    const el = $('#dailyCountdown');
    if (app.screen !== 'daily' || !el) return clearInterval(tick);
    el.textContent = fmtCountdown(run.data.nextResetAt - Date.now());
  }, 30_000);
}

function launch() {
  const d = run.data;
  run.attempts += 1;
  const color = d.fen.split(' ')[1];
  startSession({
    opp: { name: 'El Defensor', title: 'Stockfish a máxima fuerza', glyph: 'k', color: '#ef5350' },
    playerColor: color,
    fen: d.fen,
    ai: { skill: 20, depth: 12, movetime: 500, blunder: 0 },
    limitMoves: d.mateIn,
    onResign: async () => {
      run.attempts += 0;
      launch();
    },
    onEnd: onFinish,
    ui: {
      banner: `<span>🧩 Desafío diario #${d.number} · <b>Mate en ${d.mateIn}</b></span><span>Intento ${run.attempts}</span>`,
      hint: false,
      undo: false,
      resignLabel: '↺ Reiniciar',
      meSub: 'Resuelve el mate',
    },
  });
}

export function startDaily() {
  if (!run.data) return;
  run.t0 = Date.now();
  run.attempts = 0;
  launch();
}

async function onFinish(summary) {
  const d = run.data;
  if (summary.result !== 'win') {
    sfx.error();
    const again = await choice(`<div class="result loss"><p class="eyebrow">${esc(summary.reason)}</p><h2>¡Casi!</h2>
      <p class="muted">No lograste el mate en ${d.mateIn}. Piensa en jaques y en las casillas de escape del rey.</p>
      <div class="modal-actions"><button class="btn primary" data-choice="retry">↺ Reintentar</button><button class="btn" data-choice="exit">Salir</button></div></div>`, 'result-card');
    if (again === 'retry') launch();
    else await app.go('daily');
    return;
  }

  const seconds = Math.max(2, (Date.now() - run.t0) / 1000);
  const res = await api('/api/daily/submit', { method: 'POST', body: { moves: summary.uci, seconds, attempts: run.attempts } });
  if (!res.ok) {
    toast('No se pudo enviar el resultado al servidor');
    await app.go('daily');
    return;
  }
  const dp = state.dailyPuzzle;
  const first = dp.lastDay !== d.day;
  let reward = 0;
  if (first) {
    dp.streak = dp.lastDay === d.day - 1 ? dp.streak + 1 : 1;
    dp.best = Math.max(dp.best, dp.streak);
    dp.lastDay = d.day;
    state.stats.dailySolved += 1;
    reward = 60 + Math.min(40, dp.streak * 5);
    addCoins(reward, { source: 'puzzle', key: `daily:${d.day}` });
    addSeasonXp(80);
    track('daily');
    save();
    celebrate();
  }
  sfx.win();
  const mine = res.json.mine;
  const pick = await choice(`<div class="result win"><p class="eyebrow">Desafío #${d.number}</p><h2>¡Mate en ${d.mateIn}!</h2>
    <ul class="rewards">
      <li style="--i:0"><span>⏱ Tiempo</span><b>${fmtDuration(mine.seconds)}</b></li>
      <li style="--i:1"><span>🔁 Intentos</span><b>${mine.attempts}</b></li>
      <li style="--i:2"><span>🏆 Puesto de hoy</span><b>#${mine.rank}</b></li>
      <li style="--i:3"><span>🔥 Racha</span><b>${dp.streak} día${dp.streak === 1 ? '' : 's'}</b></li>
      ${first ? `<li class="total" style="--i:4"><span>Recompensa</span><b>+${reward} 🪙</b></li>` : '<li class="total" style="--i:4"><span>Ya resuelto hoy</span><b>sin premio</b></li>'}
    </ul>
    <div class="modal-actions"><button class="btn primary" data-choice="share">📤 Compartir</button><button class="btn" data-choice="rank">Ver ranking</button></div></div>`, 'result-card');
  if (pick === 'share') await shareText(shareString(d, mine.seconds, mine.attempts));
  await app.go('daily');
}

export function initDaily() {
  $('#dailyCard').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-daily]');
    if (!b) return;
    if (b.dataset.daily === 'play') startDaily();
    if (b.dataset.daily === 'share' && run.data?.mine) await shareText(shareString(run.data, run.data.mine.seconds, run.data.mine.attempts));
  });
}

// Para el punto rojo de la pantalla de inicio: ¿hay desafío sin resolver hoy?
export async function dailyPending() {
  if (!net.user) return false;
  const res = await api('/api/daily');
  return res.ok && !res.json.mine;
}
