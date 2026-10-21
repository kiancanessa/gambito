// Datos estáticos del juego: campaña, niveles de IA, tienda y frases.

export const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
export const PIECE_NAME = { k: 'Rey', q: 'Reina', r: 'Torre', b: 'Alfil', n: 'Caballo', p: 'Peón' };
export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Rivales de la campaña "Valle de Peones". `blunder` = probabilidad de jugada al azar.
export const CAMPAIGN = [
  {
    id: 'pip', name: 'Pip el Granjero', glyph: 'p', color: '#8bc34a', title: 'Cultivador de peones',
    skill: 0, depth: 1, movetime: 150, blunder: 0.4, reward: 40,
    intro: [
      ['narrator', 'Despiertas en el borde del tablero. Un viento frío mueve la hierba de Escaquia.'],
      ['pip', '¡Eh, tú! Un peón sin dueño... Las piezas negras patrullan el valle. Si quieres pasar, tendrás que ganarme.'],
    ],
    start: '¡A ver cómo se mueve un peón sin dueño!',
    win: '¡Caramba! Pasa, peón. Hay algo distinto en ti...',
    lose: 'Vuelve a intentarlo, peón. Todos empezamos en la segunda fila.',
    check: '¡Cuidado, mi rey!',
  },
  {
    id: 'bram', name: 'Bram el Escudero', glyph: 'n', color: '#ffb74d', title: 'Aprendiz de caballero',
    skill: 2, depth: 2, movetime: 200, blunder: 0.22, reward: 60,
    intro: [
      ['bram', 'Mi señor el Caballo dice que los peones no saben pensar. Voy a demostrarle que se equivoca... o que acierta.'],
    ],
    start: 'Cuidado, ¡que mi señor me está mirando!',
    win: 'No esperaba esa jugada. Mi señor no lo va a creer.',
    lose: '¡Ja! Un salto en L y estabas perdido.',
    check: '¡Un jaque! Mi señor estaría orgulloso... de ti.',
  },
  {
    id: 'mira', name: 'Mira la Centinela', glyph: 'b', color: '#4dd0e1', title: 'Guardiana del puente',
    skill: 5, depth: 4, movetime: 300, blunder: 0.1, reward: 90,
    intro: [
      ['narrator', 'Un puente de piedra cruza el río de las 64 casillas. Una arquera te corta el paso en diagonal.'],
      ['mira', 'Nadie cruza sin pasar mi examen. Y yo veo todas las diagonales.'],
    ],
    start: 'Nadie cruza sin que yo lo vea venir.',
    win: 'El puente es tuyo. Pero tras él, el Capitán no será tan amable.',
    lose: 'Las diagonales nunca perdonan.',
    check: 'Te tengo en la mira.',
  },
  {
    id: 'roque', name: 'Capitán Roque', glyph: 'r', color: '#ef5350', title: 'Capitán de la guarnición',
    skill: 9, depth: 6, movetime: 450, blunder: 0.03, reward: 130,
    intro: [
      ['roque', 'He visto caer a cien peones valientes. Ninguno enrocó a tiempo. Defiéndete bien.'],
    ],
    start: 'Mi guarnición no se rinde jamás.',
    win: 'Imposible... un simple peón rompió mi muro. El Regente tiene que saberlo.',
    lose: 'Mi muro no se mueve. Ni se moverá.',
    check: '¡Jaque! Mi rey no se rinde tan fácil.',
  },
  {
    id: 'regente', name: 'El Regente Gris', glyph: 'q', color: '#ba68c8', title: 'Jefe del Valle',
    skill: 13, depth: 9, movetime: 800, blunder: 0, reward: 250,
    intro: [
      ['narrator', 'La niebla se disipa. En el centro del valle, un trono de ceniza y una figura sin rostro.'],
      ['regente', 'Hace mil partidas que nadie llega hasta aquí. Tu forma de jugar me resulta... familiar. Veamos quién eres.'],
    ],
    start: 'Muéstrame quién eres, peón.',
    win: 'Pasaste el Valle. Pero el Bosque de Alfiles guarda secretos que ni yo conozco...',
    lose: 'Familiar, sí. Pero aún no eres quien crees ser.',
    check: 'Un buen jaque. Casi me hace recordar.',
  },
];

