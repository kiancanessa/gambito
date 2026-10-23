// Catálogo de cosméticos de CHECKPOINT: datos puros compartidos por el cliente y el servidor.
//
// Todo artículo es solo estético: no cambia reglas, tamaño de objetivos ni información visible. El catálogo es estático y
// ampliable (añadir un objeto a ITEMS); lo que decide si un jugador lo tiene es su inventario, que vive en el servidor
// (cartera: `owned`) y solo el servidor puede ampliar. El cliente muestra, previsualiza y pide equipar.
//
// Método de desbloqueo (`unlock.type`):
//   default      todos lo tienen
//   level        al alcanzar un nivel de cuenta
//   achievement  al conseguir un logro (progression-data.js)
//   season       recompensa gratuita del pase de una temporada (se reclama allí)
//   circuit      premio del Royale Circuit
//   purchase     comprable con oros (moneda blanda ganada jugando; precio fijado en el servidor)
//   future       previsto, aún no disponible (`status: 'soon'`). Aquí se engancharán futuras compras: no hay pagos reales.
//
// Derechos: todo el arte es original (formas, degradados y símbolos genéricos); no hay personajes ni marcas de terceros.
import { DEFAULT_EQUIPPED, DEFAULT_OWNED, RARITY, SHOP } from './data.js';

export { RARITY };

