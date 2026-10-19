// Pase de temporada: XP compartida por partidas, misiones y desafíos; recompensas gratuitas por nivel.
import { SEASON } from './data.js';
import { sfx } from './fx.js';
import { addCoins, grantItem, save, state } from './store.js';
import { $, esc, fmtCountdown, toast } from './ui.js';

function ensureSeason() {
  if (state.season.id !== SEASON.id) state.season = { id: SEASON.id, xp: 0, claimed: [] };
}

export function seasonLevel() {
  ensureSeason();
  return Math.min(SEASON.levels, Math.floor(state.season.xp / SEASON.xpPerLevel));
}

export function addSeasonXp(n) {
  ensureSeason();
  const before = seasonLevel();
  state.season.xp = Math.min(SEASON.levels * SEASON.xpPerLevel, state.season.xp + Math.round(n));
  save();
  const after = seasonLevel();
  if (after > before) toast(`🎖 ¡Nivel ${after} de temporada!`, 3500);
}

const rewardFor = (level) => SEASON.rewards[level] ?? SEASON.defaultReward;
const rewardText = (r) => (r.coins ? `🪙 ${r.coins}` : r.label);

// Resumen para el lobby.
export function seasonSummary() {
  ensureSeason();
  const level = seasonLevel();
  const into = state.season.xp - level * SEASON.xpPerLevel;
  const maxed = level >= SEASON.levels;
  const next = maxed ? null : rewardFor(level + 1);
  return { name: SEASON.name, level, levels: SEASON.levels, per: SEASON.xpPerLevel, into, maxed, nextReward: next && rewardText(next), claimable: claimableSeason() };
}

export const claimableSeason = () => {
  ensureSeason();
  let n = 0;
  for (let l = 1; l <= seasonLevel(); l += 1) if (!state.season.claimed.includes(l)) n += 1;
  return n;
};

function claim(level) {
  ensureSeason();
  if (level > seasonLevel() || state.season.claimed.includes(level)) return false;
  const r = rewardFor(level);
  if (r.coins) addCoins(r.coins);
  if (r.item) grantItem(r.item[0], r.item[1]);
  state.season.claimed.push(level);
  save();
  return true;
}

export function renderSeason() {
  ensureSeason();
  const lvl = seasonLevel();
  const into = state.season.xp - lvl * SEASON.xpPerLevel;
  const maxed = lvl >= SEASON.levels;
  const left = new Date(`${SEASON.endsAt}T23:59:59`).getTime() - Date.now();
  const cards = Array.from({ length: SEASON.levels }, (_, i) => {
    const l = i + 1;
    const r = rewardFor(l);
    const done = state.season.claimed.includes(l);
    const open = l <= lvl && !done;
    const big = !!(r.item || r.coins >= 100);
    return `<button class="pass-card ${done ? 'done' : open ? 'open' : 'locked'} ${big ? 'big' : ''}" data-claim="${l}" ${open ? '' : 'disabled'}>
      <small>Nivel ${l}</small>
      <span class="ico">${r.item ? { board: '♟', set: '♞', fx: '✨' }[r.item[0]] : '🪙'}</span>
      <b>${esc(rewardText(r))}</b>
      <em>${done ? '✓ Reclamado' : open ? 'Reclamar' : '🔒'}</em>
    </button>`;
  }).join('');
  $('#seasonBody').innerHTML = `
    <div class="season-hero">
      <div><p class="eyebrow">${esc(SEASON.name)}</p>
        <p class="big-num"><b>${lvl}</b> / ${SEASON.levels} <small>nivel de temporada</small></p></div>
      <div class="season-meta">
        <div class="xpline"><i style="width:${maxed ? 100 : (into / SEASON.xpPerLevel) * 100}%"></i></div>
        <small>${maxed ? '¡Pase completado!' : `${into} / ${SEASON.xpPerLevel} XP para el nivel ${lvl + 1}`} · termina en ${fmtCountdown(left)}</small>
        <button class="btn primary" data-claim="all" ${claimableSeason() ? '' : 'disabled'}>Reclamar todo (${claimableSeason()})</button>
      </div>
    </div>
    <p class="muted track-label">Pista gratuita</p>
    <div class="pass-track">${cards}</div>
    <p class="muted track-label">Pista premium <span class="soon">próximamente</span></p>
    <div class="pass-track premium"><div class="premium-lock">🔒 La pista premium llegará con la temporada 2: más skins, emotes y marcos. Todo cosmético, nunca ventajas.</div></div>
    <p class="muted fine">Gana XP de temporada jugando partidas, completando misiones y resolviendo el desafío diario.</p>`;
}

export function initSeason() {
  $('#seasonBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-claim]');
    if (!b) return;
    if (b.dataset.claim === 'all') {
      let n = 0;
      for (let l = 1; l <= seasonLevel(); l += 1) if (claim(l)) n += 1;
      if (n) {
        sfx.coin();
        toast(`🎁 ${n} recompensa${n > 1 ? 's' : ''} reclamada${n > 1 ? 's' : ''}`);
      }
    } else if (claim(Number(b.dataset.claim))) {
      sfx.coin();
      toast(`🎁 ${rewardText(rewardFor(Number(b.dataset.claim)))}`);
    }
    renderSeason();
  });
}