export const CHAPTER = { name: 'Capítulo 1 · Valle de Peones', next: 'Capítulo 2 · Bosque de Alfiles' };

// Niveles de la partida rápida
export const QUICK_LEVELS = [
  { id: 1, name: 'Novato', skill: 0, depth: 1, movetime: 120, blunder: 0.45, mult: 0.5 },
  { id: 2, name: 'Aprendiz', skill: 2, depth: 2, movetime: 180, blunder: 0.25, mult: 0.7 },
  { id: 3, name: 'Aficionado', skill: 5, depth: 4, movetime: 300, blunder: 0.1, mult: 1 },
  { id: 4, name: 'Club', skill: 9, depth: 6, movetime: 450, blunder: 0.03, mult: 1.4 },
  { id: 5, name: 'Experto', skill: 14, depth: 9, movetime: 700, blunder: 0, mult: 2 },
  { id: 6, name: 'Maestro', skill: 20, depth: 13, movetime: 1200, blunder: 0, mult: 3 },
];

// Rarezas y colores
export const RARITY = {
  common: { label: 'Común', color: '#9aa4b2' },
  rare: { label: 'Rara', color: '#4dabf7' },
  epic: { label: 'Épica', color: '#b36bff' },
  legendary: { label: 'Legendaria', color: '#ffb02e' },
};

// Tienda. `id` se usa como clase CSS: .set-<id>, .board-<id>, y como clave de efectos.
export const SHOP = {
  sets: [
    { id: 'classic', name: 'Clásico', rarity: 'common', price: 0 },
    { id: 'gold', name: 'Oro y Obsidiana', rarity: 'epic', price: 400 },
    { id: 'neon', name: 'Neón Cyber', rarity: 'epic', price: 350 },
    { id: 'candy', name: 'Dulces', rarity: 'rare', price: 220 },
    { id: 'ice', name: 'Hielo y Fuego', rarity: 'rare', price: 260 },
    { id: 'dragon', name: 'Escamas de Dragón', rarity: 'legendary', price: 900 },
    // Premio exclusivo del Royale Circuit: no se vende (el servidor rechaza comprarlo).
    { id: 'royal', name: 'Corona del Circuito', rarity: 'legendary', price: 0, exclusive: 'circuit' },
  ],
  boards: [
    { id: 'wood', name: 'Madera', rarity: 'common', price: 0 },
    { id: 'forest', name: 'Bosque', rarity: 'common', price: 120 },
    { id: 'night', name: 'Noche Estrellada', rarity: 'rare', price: 250 },
    { id: 'sakura', name: 'Jardín Sakura', rarity: 'rare', price: 300 },
    { id: 'neon', name: 'Rejilla Neón', rarity: 'epic', price: 450 },
    { id: 'lava', name: 'Magma', rarity: 'legendary', price: 800 },
  ],
  fx: [
    { id: 'sparks', name: 'Chispas', rarity: 'common', price: 0 },
    { id: 'confetti', name: 'Confeti', rarity: 'rare', price: 180 },
    { id: 'embers', name: 'Brasas', rarity: 'epic', price: 320 },
    { id: 'frost', name: 'Escarcha', rarity: 'epic', price: 320 },
  ],
};

export const DEFAULT_OWNED = ['set:classic', 'board:wood', 'fx:sparks'];

