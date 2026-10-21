// Datos de progresión compartidos por el cliente y el servidor: temporadas, misiones, logros y desbloqueos.
// Es lógica pura (sin DOM ni base de datos). El servidor es quien la aplica: el cliente solo la usa para mostrarla.
//
// Principios (ver docs/PROGRESION.md):
//  · El nivel de cuenta no depende del rating. La XP sale de partidas COMPLETADAS, desafíos y objetivos de habilidad, no solo de ganar.
//  · Todo lo que da XP o premios lo comprueba el servidor con lo que él mismo vio (partidas online, desafío diario, torneos).
//  · Sin rachas que se pierdan por faltar un día: nada de lo acumulado caduca ni se reinicia.

// ---------- Reglas de XP (el servidor las aplica; aquí también para explicarlas en pantalla) ----------
export const XP_RULES = {
  minPlies: 10, // una partida con menos de 10 jugadas en total no cuenta
  base: 25, // por participar y terminar la partida
  complete: 15, // por no abandonar (terminar por mate, tablas, tiempo, o ganar)
  abandonBase: 10, // quien abandona (se rinde o se desconecta y pierde) recibe solo esto
  win: 10,
  draw: 6,
  rated: 8, // clasificatoria
  mate: 10, // dar jaque mate
  check: 3, // por jaque dado, hasta 3
  maxChecks: 3,
  promotion: 5,
  underdog: 10, // ganar a un rival con 100+ de rating más
  perGameCap: 70,
  pairPerDay: 3, // partidas con el mismo rival que dan XP por día
  dailySoftCap: 800, // XP de partidas por día; pasado el tope se recibe el 25 %
  softFactor: 0.25,
  puzzle: 40, // desafío diario resuelto
  review: 15, // revisar una partida propia en la repetición
  reviewDailyCap: 45,
  circuitParticipation: 40,
};

// ---------- Temporadas ----------
const ONE_DAY = 86_400_000;
export const SEASON_CLAIM_GRACE_MS = 14 * ONE_DAY; // tras terminar, sus recompensas se pueden reclamar 14 días más
export const SEASON_MIN_RANKED_GAMES = 3; // partidas clasificatorias para aparecer en la clasificación de temporada
export const SEASON_RATING_CARRY = 0.5; // el rating de partida de cada temporada arranca a mitad de camino hacia 1000

const S1_REWARDS = {
  3: { coins: 60 },
  5: { item: ['board', 'forest'], label: 'Tablero Bosque' },
  8: { item: ['fx', 'confetti'], label: 'Efecto Confeti' },
  10: { coins: 150 },
  14: { item: ['set', 'candy'], label: 'Piezas Dulces' },
  18: { item: ['board', 'night'], label: 'Tablero Noche Estrellada' },
  22: { item: ['fx', 'embers'], label: 'Efecto Brasas' },
  25: { coins: 300 },
  27: { item: ['set', 'ice'], label: 'Piezas Hielo y Fuego' },
  30: { item: ['board', 'sakura'], label: 'Tablero Jardín Sakura' },
};

export const SEASONS = [
  {
    id: 1,
    name: 'Temporada 1 · La Noche de las Torres',
    short: 'La Noche de las Torres',
    startsAt: '2026-09-01',
    endsAt: '2026-11-30',
    levels: 30,
    xpPerLevel: 120,
    theme: { accent: '#8b5cf6', accent2: '#22e1ff', glyph: '♜', tagline: 'Las torres vigilan el tablero bajo la luna.' },
    rewards: S1_REWARDS,
    defaultReward: { coins: 40 },
  },
  {
    id: 2,
    name: 'Temporada 2 · El Bosque de Alfiles',
    short: 'El Bosque de Alfiles',
    startsAt: '2026-12-01',
    endsAt: '2027-02-28',
    levels: 30,
    xpPerLevel: 130,
    theme: { accent: '#34e3a0', accent2: '#ffd24a', glyph: '♝', tagline: 'Diagonales entre los árboles: aquí gana quien ve más lejos.' },
    rewards: {
      3: { coins: 60 },
      5: { item: ['fx', 'frost'], label: 'Efecto Escarcha' },
      10: { coins: 150 },
      14: { item: ['set', 'neon'], label: 'Piezas Neón Cyber' },
      18: { item: ['board', 'neon'], label: 'Rejilla Neón' },
      22: { coins: 200 },
      25: { coins: 300 },
      27: { item: ['set', 'gold'], label: 'Piezas Oro y Obsidiana' },
      30: { item: ['board', 'lava'], label: 'Tablero Magma' },
    },
    defaultReward: { coins: 40 },
  },
  {
    id: 3,
    name: 'Temporada 3 · El Gambito del Alba',
    short: 'El Gambito del Alba',
    startsAt: '2027-03-01',
    endsAt: '2027-05-31',
    levels: 30,
    xpPerLevel: 130,
    theme: { accent: '#ff8a98', accent2: '#ffd24a', glyph: '♞', tagline: 'Sacrifica un peón al amanecer y gana la iniciativa.' },
    rewards: {
      3: { coins: 60 },
      10: { coins: 150 },
      15: { item: ['fx', 'confetti'], label: 'Efecto Confeti' },
      20: { coins: 250 },
      25: { coins: 300 },
      30: { item: ['set', 'dragon'], label: 'Escamas de Dragón' },
    },
    defaultReward: { coins: 40 },
  },
];