export const CATEGORIES = [
  { id: 'avatar', label: 'Avatares', one: 'Avatar', hint: 'Tu imagen en el perfil y en la barra superior' },
  { id: 'frame', label: 'Marcos', one: 'Marco', hint: 'Borde de tu avatar' },
  { id: 'board', label: 'Tableros', one: 'Tablero', hint: 'Tema visual del tablero' },
  { id: 'set', label: 'Piezas', one: 'Piezas', hint: 'Diseño de las piezas (solo materiales y color)' },
  { id: 'fx', label: 'Efectos', one: 'Efecto', hint: 'Partículas al capturar' },
  { id: 'victory', label: 'Victoria', one: 'Efecto de victoria', hint: 'Lo que ves al ganar una partida' },
  { id: 'crown', label: 'Coronación', one: 'Coronación', hint: 'Animación al promocionar un peón' },
  { id: 'badge', label: 'Insignias', one: 'Insignia', hint: 'Pequeño emblema junto a tu nombre' },
  { id: 'title', label: 'Títulos', one: 'Título', hint: 'Frase bajo tu nombre' },
  { id: 'decor', label: 'Decoración', one: 'Decoración', hint: 'Fondo de tu tarjeta de perfil' },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

const avatar = (id, name, desc, art, unlock, rarity = 'common') => ({ id, category: 'avatar', name, desc, rarity, asset: art, unlock });
const frame = (id, name, desc, color, style, unlock, rarity = 'common') => ({ id, category: 'frame', name, desc, rarity, asset: { color, style }, unlock });
const badge = (id, name, desc, icon, color, unlock, rarity = 'rare') => ({ id, category: 'badge', name, desc, rarity, asset: { icon, color }, unlock });
const title = (id, name, desc, unlock, rarity = 'common') => ({ id, category: 'title', name, desc, rarity, asset: { text: name }, unlock });
const decor = (id, name, desc, unlock, rarity = 'common') => ({ id, category: 'decor', name, desc, rarity, asset: { css: `decor-${id}` }, unlock });

// Piezas y tableros nuevos (la referencia visual está en checkpoint.css, clases `set-<id>` / `board-<id>`).
const NEW_SETS = [
  { id: 'marble', name: 'Mármol y Pizarra', desc: 'Marfil pulido frente a pizarra oscura.', rarity: 'rare', unlock: { type: 'achievement', id: 'games_50' } },
  { id: 'cobalt', name: 'Cobalto y Plata', desc: 'Azul profundo contra plata brillante.', rarity: 'epic', unlock: { type: 'level', level: 18 } },
];
const NEW_BOARDS = [{ id: 'slate', name: 'Pizarra', desc: 'Piedra gris sobria, sin distracciones.', rarity: 'common', unlock: { type: 'level', level: 7 } }];

const SHOP_DESC = {
  classic: 'El aspecto de siempre.', gold: 'Oro macizo y obsidiana violeta.', neon: 'Líneas de neón cian y magenta.', candy: 'Colores de caramelo.', ice: 'Hielo translúcido y brasas.',
  dragon: 'Escamas verdes y rojas.', royal: 'Premio del Royale Circuit: oro y púrpura real.', wood: 'Madera clásica.', forest: 'Verdes de bosque.', night: 'Cielo estrellado.',
  sakura: 'Pétalos de cerezo.', lava: 'Magma y grietas.', sparks: 'Chispas doradas.', confetti: 'Confeti de colores.', embers: 'Brasas ascendentes.', frost: 'Cristales de escarcha.',
};

function fromShop(group, category) {
  return SHOP[group].map((s) => ({
    id: s.id,
    category,
    name: s.name,
    desc: SHOP_DESC[s.id] ?? '',
    rarity: s.rarity,
    asset: { ref: `${category}-${s.id}` }, // referencia a un recurso existente (3D / CSS)
    unlock: s.exclusive === 'circuit' ? { type: 'circuit' } : s.price === 0 ? { type: 'default' } : { type: 'purchase', price: s.price },
  }));
}

const extra = (list, category) => list.map((s) => ({ ...s, category, asset: { ref: `${category}-${s.id}` } }));

export const ITEMS = [
  // ----- Avatares (arte en cosmetics-art.js) -----
  avatar('pawn', 'Peón', 'Pequeño pero con futuro.', { piece: 'p', scene: 'halo', a: '#22e1ff', b: '#8b5cf6' }, { type: 'default' }),
  avatar('knight', 'Caballo', 'Salta donde nadie espera.', { piece: 'n', scene: 'grid', a: '#34e3a0', b: '#22e1ff' }, { type: 'level', level: 3 }),
  avatar('bishop', 'Alfil', 'Diagonales largas, ideas claras.', { piece: 'b', scene: 'rays', a: '#ffd24a', b: '#ff8a4c' }, { type: 'level', level: 6 }),
  avatar('sentinel', 'Centinela', 'Nadie pasa por su columna.', { piece: 'r', scene: 'grid', a: '#7dd3fc', b: '#4d6bff' }, { type: 'level', level: 8 }, 'rare'),
  avatar('rook', 'Torre', 'Firme en la columna abierta.', { piece: 'r', scene: 'halo', a: '#8b5cf6', b: '#4d6bff' }, { type: 'level', level: 10 }, 'rare'),
  avatar('gambit', 'Gambito', 'Sacrifica hoy, gana mañana.', { piece: 'n', scene: 'flames', a: '#ff8a98', b: '#ff5a1f' }, { type: 'level', level: 12 }, 'rare'),
  avatar('queen', 'Dama', 'La pieza más poderosa del tablero.', { piece: 'q', scene: 'rays', a: '#ff8a98', b: '#ffd24a' }, { type: 'level', level: 15 }, 'epic'),
  avatar('phantom', 'Fantasma', 'Cuando lo ves, ya es tarde.', { piece: 'p', scene: 'stars', a: '#c4b5fd', b: '#22e1ff' }, { type: 'level', level: 20 }, 'epic'),
  avatar('king', 'Rey', 'Todo gira a tu alrededor.', { piece: 'k', scene: 'rays', a: '#ffd24a', b: '#b8860b' }, { type: 'level', level: 25 }, 'legendary'),
  avatar('monarch', 'Monarca', 'El tablero entero te obedece.', { piece: 'k', scene: 'stars', a: '#fff1b8', b: '#ff8a98' }, { type: 'level', level: 35 }, 'legendary'),
  avatar('comet', 'Cometa', 'Rápido y brillante.', { art: 'comet', scene: 'stars', a: '#22e1ff', b: '#8b5cf6' }, { type: 'achievement', id: 'wins_1' }),
  avatar('orbit', 'Órbita', 'Siempre dando vueltas a una idea.', { art: 'orbit', scene: 'stars', a: '#34e3a0', b: '#4d6bff' }, { type: 'achievement', id: 'puzzle_10' }, 'rare'),
  avatar('prism', 'Prisma', 'Descompone la posición en colores.', { art: 'prism', scene: 'rays', a: '#ff8a98', b: '#22e1ff' }, { type: 'achievement', id: 'mate_10' }, 'rare'),
  avatar('ember', 'Ascua', 'Brasa de competidor.', { art: 'ember', scene: 'flames', a: '#ffd24a', b: '#ff5a1f' }, { type: 'achievement', id: 'circuit_final' }, 'epic'),
  avatar('lotus', 'Loto', 'Calma bajo presión.', { art: 'lotus', scene: 'petals', a: '#ff9ccb', b: '#8b5cf6' }, { type: 'season', season: 3, level: 20 }, 'epic'),

  // ----- Marcos -----
  frame('none', 'Sin marco', 'Sin adorno.', 'transparent', 'none', { type: 'default' }),
  frame('bronze', 'Marco Bronce', 'Aro de bronce.', '#cd7f32', 'solid', { type: 'level', level: 2 }),
  frame('cyan', 'Marco Cian', 'Aro cian brillante.', '#22e1ff', 'solid', { type: 'level', level: 5 }),
  frame('violet', 'Marco Violeta', 'Doble aro violeta.', '#8b5cf6', 'double', { type: 'level', level: 10 }, 'rare'),
  frame('gold', 'Marco Dorado', 'Doble aro dorado.', '#ffd24a', 'double', { type: 'level', level: 15 }, 'epic'),
  frame('aurora', 'Marco Aurora', 'Degradado animado.', '#34e3a0', 'aurora', { type: 'level', level: 25 }, 'legendary'),
  frame('laurel', 'Marco Laurel', 'Aro de laurel para campeones.', '#ffd24a', 'dashed', { type: 'achievement', id: 'circuit_champion' }, 'legendary'),
  frame('canopy', 'Marco Dosel', 'Hojas del bosque: recompensa de la temporada 2.', '#34e3a0', 'dashed', { type: 'season', season: 2, level: 22 }, 'epic'),

  // ----- Tableros, piezas y efectos de captura (existentes + nuevos) -----
  ...fromShop('boards', 'board'),
  ...extra(NEW_BOARDS, 'board'),
  ...fromShop('sets', 'set'),
  ...extra(NEW_SETS, 'set'),
  ...fromShop('fx', 'fx'),

  // ----- Efectos de victoria (se dibujan en fx.js) -----
  { id: 'confetti', category: 'victory', name: 'Confeti', desc: 'Lluvia de confeti.', rarity: 'common', asset: { ref: 'victory-confetti' }, unlock: { type: 'default' } },
  { id: 'fireworks', category: 'victory', name: 'Fuegos artificiales', desc: 'Estallidos de colores.', rarity: 'rare', asset: { ref: 'victory-fireworks' }, unlock: { type: 'level', level: 8 } },
  { id: 'laurel', category: 'victory', name: 'Lluvia de laurel', desc: 'Hojas doradas que caen.', rarity: 'rare', asset: { ref: 'victory-laurel' }, unlock: { type: 'achievement', id: 'wins_10' } },
  { id: 'aurora', category: 'victory', name: 'Aurora', desc: 'Velos de luz sobre el tablero.', rarity: 'epic', asset: { ref: 'victory-aurora' }, unlock: { type: 'level', level: 18 } },
  { id: 'nova', category: 'victory', name: 'Nova', desc: 'Ondas expansivas de energía.', rarity: 'legendary', asset: { ref: 'victory-nova' }, unlock: { type: 'achievement', id: 'circuit_champion' } },

  // ----- Animaciones de coronación (game.js → crownFx y minimal.css, clases `crown-<id>`) -----
  { id: 'classic', category: 'crown', name: 'Clásica', desc: 'La pieza nueva aparece con un destello.', rarity: 'common', asset: { ref: 'crown-classic' }, unlock: { type: 'default' } },
  { id: 'rise', category: 'crown', name: 'Ascenso', desc: 'La pieza sube girando desde la casilla.', rarity: 'rare', asset: { ref: 'crown-rise' }, unlock: { type: 'level', level: 5 } },
  { id: 'halo', category: 'crown', name: 'Halo', desc: 'Un aro dorado envuelve la coronación.', rarity: 'epic', asset: { ref: 'crown-halo' }, unlock: { type: 'level', level: 12 } },
  { id: 'stardust', category: 'crown', name: 'Polvo de estrellas', desc: 'Varias ondas de luz y un pequeño rebote.', rarity: 'legendary', asset: { ref: 'crown-stardust' }, unlock: { type: 'level', level: 20 } },

  // ----- Insignias -----
  badge('none', 'Sin insignia', 'Sin emblema.', '', 'transparent', { type: 'default' }, 'common'),
  badge('first-win', 'Primera victoria', 'Ganaste tu primera partida online.', '✦', '#ffd24a', { type: 'achievement', id: 'wins_1' }, 'common'),
  badge('ten-wins', 'Diez victorias', 'Diez partidas online ganadas.', '◆', '#22e1ff', { type: 'achievement', id: 'wins_10' }),
  badge('tactician', 'Mente táctica', 'Diez desafíos diarios resueltos.', '✚', '#34e3a0', { type: 'achievement', id: 'puzzle_10' }),
  badge('scholar', 'Estudioso', 'Cinco partidas revisadas.', '❖', '#8b5cf6', { type: 'achievement', id: 'review_5' }),
  badge('contender', 'Competidor', 'Participaste en un Royale Circuit.', '▲', '#ff8a98', { type: 'achievement', id: 'circuit_1' }),
  badge('finalist', 'Finalista', 'Llegaste a una final del Circuit.', '★', '#ffd24a', { type: 'achievement', id: 'circuit_final' }, 'epic'),
  badge('champion', 'Campeón', 'Ganaste un Royale Circuit.', '♛', '#ffd24a', { type: 'achievement', id: 'circuit_champion' }, 'legendary'),
  badge('season', 'Pase en marcha', 'Nivel 10 de una temporada.', '⬢', '#8b5cf6', { type: 'achievement', id: 'season_10' }),

  // ----- Títulos -----
  title('none', 'Sin título', 'Sin frase.', { type: 'default' }),
  title('apprentice', 'Aprendiz', 'Nivel 3.', { type: 'level', level: 3 }),
  title('strategist', 'Estratega', 'Nivel 7.', { type: 'level', level: 7 }),
  title('tactician', 'Táctico', 'Nivel 12.', { type: 'level', level: 12 }, 'rare'),
  title('master', 'Maestro del tablero', 'Nivel 20.', { type: 'level', level: 20 }, 'epic'),
  title('legend', 'Leyenda de CHECKPOINT', 'Nivel 30.', { type: 'level', level: 30 }, 'legendary'),
  title('finisher', 'Rematador', 'Diez jaques mate online.', { type: 'achievement', id: 'mate_10' }, 'rare'),
  title('circuit-finalist', 'Finalista del Circuit', 'Llegaste a una final.', { type: 'achievement', id: 'circuit_final' }, 'epic'),
  title('circuit-champion', 'Campeón del Circuit', 'Ganaste un torneo.', { type: 'achievement', id: 'circuit_champion' }, 'legendary'),
  title('tireless', 'Incansable', 'Cincuenta misiones reclamadas.', { type: 'achievement', id: 'mission_50' }, 'epic'),

  // ----- Decoración del perfil -----
  decor('plain', 'Liso', 'Fondo sobrio.', { type: 'default' }),
  decor('grid', 'Rejilla', 'Cuadrícula tenue de tablero.', { type: 'level', level: 4 }),
  decor('aurora', 'Aurora', 'Brillos suaves de color.', { type: 'level', level: 9 }, 'rare'),
  decor('constellation', 'Constelación', 'Puntos de luz y líneas.', { type: 'achievement', id: 'games_50' }, 'rare'),
  decor('circuit', 'Circuito', 'Pistas de luz como en el Circuit.', { type: 'achievement', id: 'circuit_1' }, 'epic'),

  // ----- Previstos (estructura para futuras ampliaciones y compras; aún no se pueden obtener) -----
  { ...avatar('nebula', 'Nébula', 'Avatar de un futuro pase premium.', { art: 'orbit', a: '#b9a1ff', b: '#22e1ff' }, { type: 'future', note: 'Llegará con una futura tienda validada' }, 'legendary'), status: 'soon' },
  { ...frame('eclipse', 'Marco Eclipse', 'Marco de un futuro pase.', '#b9a1ff', 'aurora', { type: 'future', note: 'Llegará con una futura tienda validada' }, 'legendary'), status: 'soon' },
].map((it) => ({ status: 'active', ...it }));

const BY_KEY = new Map(ITEMS.map((it) => [`${it.category}:${it.id}`, it]));
export const itemKey = (category, id) => `${category}:${id}`;
export const findItem = (category, id) => BY_KEY.get(`${category}:${id}`) ?? null;
export const itemsOf = (category) => ITEMS.filter((it) => it.category === category);
export const isObtainable = (it) => it.status === 'active' && it.unlock.type !== 'future';
/** ¿Se puede comprar con oros? Solo los artículos `purchase` activos, y siempre al precio del catálogo. */
export const priceOf = (it) => (it.unlock.type === 'purchase' && it.status === 'active' ? it.unlock.price : null);
/** Artículos que el servidor concede solo (nunca por compra ni importados desde un guardado del cliente). */
export const isGranted = (it) => ['level', 'achievement', 'season', 'circuit'].includes(it.unlock.type);

/** Desbloqueos por nivel de cuenta, para mostrar «lo siguiente» en la progresión. */
export const levelUnlocks = () =>
  ITEMS.filter((it) => it.unlock.type === 'level' && it.status === 'active').map((it) => ({ level: it.unlock.level, kind: it.category, id: it.id, name: it.name })).sort((a, b) => a.level - b.level);

// Los valores por defecto viven en data.js (los usa la cartera del servidor); aquí se comprueba que coinciden con el catálogo.
export const defaultItems = () => ITEMS.filter((it) => it.unlock.type === 'default');
export { DEFAULT_EQUIPPED, DEFAULT_OWNED };

/**
 * Texto del método de desbloqueo. `ctx`: { names: { achievementId → nombre } } (opcional).
 * Devuelve { icon, short, long }.
 */
export function unlockInfo(it, ctx = {}) {
  const u = it.unlock;
  switch (u.type) {
    case 'default': return { icon: '●', short: 'Incluido', long: 'Lo tienes desde el principio' };
    case 'level': {
      const left = Number.isFinite(ctx.level) ? u.level - ctx.level : 0; // niveles que le faltan a quien mira (si se conoce)
      return { icon: '⬆', short: `Nivel ${u.level}`, long: `Se desbloquea al llegar al nivel ${u.level} de cuenta${left > 0 ? ` · te ${left === 1 ? 'falta 1 nivel' : `faltan ${left} niveles`}` : ''}` };
    }
    case 'achievement': {
      const name = ctx.achievementNames?.[u.id] ?? u.id;
      return { icon: '🏅', short: 'Logro', long: `Se desbloquea al conseguir el logro «${name}»` };
    }
    case 'season': return { icon: '🎖', short: `Temporada ${u.season}`, long: `Recompensa gratuita del pase de la temporada ${u.season} (nivel ${u.level})` };
    case 'circuit': return { icon: '🏆', short: 'Circuit', long: 'Premio exclusivo del campeón del Royale Circuit' };
    case 'purchase': return { icon: '🪙', short: `${u.price} oros`, long: `Se compra con ${u.price} oros (moneda que se gana jugando)` };
    default: return { icon: '⏳', short: 'Próximamente', long: u.note ?? 'Aún no está disponible' };
  }
}