// Frases de las piezas del jugador, por evento.
export const QUIPS = {
  n: {
    capture: ['¡Salto y bocado! Esto sí que es movilidad.', 'Qué elegante... y qué en L.'],
    check: ['Jaque. De nada.', 'Doy un salto y el rey se pone nervioso.'],
    move: ['Sí, claro, siempre me toca saltar a mí.', 'Si me pierdes, avísame con tiempo.'],
  },
  r: {
    capture: ['Aplastado. Como en los viejos tiempos.', 'Recto, firme y sin florituras.'],
    check: ['Jaque. Por columna, como Dios manda.', 'Muralla en movimiento.'],
    move: ['Odio moverme. Pero vale.', 'Más te vale proteger mi esquina.'],
  },
  b: {
    capture: ['Nada es casual, todo es diagonal.', 'Cada casilla tiene un sentido, amigo mío.'],
    check: ['Jaque en diagonal. Pura filosofía.', 'El camino torcido también llega al rey.'],
    move: ['Observo. Siempre observo.', 'Las diagonales hablan por mí.'],
  },
  q: {
    capture: ['Reinas hay muchas, pero como yo, ninguna.', '¿Alguien más quiere probar?'],
    check: ['Jaque. De rodillas.', 'Un gesto mío y se acaba la partida.'],
    move: ['Que nadie me toque, que me enfado.', 'Cuidado: la reina nunca se rinde.'],
  },
  p: {
    capture: ['¡Un peón también muerde!', 'Pequeño, pero matón.'],
    check: ['¡Yo di jaque! ¡Un peón!', 'Os dije que los peones importan.'],
    promote: ['¡CORONADO! ¡Os lo dije!', '¡De la segunda fila al trono!'],
    move: ['Un paso más cerca de la corona.', 'Hoy peón, mañana reina.'],
  },
  k: {
    capture: ['Los reyes también pelean, a veces.'],
    check: ['Jaque con el rey. Qué valor.'],
    move: ['Prefiero ir despacio.'],
    castle: ['Un enroque a tiempo ahorra mil disgustos.'],
  },
};

export const DAILY_REWARDS = [30, 40, 50, 60, 80, 100, 200];

export const XP_PER_LEVEL = (lvl) => 100 + (lvl - 1) * 60;

// ---------- Online ----------
export const LEAGUES = [
  { id: 'pawn', name: 'Peón', min: 0, glyph: 'p', color: '#8bc34a' },
  { id: 'knight', name: 'Caballo', min: 900, glyph: 'n', color: '#ffb74d' },
  { id: 'bishop', name: 'Alfil', min: 1100, glyph: 'b', color: '#4dd0e1' },
  { id: 'rook', name: 'Torre', min: 1300, glyph: 'r', color: '#ef5350' },
  { id: 'queen', name: 'Reina', min: 1500, glyph: 'q', color: '#ba68c8' },
  { id: 'king', name: 'Rey', min: 1800, glyph: 'k', color: '#ffd54f' },
];
export const leagueOf = (rating) => [...LEAGUES].reverse().find((l) => rating >= l.min) ?? LEAGUES[0];

export const TIME_CONTROLS = [
  { id: 'bullet', label: 'Bala', sub: '1 min' },
  { id: 'blitz3', label: 'Blitz', sub: '3 min' },
  { id: 'blitz3_2', label: 'Blitz', sub: '3 + 2' },
  { id: 'blitz5', label: 'Blitz', sub: '5 min' },
  { id: 'rapid10', label: 'Rápida', sub: '10 min' },
  { id: 'rapid15_10', label: 'Rápida', sub: '15 + 10' },
  { id: 'none', label: 'Sin reloj', sub: 'relajada' },
];

// Frases rápidas (el servidor solo valida el id). Sustituyen al chat libre: sin toxicidad.
export const EMOTES = [
  '¡Buena jugada!', '¡Qué suerte!', 'Piensa rápido...', '¡Jaque!', '¿Tablas?', 'Gracias por la partida',
  '¡Vamos!', 'Uy... eso dolió', '¡Gran partida!', '¿Revancha?', '¡Cuidado!', '😂',
];