export const seasonStart = (s) => Date.parse(`${s.startsAt}T00:00:00.000Z`);
export const seasonEnd = (s) => Date.parse(`${s.endsAt}T23:59:59.999Z`);
export const seasonById = (id) => SEASONS.find((s) => s.id === Number(id)) ?? null;
/** Temporada que contiene el instante `now` (null en un hueco entre temporadas). */
export const seasonAt = (now) => SEASONS.find((s) => now >= seasonStart(s) && now <= seasonEnd(s)) ?? null;
/** ¿Se pueden reclamar todavía las recompensas de esta temporada? Hasta 14 días después de terminar. */
export const seasonClaimable = (s, now) => now >= seasonStart(s) && now <= seasonEnd(s) + SEASON_CLAIM_GRACE_MS;
export const seasonLevelOf = (s, xp) => Math.min(s.levels, Math.floor(Math.max(0, xp) / s.xpPerLevel));
export const seasonRewardFor = (s, level) => s.rewards[level] ?? s.defaultReward;
export const seasonStatus = (s, now) => (now < seasonStart(s) ? 'upcoming' : now <= seasonEnd(s) ? 'current' : 'past');

// ---------- Periodos de las misiones ----------
export const DAY_MS = ONE_DAY;
export const EPOCH_MS = Date.UTC(2026, 9, 1); // 1 oct 2026 (jueves), el mismo día 0 del desafío diario
export const dayIdOf = (ms) => Math.floor((ms - EPOCH_MS) / ONE_DAY);
export const weekIdOf = (ms) => Math.floor((dayIdOf(ms) + 3) / 7); // las semanas empiezan en lunes (UTC)
export const dayWindow = (id) => [EPOCH_MS + id * ONE_DAY, EPOCH_MS + (id + 1) * ONE_DAY];
export const weekWindow = (id) => [EPOCH_MS + (id * 7 - 3) * ONE_DAY, EPOCH_MS + ((id + 1) * 7 - 3) * ONE_DAY];

// ---------- Misiones ----------
// `metric` indica qué cuenta; el servidor lo calcula sobre los eventos verificados del periodo.
export const METRICS = {
  games: (e) => (e.kind === 'game' ? 1 : 0),
  games_clean: (e) => (e.kind === 'game' && !e.meta.abandon ? 1 : 0),
  wins: (e) => (e.kind === 'game' && e.meta.result === 'win' ? 1 : 0),
  rated: (e) => (e.kind === 'game' && e.meta.rated ? 1 : 0),
  checks: (e) => (e.kind === 'game' ? (e.meta.checks ?? 0) : 0),
  promos: (e) => (e.kind === 'game' ? (e.meta.promotions ?? 0) : 0),
  mates: (e) => (e.kind === 'game' && e.meta.mate ? 1 : 0),
  win_keepqueen: (e) => (e.kind === 'game' && e.meta.result === 'win' && !e.meta.lostQueen ? 1 : 0),
  win_black: (e) => (e.kind === 'game' && e.meta.result === 'win' && e.meta.color === 'b' ? 1 : 0),
  win_underdog: (e) => (e.kind === 'game' && e.meta.result === 'win' && e.meta.underdog ? 1 : 0),
  puzzle: (e) => (e.kind === 'puzzle' ? 1 : 0),
  circuit: (e) => (e.kind === 'circuit_join' ? 1 : 0),
  review: (e) => (e.kind === 'review' ? 1 : 0),
};

