// Misiones diarias y semanales: progreso por eventos de juego, recompensas en oros y XP de temporada.
import { MISSIONS_DAILY, MISSIONS_WEEKLY } from './data.js';
import { sfx } from './fx.js';
import { addSeasonXp } from './season.js';
import { addCoins, save, state } from './store.js';
import { $, esc, toast } from './ui.js';

const EPOCH = Date.UTC(2026, 0, 1);
const dayIndex = (d = new Date()) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 864e5);
const dayKeyNow = () => `d${dayIndex()}`;
const weekKeyNow = () => `w${Math.floor((dayIndex() + 3) / 7)}`; // las semanas empiezan en lunes

function seeded(seed) {
  let s = (seed * 9301 + 49297) % 233280 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Elige n misiones distintas de forma determinista para el día/semana (mismo reparto para todos).
function pickN(pool, n, seed) {
  const rand = seeded(seed + 13);
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n).map((m) => ({ id: m.id, progress: 0, claimed: false }));
}

export function ensureMissions() {
  const m = state.missions;
  let changed = false;
  if (m.dayKey !== dayKeyNow()) {
    m.dayKey = dayKeyNow();
    m.daily = pickN(MISSIONS_DAILY, 3, dayIndex());
    changed = true;
  }
  if (m.weekKey !== weekKeyNow()) {
    m.weekKey = weekKeyNow();
    m.weekly = pickN(MISSIONS_WEEKLY, 2, Math.floor((dayIndex() + 3) / 7));
    changed = true;
  }
  if (changed) save();
}

const defOf = (kind, id) => (kind === 'daily' ? MISSIONS_DAILY : MISSIONS_WEEKLY).find((d) => d.id === id);

// Registra un evento de juego (win, game, check, capture, promote, perfect, daily, online, onlinewin).
export function track(event, n = 1) {
  if (!n) return;
  ensureMissions();
  let done = 0;
  for (const kind of ['daily', 'weekly']) {
    for (const m of state.missions[kind]) {
      const def = defOf(kind, m.id);
      if (!def || def.event !== event || m.claimed || m.progress >= def.target) continue;
      m.progress = Math.min(def.target, m.progress + n);
      if (m.progress >= def.target) done += 1;
    }
  }
  save();
  if (done) toast(`🎯 ¡Misión completada! Reclama tu premio en Misiones`, 3500);
}

export function claimableMissions() {
  ensureMissions();
  return ['daily', 'weekly'].reduce(
    (n, kind) => n + state.missions[kind].filter((m) => !m.claimed && m.progress >= (defOf(kind, m.id)?.target ?? Infinity)).length,
    0,
  );
}

function claim(kind, id) {
  const m = state.missions[kind].find((x) => x.id === id);
  const def = defOf(kind, id);
  if (!m || !def || m.claimed || m.progress < def.target) return false;
  m.claimed = true;
  addCoins(def.coins);
  addSeasonXp(def.xp);
  save();
  return true;
}

export function renderMissions() {
  ensureMissions();
  const block = (kind, title, hint) => {
    const items = state.missions[kind].map((m) => {
      const def = defOf(kind, m.id);
      const ready = m.progress >= def.target;
      return `<li class="mission ${m.claimed ? 'claimed' : ready ? 'ready' : ''}">
        <div class="m-main"><b>${esc(def.text)}</b>
          <div class="m-bar"><i style="width:${(m.progress / def.target) * 100}%"></i></div>
          <small>${m.progress} / ${def.target} · 🪙 ${def.coins} · ${def.xp} XP</small></div>
        <button class="btn ${ready && !m.claimed ? 'primary' : ''}" data-claim="${kind}:${m.id}" ${ready && !m.claimed ? '' : 'disabled'}>${m.claimed ? '✓' : ready ? 'Reclamar' : '...'}</button>
      </li>`;
    }).join('');
    return `<div class="panel mission-block"><h3>${title} <small>${hint}</small></h3><ul class="missions">${items}</ul></div>`;
  };
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  const hours = Math.ceil((tomorrow - Date.now()) / 3600_000);
  $('#missionsBody').innerHTML = block('daily', 'Misiones diarias', `se renuevan en ${hours} h`) + block('weekly', 'Misiones semanales', 'se renuevan cada lunes');
}

export function initMissions() {
  $('#missionsBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-claim]');
    if (!b) return;
    const [kind, id] = b.dataset.claim.split(':');
    if (claim(kind, id)) {
      sfx.coin();
      toast('🎁 ¡Recompensa reclamada!');
    }
    renderMissions();
  });
}
