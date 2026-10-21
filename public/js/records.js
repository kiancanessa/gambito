// Récords personales: se calculan con tus partidas terminadas y se anuncian en el diálogo de resultado.
// Un récord solo se anuncia cuando supera una marca anterior (la primera vez solo se fija la línea de base).
import { feedback } from './feedback.js';
import { save, state } from './store.js';

export const defaultRecords = () => ({ winStreak: 0, bestWinStreak: 0, peakRating: 0, fastestMate: 0, mostChecks: 0 });

/**
 * @param {{ result: 'win'|'loss'|'draw', plies: number, checks: number, mate?: boolean, rating?: number|null }} g
 * @returns {{ id: string, label: string }[]} récords nuevos de esta partida
 */
export function updateRecords({ result, plies, checks, mate = false, rating = null }) {
  state.records = { ...defaultRecords(), ...state.records };
  const r = state.records;
  const news = [];

  r.winStreak = result === 'win' ? r.winStreak + 1 : 0;
  if (r.winStreak > r.bestWinStreak) {
    if (r.bestWinStreak >= 2 || r.winStreak >= 3) news.push({ id: 'streak', label: `Racha de ${r.winStreak} victorias seguidas` });
    r.bestWinStreak = r.winStreak;
  }
  if (rating != null && rating > r.peakRating) {
    if (r.peakRating > 0) news.push({ id: 'rating', label: `Tu mejor rating: ${rating} pts` });
    r.peakRating = rating;
  }
  if (result === 'win' && mate && plies > 0 && (r.fastestMate === 0 || plies < r.fastestMate)) {
    if (r.fastestMate > 0) news.push({ id: 'mate', label: `Mate más rápido: en ${Math.ceil(plies / 2)} jugadas` });
    r.fastestMate = plies;
  }
  if (checks > r.mostChecks) {
    if (r.mostChecks >= 3 && checks >= 4) news.push({ id: 'checks', label: `${checks} jaques en una partida` });
    r.mostChecks = checks;
  }
  save();
  return news;
}

// Anuncia los récords (sonido y tarjeta). Se llama cuando aparece el resultado, no durante la partida.
export const announceRecords = (news) => news.forEach((n, i) => setTimeout(() => feedback('record', { title: 'Récord personal', text: n.label }), 600 + i * 900));

export const recordsHtml = (news) => (news.length ? `<ul class="rewards record-list">${news.map((n) => `<li><span>🏅 Récord personal</span><b>${n.label}</b></li>`).join('')}</ul>` : '');