export const MISSIONS_DAILY = [
  { id: 'd_play3', text: 'Completa 3 partidas online', metric: 'games', target: 3, coins: 30, xp: 40 },
  { id: 'd_clean1', text: 'Termina una partida sin abandonar', metric: 'games_clean', target: 1, coins: 20, xp: 30 },
  { id: 'd_puzzle', text: 'Completa el desafío táctico del día', metric: 'puzzle', target: 1, coins: 40, xp: 50 },
  { id: 'd_review', text: 'Revisa una partida anterior en la repetición', metric: 'review', target: 1, coins: 25, xp: 35 },
  { id: 'd_checks', text: 'Da 5 jaques en tus partidas', metric: 'checks', target: 5, coins: 30, xp: 40 },
  { id: 'd_win1', text: 'Gana 1 partida online', metric: 'wins', target: 1, coins: 40, xp: 50 },
  { id: 'd_promo', text: 'Corona un peón en una partida', metric: 'promos', target: 1, coins: 40, xp: 50 },
  { id: 'd_rated', text: 'Juega 1 partida clasificatoria', metric: 'rated', target: 1, coins: 40, xp: 50 },
  { id: 'd_keepqueen', text: 'Gana una partida sin perder tu dama', metric: 'win_keepqueen', target: 1, coins: 50, xp: 60 },
];
export const MISSIONS_WEEKLY = [
  { id: 'w_play10', text: 'Completa 10 partidas online', metric: 'games', target: 10, coins: 150, xp: 180 },
  { id: 'w_win5', text: 'Gana 5 partidas online', metric: 'wins', target: 5, coins: 200, xp: 200 },
  { id: 'w_circuit', text: 'Participa en un Royale Circuit', metric: 'circuit', target: 1, coins: 180, xp: 200 },
  { id: 'w_puzzle4', text: 'Resuelve 4 desafíos diarios', metric: 'puzzle', target: 4, coins: 200, xp: 220 },
  { id: 'w_review3', text: 'Revisa 3 partidas en la repetición', metric: 'review', target: 3, coins: 120, xp: 140 },
  { id: 'w_black', text: 'Gana 2 partidas con negras', metric: 'win_black', target: 2, coins: 180, xp: 180 },
  { id: 'w_underdog', text: 'Gana a un rival con 100+ de rating más', metric: 'win_underdog', target: 1, coins: 220, xp: 240 },
  { id: 'w_clean5', text: 'Termina 5 partidas sin abandonar', metric: 'games_clean', target: 5, coins: 120, xp: 150 },
  { id: 'w_mate3', text: 'Da jaque mate en 3 partidas', metric: 'mates', target: 3, coins: 180, xp: 200 },
];
export const MISSION_PICKS = { daily: 3, weekly: 3 };

export const missionDef = (kind, id) => (kind === 'daily' ? MISSIONS_DAILY : MISSIONS_WEEKLY).find((m) => m.id === id) ?? null;

function seeded(seed) {
  let s = (Math.abs(seed) * 9301 + 49297) % 233280 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Misiones del periodo (las mismas para todos, deterministas): n distintas sacadas del conjunto. */
export function missionsFor(kind, periodId) {
  const pool = kind === 'daily' ? MISSIONS_DAILY : MISSIONS_WEEKLY;
  const rand = seeded(periodId * (kind === 'daily' ? 1 : 7) + 13);
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, MISSION_PICKS[kind]);
}

/** Progreso de una misión sobre los eventos del periodo. */
export const missionProgress = (def, events) => Math.min(def.target, events.reduce((n, e) => n + (METRICS[def.metric]?.(e) ?? 0), 0));

// ---------- Logros ----------
// `stat` es una estadística verificada por el servidor (ver progression.js → statsOf).
export const ACHIEVEMENTS = [
  { id: 'games_1', name: 'Primer movimiento', text: 'Completa tu primera partida online', stat: 'games', target: 1, coins: 20, xp: 30 },
  { id: 'games_10', name: 'Aficionado', text: 'Completa 10 partidas online', stat: 'games', target: 10, coins: 40, xp: 50 },
  { id: 'games_50', name: 'Habitual', text: 'Completa 50 partidas online', stat: 'games', target: 50, coins: 100, xp: 100 },
  { id: 'games_200', name: 'Veterano del tablero', text: 'Completa 200 partidas online', stat: 'games', target: 200, coins: 300, xp: 250 },
  { id: 'wins_1', name: 'Primera victoria', text: 'Gana una partida online', stat: 'wins', target: 1, coins: 20, xp: 30 },
  { id: 'wins_10', name: 'Diez victorias', text: 'Gana 10 partidas online', stat: 'wins', target: 10, coins: 60, xp: 80 },
  { id: 'wins_50', name: 'Ganador nato', text: 'Gana 50 partidas online', stat: 'wins', target: 50, coins: 200, xp: 200 },
  { id: 'mate_1', name: 'Jaque mate', text: 'Da tu primer jaque mate online', stat: 'mates', target: 1, coins: 20, xp: 30 },
  { id: 'mate_10', name: 'Rematador', text: 'Da 10 jaques mate online', stat: 'mates', target: 10, coins: 80, xp: 100 },
  { id: 'rated_10', name: 'Competidor', text: 'Juega 10 partidas clasificatorias', stat: 'rated', target: 10, coins: 60, xp: 80 },
  { id: 'circuit_1', name: 'Debutante del Circuit', text: 'Participa en un Royale Circuit', stat: 'circuits', target: 1, coins: 50, xp: 60 },
  { id: 'circuit_final', name: 'Finalista', text: 'Llega a la final de un Royale Circuit', stat: 'circuitFinals', target: 1, coins: 120, xp: 150 },
  { id: 'circuit_champion', name: 'Campeón del Circuit', text: 'Gana un Royale Circuit', stat: 'champions', target: 1, coins: 250, xp: 300 },
  { id: 'puzzle_1', name: 'Táctico', text: 'Resuelve un desafío diario', stat: 'puzzles', target: 1, coins: 20, xp: 30 },
  { id: 'puzzle_10', name: 'Mente táctica', text: 'Resuelve 10 desafíos diarios', stat: 'puzzles', target: 10, coins: 80, xp: 100 },
  { id: 'puzzle_30', name: 'Maestro de mates', text: 'Resuelve 30 desafíos diarios', stat: 'puzzles', target: 30, coins: 200, xp: 220 },
  { id: 'review_5', name: 'Aprender de los errores', text: 'Revisa 5 partidas en la repetición', stat: 'reviews', target: 5, coins: 50, xp: 70 },
  { id: 'mission_10', name: 'Constante', text: 'Reclama 10 misiones', stat: 'missions', target: 10, coins: 60, xp: 80 },
  { id: 'mission_50', name: 'Misionero', text: 'Reclama 50 misiones', stat: 'missions', target: 50, coins: 200, xp: 200 },
  { id: 'level_5', name: 'Nivel 5', text: 'Alcanza el nivel 5 de cuenta', stat: 'level', target: 5, coins: 40, xp: 0 },
  { id: 'level_10', name: 'Nivel 10', text: 'Alcanza el nivel 10 de cuenta', stat: 'level', target: 10, coins: 100, xp: 0 },
  { id: 'level_20', name: 'Nivel 20', text: 'Alcanza el nivel 20 de cuenta', stat: 'level', target: 20, coins: 250, xp: 0 },
  { id: 'season_10', name: 'Pase en marcha', text: 'Alcanza el nivel 10 en una temporada', stat: 'seasonLevel', target: 10, coins: 60, xp: 80 },
  { id: 'season_30', name: 'Pase completo', text: 'Completa los 30 niveles de una temporada', stat: 'seasonLevel', target: 30, coins: 250, xp: 250 },
];

// ---------- Desbloqueos visuales por nivel de cuenta ----------
// Puramente estéticos: marcos de avatar y títulos de perfil. Se desbloquean solos al alcanzar el nivel.
export const LEVEL_UNLOCKS = [
  { level: 2, kind: 'frame', id: 'bronze', name: 'Marco Bronce', color: '#cd7f32' },
  { level: 3, kind: 'title', id: 'apprentice', name: 'Aprendiz' },
  { level: 5, kind: 'frame', id: 'cyan', name: 'Marco Cian', color: '#22e1ff' },
  { level: 7, kind: 'title', id: 'strategist', name: 'Estratega' },
  { level: 10, kind: 'frame', id: 'violet', name: 'Marco Violeta', color: '#8b5cf6' },
  { level: 12, kind: 'title', id: 'tactician', name: 'Táctico' },
  { level: 15, kind: 'frame', id: 'gold', name: 'Marco Dorado', color: '#ffd24a' },
  { level: 20, kind: 'title', id: 'master', name: 'Maestro del tablero' },
  { level: 25, kind: 'frame', id: 'aurora', name: 'Marco Aurora', color: '#34e3a0' },
  { level: 30, kind: 'title', id: 'legend', name: 'Leyenda de CHECKPOINT' },
];
export const unlocksAt = (level) => LEVEL_UNLOCKS.filter((u) => u.level <= level);
