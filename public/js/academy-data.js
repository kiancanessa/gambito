// Academia de CHECKPOINT: ruta de aprendizaje de cero a experto. Contenido y reglas de evaluación (sin interfaz).
//
// Cada ejercicio es una posición real con un objetivo que se comprueba con chess.js:
//  - 'board': mueve una pieza para cumplir `goal` (captura, jaque, mate, enroque, al paso, coronación, jugada concreta…).
//             Con `line` o `mateIn` es multi-jugada: el profesor responde automáticamente con las jugadas del rival.
//  - 'quiz':  pregunta de opción múltiple con explicación.
//  - 'play':  partida contra la IA desde una posición, con objetivo (ganar) y un máximo de jugadas.
// Un test (test/academy.test.js) comprueba que TODAS las posiciones, jugadas y soluciones son legales y cumplen su objetivo.
import { Chess } from '../vendor/chess.js';

export const normSan = (san) => String(san ?? '').replace(/[+#!?]/g, '');

// ---------- Utilidades de evaluación (puras) ----------
const legal = (chess) => chess.moves({ verbose: true });

// ¿Se puede dar mate en `n` jugadas (el bando que mueve)? Búsqueda exhaustiva: n ≤ 2 es instantáneo.
export function canMateIn(fen, n) {
  const chess = new Chess(fen);
  for (const m of legal(chess)) {
    chess.move(m);
    const ok = chess.isCheckmate() || (n > 1 && !chess.isGameOver() && legal(chess).every((reply) => {
      chess.move(reply);
      const forced = canMateIn(chess.fen(), n - 1);
      chess.undo();
      return forced;
    }));
    chess.undo();
    if (ok) return true;
  }
  return false;
}

// Tras tu jugada: ¿el rival ya no puede evitar el mate en `n` (más su respuesta)? `chessAfter` ya incluye tu jugada.
export function mateForced(chessAfter, n) {
  if (chessAfter.isCheckmate()) return true;
  if (n <= 1 || chessAfter.isGameOver()) return false;
  const replies = legal(chessAfter);
  return replies.length > 0 && replies.every((r) => {
    const c = new Chess(chessAfter.fen());
    c.move(r);
    return canMateIn(c.fen(), n - 1);
  });
}

// Respuesta del profesor/rival cuando hay que continuar una línea de mate: la que más resiste (captura o jaque primero).
export function pickReply(chessAfter) {
  const replies = legal(chessAfter);
  replies.sort((a, b) => Number(!!b.captured) - Number(!!a.captured) || Number(b.san.includes('+')) - Number(a.san.includes('+')));
  return replies[0] ?? null;
}

/**
 * Juzga la jugada del alumno. `move` = jugada verbose de chess.js (ya aplicada), `chessAfter` = posición resultante,
 * `step` = cuántas jugadas suyas lleva este ejercicio. Devuelve { ok, done, reply? } (reply = jugada SAN del rival, si procede).
 */
export function judge(ex, move, chessAfter, step = 0) {
  const g = ex.goal;
  const san = normSan(move.san);
  switch (g.type) {
    case 'san':
      return { ok: g.moves.map(normSan).includes(san), done: true };
    case 'capture':
      return { ok: !!move.captured, done: true };
    case 'captureOf':
      return { ok: !!move.captured && move.to === g.square, done: true };
    case 'check':
      return { ok: /[+#]/.test(move.san), done: true };
    case 'mate':
      return { ok: move.san.endsWith('#'), done: true };
    case 'castle':
      return { ok: move.flags.includes(g.side), done: true };
    case 'enpassant':
      return { ok: move.flags.includes('e'), done: true };
    case 'promote':
      return { ok: !!move.promotion && (!g.piece || move.promotion === g.piece), done: true };
    case 'piece':
      return { ok: move.piece === g.piece, done: true };
    case 'moveTo':
      return { ok: g.squares.includes(move.to), done: true };
    case 'line': {
      const expected = g.moves[step * 2];
      const last = step * 2 + 1 >= g.moves.length;
      const ok = normSan(expected) === san;
      return { ok, done: ok && last, reply: ok && !last ? g.moves[step * 2 + 1] : undefined };
    }
    case 'mateIn': {
      const remaining = g.n - step;
      if (!mateForced(chessAfter, remaining)) return { ok: false, done: false };
      if (chessAfter.isCheckmate()) return { ok: true, done: true };
      const r = pickReply(chessAfter);
      return { ok: true, done: false, reply: r?.san };
    }
    default:
      return { ok: false, done: false };
  }
}

// ---------- Contenido ----------
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const STAGES = [
  {
    id: 'basics',
    name: 'Fundamentos',
    level: 'Aprendiz',
    color: '#34e3a0',
    blurb: 'Cómo se mueven las piezas, qué es el jaque mate y las reglas especiales. Si nunca has jugado, empieza aquí.',
    lessons: [
      {
        id: 'pieces',
        title: 'Las piezas y cómo se mueven',
        intro: 'El tablero tiene 64 casillas: columnas de la a a la h y filas del 1 al 8. Cada pieza se mueve a su manera y, salvo el caballo, no puede saltar sobre otras. Vamos a probar una por una.',
        exercises: [
          { id: 'pawn-move', kind: 'board', fen: 'k7/8/8/8/8/8/4P3/4K3 w - - 0 1', prompt: 'El peón avanza hacia delante: una casilla, o dos desde su fila inicial. Mueve el peón.', goal: { type: 'piece', piece: 'p' }, hint: 'Pulsa el peón blanco de e2 y elige e3 o e4.', explain: 'Los peones solo avanzan; nunca retroceden.' },
          { id: 'pawn-capture', kind: 'board', fen: '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', prompt: 'Los peones capturan en diagonal, no de frente. Captura el peón negro.', goal: { type: 'captureOf', square: 'd5' }, hint: 'Tu peón de e4 puede comer en d5.', explain: '¡Exacto! El peón avanza recto pero captura en diagonal.' },
          { id: 'knight', kind: 'board', fen: '4k3/8/8/8/8/2p5/8/1N2K3 w - - 0 1', prompt: 'El caballo se mueve en «L» (dos casillas y una al lado) y es la única pieza que salta. Captura el peón.', goal: { type: 'captureOf', square: 'c3' }, hint: 'Desde b1, el caballo llega a c3.', explain: 'Dos casillas en una dirección y una en perpendicular: así se dibuja la L.' },
          { id: 'bishop', kind: 'board', fen: '7k/8/8/6p1/8/8/8/2B1K3 w - - 0 1', prompt: 'El alfil se mueve en diagonal, tan lejos como quiera. Captura el peón.', goal: { type: 'captureOf', square: 'g5' }, hint: 'Sigue la diagonal desde c1 hasta g5.', explain: 'Cada alfil se queda siempre en casillas del mismo color.' },
          { id: 'rook', kind: 'board', fen: 'k7/8/8/8/p7/8/8/R3K3 w - - 0 1', prompt: 'La torre recorre filas y columnas. Captura el peón de la columna a.', goal: { type: 'captureOf', square: 'a4' }, hint: 'Sube por la columna a hasta a4.', explain: 'La torre es muy fuerte en columnas y filas abiertas.' },
          { id: 'queen', kind: 'board', fen: '7k/8/8/8/3p4/8/8/3QK3 w - - 0 1', prompt: 'La dama combina torre y alfil: es la pieza más poderosa. Captura el peón.', goal: { type: 'captureOf', square: 'd4' }, hint: 'Sube por la columna d.', explain: 'La dama vale 9 puntos: ¡no la pierdas por poco!' },
          { id: 'king', kind: 'board', fen: '4k3/8/8/8/8/8/P7/4K3 w - - 0 1', prompt: 'El rey se mueve una casilla en cualquier dirección. Si lo pierdes, pierdes la partida. Mueve el rey.', goal: { type: 'piece', piece: 'k' }, hint: 'Cualquier casilla vecina que no esté al lado del rey rival.', explain: 'El rey nunca puede ponerse en una casilla atacada.' },
        ],
      },
      {
        id: 'check',
        title: 'Jaque, jaque mate y ahogado',
        intro: 'Cuando atacas al rey rival das jaque y debe salir de él. Si no puede (mover, capturar o interponer), es jaque mate y ganas. Cuidado: si el rival no está en jaque pero no tiene ninguna jugada legal, es ahogado y la partida termina en tablas.',
        exercises: [
          { id: 'check-escape', kind: 'quiz', prompt: 'Tu rey está en jaque. ¿Qué NO es una forma válida de salir del jaque?', options: ['Mover el rey a una casilla segura', 'Capturar la pieza que da jaque', 'Interponer una pieza en medio', 'Mover otra pieza e ignorar el jaque'], answer: 3, explain: 'El jaque hay que resolverlo siempre: moviendo el rey, capturando al atacante o interponiendo una pieza.' },
          { id: 'give-check', kind: 'board', fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', prompt: 'Da jaque al rey negro con la torre.', goal: { type: 'check' }, hint: 'La fila 8 es la del rey negro: lleva la torre a a8.', explain: '¡Jaque! El rey negro tiene que moverse.' },
          { id: 'back-rank', kind: 'board', fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', prompt: 'El rey negro está encerrado por sus propios peones. Da jaque mate con la torre.', goal: { type: 'mate' }, hint: 'Ra8: el rey no puede huir ni tapar.', explain: 'Es el «mate del pasillo»: el rey se ahoga con sus propios peones.' },
          { id: 'queen-king', kind: 'board', fen: '7k/8/5K2/8/8/8/8/6Q1 w - - 0 1', prompt: 'Da jaque mate. Recuerda: una pieza protegida por tu rey no puede ser capturada.', goal: { type: 'mate' }, wrong: { Qg8: 'El rey negro se la comería: la dama en g8 no está protegida. Busca una casilla que tu rey proteja.' }, hint: 'Qg7: tu rey de f6 la protege.', explain: 'Rey y dama trabajan juntos: la dama da el jaque y el rey la protege.' },
          { id: 'stalemate', kind: 'board', fen: '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1', prompt: 'Hay dos formas de dar mate y una que hace tablas. ¡Encuentra el mate!', goal: { type: 'mate' }, wrong: { Qg6: 'Eso es ahogado: el rey negro no está en jaque y no tiene casillas libres, así que son tablas. ¡Cuidado cuando vas ganando!' }, hint: 'Qg7 o Qh5 dan mate.', explain: 'Antes de cada jugada ganadora, comprueba que el rival conserva alguna jugada legal… ¡o que le das mate!' },
        ],
      },
      {
        id: 'special',
        title: 'Movimientos especiales',
        intro: 'Tres jugadas que sorprenden a los principiantes: el enroque (rey y torre a la vez), la captura al paso y la coronación del peón.',
        exercises: [
          { id: 'castle-short', kind: 'board', fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', prompt: 'Enroca en el lado del rey («enroque corto»): mueve el rey dos casillas hacia la torre de h1.', goal: { type: 'castle', side: 'k' }, hint: 'Arrastra el rey de e1 a g1.', explain: 'El rey va a g1 y la torre salta a f1. Solo se puede si ninguno se ha movido, no hay piezas en medio y el rey no pasa por casillas atacadas.' },
          { id: 'castle-long', kind: 'board', fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', prompt: 'Ahora el «enroque largo»: el rey se acerca a la torre de a1.', goal: { type: 'castle', side: 'q' }, hint: 'El rey de e1 va a c1.', explain: 'En el enroque largo el rey acaba en c1 y la torre en d1.' },
          { id: 'en-passant', kind: 'board', fen: 'k7/8/8/3pP3/8/8/8/K7 w - d6 0 1', prompt: 'El peón negro acaba de avanzar dos casillas junto a tu peón. Puedes capturarlo «al paso», como si hubiera avanzado solo una.', goal: { type: 'enpassant' }, hint: 'Tu peón de e5 captura en d6.', explain: 'La captura al paso solo vale en el turno inmediato siguiente.' },
          { id: 'promotion', kind: 'board', fen: '7k/4P3/8/8/8/8/8/K7 w - - 0 1', prompt: 'Un peón que llega a la última fila se convierte en otra pieza (casi siempre una dama). ¡Corónalo!', goal: { type: 'promote' }, hint: 'Avanza el peón de e7 a e8 y elige una pieza.', explain: 'Coronar convierte un peón en una dama (o torre, alfil o caballo).' },
        ],
      },
      {
        id: 'value',
        title: 'Valor de las piezas y cambios',
        intro: 'Para decidir si un cambio conviene se cuentan puntos: peón 1, caballo 3, alfil 3, torre 5, dama 9. El rey no se cambia nunca.',
        exercises: [
          { id: 'value-queen', kind: 'quiz', prompt: '¿Cuántos puntos vale una dama?', options: ['3', '5', '9', '12'], answer: 2, explain: 'Dama 9, torre 5, alfil y caballo 3, peón 1.' },
          { id: 'value-trade', kind: 'quiz', prompt: 'Te ofrecen cambiar tu torre (5) por un alfil (3) y un peón (1). ¿Conviene?', options: ['Sí: son 4 piezas', 'No: das 5 y recibes 4', 'Da igual', 'Solo si es la primera jugada'], answer: 1, explain: 'La torre vale 5 y recibes 4: pierdes un punto. Cuenta siempre el valor, no el número de piezas.' },
          { id: 'win-queen', kind: 'board', fen: '4k3/8/8/2qr4/8/8/8/2R1K1B1 w - - 0 1', prompt: 'La dama negra está protegida por la torre, pero aun así puedes capturarla: cambiar una pieza pequeña por una dama gana material. Captúrala.', goal: { type: 'captureOf', square: 'c5' }, hint: 'La torre o el alfil pueden comer en c5; el alfil pierde menos (3 por 9).', explain: 'Con el alfil: das 3 puntos y ganas 9. ¡Siempre cuenta quién captura!' },
        ],
      },
    ],
  },
  {
    id: 'tactics',
    name: 'Táctica',
    level: 'Jugador',
    color: '#22e1ff',
    blurb: 'Los trucos que ganan partidas: mates en 1 y en 2, horquillas, clavadas, ensartadas y ataques descubiertos.',
    lessons: [
      {
        id: 'mate1',
        title: 'Mate en 1',
        intro: 'Antes de cada jugada pregúntate: «¿puedo dar mate ahora?». Estos patrones se repiten en miles de partidas.',
        exercises: [
          { id: 'm1-back', kind: 'board', fen: '6k1/5ppp/8/8/8/8/8/3RK3 w - - 0 1', prompt: 'Mate del pasillo con la torre.', goal: { type: 'mate' }, hint: 'Rd8.', explain: 'El rey no tiene casillas porque sus peones le tapan la salida.' },
          { id: 'm1-ladder', kind: 'board', fen: '7k/R7/8/8/8/8/8/1R4K1 w - - 0 1', prompt: 'Mate de la escalera: dos torres se turnan para arrinconar al rey. Remata.', goal: { type: 'mate' }, hint: 'Rb8: la torre de a7 corta la fila 7.', explain: 'Una torre corta una fila y la otra da jaque en la siguiente.' },
          { id: 'm1-smothered', kind: 'board', fen: '6rk/6pp/8/6N1/8/8/8/7K w - - 0 1', prompt: 'El rey negro está rodeado por sus propias piezas. Un caballo puede dar el golpe final.', goal: { type: 'mate' }, hint: 'Cf7: el caballo ataca h8 y nadie lo puede capturar.', explain: 'Es el «mate ahogado»: el caballo salta y el rey no tiene escapatoria.' },
          { id: 'm1-pastor', kind: 'board', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', prompt: 'Las negras han cometido un error en la apertura. Aprovecha el punto débil f7 y da mate.', goal: { type: 'mate' }, hint: 'Qxf7: el alfil de c4 la protege.', explain: 'Es el famoso «mate del pastor»: dama y alfil contra f7.' },
          { id: 'm1-queen', kind: 'board', fen: '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1', prompt: 'Captura la torre con mate: ¡que el rey negro no tenga salida!', goal: { type: 'mate' }, hint: 'Qxd8.', explain: 'Capturar y dar mate a la vez: el pasillo vuelve a funcionar.' },
        ],
      },
      {
        id: 'forks',
        title: 'Horquillas (doble ataque)',
        intro: 'Una horquilla ataca dos piezas a la vez: el rival solo puede salvar una. El caballo es el gran especialista, pero los peones y la dama también lo hacen.',
        exercises: [
          { id: 'fork-knight-rook', kind: 'board', fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', prompt: 'Una jugada del caballo da jaque y ataca la torre a la vez.', goal: { type: 'san', moves: ['Nc7'] }, hint: 'Cc7+ ataca e8 y a8.', explain: 'El rey tiene que moverse y después el caballo se come la torre.' },
          { id: 'fork-knight-queen', kind: 'board', fen: 'q3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', prompt: 'Lo mismo, pero ahora la víctima es la dama negra.', goal: { type: 'san', moves: ['Nc7'] }, hint: 'Otra vez Cc7+.', explain: 'Rey y dama en la misma «L»: ¡dama ganada!' },
          { id: 'fork-pawn', kind: 'board', fen: '4k3/8/8/2n1r3/8/3P4/8/6K1 w - - 0 1', prompt: 'Un solo peón puede atacar a dos piezas negras. ¿Cuál es la jugada?', goal: { type: 'san', moves: ['d4'] }, hint: 'd4 ataca c5 y e5.', explain: 'Los peones ganan material con horquillas porque valen menos que las piezas.' },
        ],
      },
      {
        id: 'pins',
        title: 'Clavadas y ensartadas',
        intro: 'Una pieza está clavada cuando, si se mueve, deja expuesta otra más valiosa (por ejemplo, el rey). Una ensartada es lo contrario: atacas a la pieza valiosa y detrás cae otra.',
        exercises: [
          { id: 'pin-quiz', kind: 'quiz', prompt: 'Un alfil rival clava tu caballo contra tu rey. ¿Puede moverse el caballo?', options: ['Sí, como siempre', 'No: dejaría al rey en jaque (es ilegal)', 'Solo si captura algo', 'Solo en el siguiente turno'], answer: 1, explain: 'Una pieza clavada contra el rey no puede moverse: sería una jugada ilegal.' },
          { id: 'pin-attack', kind: 'board', fen: '4k3/4n3/8/5P2/8/8/8/4R1K1 w - - 0 1', prompt: 'El caballo negro está clavado por tu torre (si se mueve, el rey queda en jaque). Atácalo con un peón.', goal: { type: 'san', moves: ['f6'] }, hint: 'f6 ataca a e7.', explain: 'Una pieza clavada no puede huir: se la puede atacar con calma.' },
          { id: 'skewer', kind: 'board', fen: '4k2r/8/8/8/8/8/8/R3K3 w - - 0 1', prompt: 'Da jaque al rey de forma que, al apartarse, puedas capturar la torre que tiene detrás. Es una ensartada.', goal: { type: 'san', moves: ['Ra8'] }, hint: 'Ra8+: el rey se mueve y la torre de h8 queda en la misma fila.', explain: 'Ensartada: atacas a la pieza valiosa y, cuando se aparta, cae la de detrás.' },
        ],
      },
      {
        id: 'discover',
        title: 'Ataque descubierto y mates en 2',
        intro: 'En un ataque descubierto mueves una pieza y descubres el ataque de otra que estaba detrás: dos amenazas en una jugada. Después, mates en dos jugadas: la primera prepara el golpe que el rival ya no puede evitar.',
        exercises: [
          { id: 'discovered', kind: 'board', fen: '4k3/7q/8/8/4B3/8/8/4R1K1 w - - 0 1', prompt: 'Mueve el alfil de forma que descubra el jaque de la torre… y capture algo importante.', goal: { type: 'san', moves: ['Bxh7'] }, hint: 'Bxh7+: la torre de e1 da jaque en cuanto el alfil se aparta.', explain: 'El rey está en jaque por la torre y no puede salvar a la dama.' },
          { id: 'm2-ladder', kind: 'board', fen: '7k/8/8/8/8/8/R7/1R4K1 w - - 0 1', prompt: 'Mate en 2 con las torres: la primera jugada deja al rey sin salida y la segunda lo remata.', goal: { type: 'mateIn', n: 2 }, hint: 'Sube una torre a la fila 7 para encerrar al rey.', explain: 'Dos torres coordinadas dan mate al rey contra el borde.' },
          { id: 'm2-a', kind: 'board', fen: '1r1k4/2p3R1/1pQ5/pP5p/1P1P1P2/5B1P/8/2B1rK2 w - - 7 38', prompt: 'Mate en 2: busca una jugada que no dé jaque pero deje al rey sin defensa.', goal: { type: 'mateIn', n: 2 }, hint: 'Piensa en capturar o amenazar el mate con un movimiento tranquilo.', explain: 'Los mates en 2 más bonitos empiezan con una jugada silenciosa.' },
          { id: 'm2-b', kind: 'board', fen: '1Qb5/5k2/2pB4/2N4p/p3B2P/6P1/5K2/8 w - - 3 48', prompt: 'Mate en 2 con las blancas.', goal: { type: 'mateIn', n: 2 }, hint: 'La dama de b8 puede dar un jaque que obliga al rey.', explain: 'Cada jaque reduce las respuestas del rival hasta que solo queda el mate.' },
        ],
      },
    ],
  },
  {
    id: 'endgames',
    name: 'Finales',
    level: 'Táctico',
    color: '#8b5cf6',
    blurb: 'Convertir la ventaja: dar mate con pocas piezas contra una IA que se defiende.',
    lessons: [
      {
        id: 'kq',
        title: 'Rey y dama contra rey',
        intro: 'Con una dama y un rey se gana siempre, pero hay que arrinconar al rey rival sin dejarlo ahogado. Consejo: acerca tu rey, deja una casilla de distancia y reduce el espacio con la dama.',
        exercises: [
          { id: 'kq-play', kind: 'play', fen: '8/8/8/8/8/2k5/8/K6Q w - - 0 1', ai: 1, limitMoves: 30, prompt: 'Da mate en un máximo de 30 jugadas contra la IA.', goal: { type: 'win' }, explain: 'La técnica: limita al rey con la dama «a un salto de caballo» y acerca tu rey para el mate.' },
        ],
      },
      {
        id: 'kr',
        title: 'Rey y torre contra rey',
        intro: 'Es más lento: la torre y el rey empujan al rival hacia el borde, un paso cada vez («método de la caja»). Paciencia y mucho cuidado con el ahogado.',
        exercises: [
          { id: 'kr-play', kind: 'play', fen: '8/8/8/3k4/8/8/8/R3K3 w - - 0 1', ai: 1, limitMoves: 45, prompt: 'Da mate en un máximo de 45 jugadas contra la IA.', goal: { type: 'win' }, explain: 'Corta al rey con la torre, avanza tu rey con él y remata en el borde.' },
        ],
      },
    ],
  },
  {
    id: 'openings',
    name: 'Aperturas y estrategia',
    level: 'Estratega',
    color: '#ffb020',
    blurb: 'Empezar bien la partida y entender los planes: centro, desarrollo, enroque y estructura de peones.',
    lessons: [
      {
        id: 'principles',
        title: 'Principios de apertura',
        intro: 'Tres ideas básicas: controla el centro, desarrolla tus piezas (caballos y alfiles antes que la dama) y enroca pronto para proteger al rey.',
        exercises: [
          { id: 'op-center', kind: 'board', fen: START, prompt: 'Elige una buena primera jugada que luche por el centro.', goal: { type: 'san', moves: ['e4', 'd4', 'Nf3', 'c4', 'Nc3'] }, hint: 'e4 y d4 son las más populares.', explain: 'Los peones centrales y los caballos hacia el centro dan espacio y control.' },
          { id: 'op-develop', kind: 'board', fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', prompt: 'Las negras respondieron en el centro. Desarrolla un caballo hacia el centro.', goal: { type: 'san', moves: ['Nf3', 'Nc3'] }, hint: 'Cf3 ataca el peón de e5.', explain: 'Los caballos se desarrollan primero porque sabes dónde van; los alfiles pueden esperar.' },
          { id: 'op-castle', kind: 'board', fen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', prompt: 'Ya has desarrollado alfil y caballo. Pon a salvo a tu rey: enroca corto.', goal: { type: 'castle', side: 'k' }, hint: 'Arrastra el rey de e1 a g1.', explain: 'El enroque protege al rey y activa la torre en una sola jugada.' },
          { id: 'op-italian', kind: 'board', fen: START, prompt: 'Juega la Apertura Italiana: 1.e4, 2.Cf3, 3.Ac4, 4.c3 y 5.d4 (el profesor responde con jugadas lógicas).', goal: { type: 'line', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4'] }, hint: 'Sigue el orden: e4, Cf3, Ac4, c3, d4.', explain: 'Así controlas el centro con peones, sacas las piezas y preparas el enroque.' },
          { id: 'op-trap', kind: 'board', fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3', prompt: 'Juegas con negras. Las blancas amenazan mate en f7 con dama y alfil. ¿Cómo lo evitas?', goal: { type: 'san', moves: ['g6', 'Qe7', 'Nh6', 'Qf6'] }, wrong: { Nf6: '¡Mate! Con Cf6 no defiendes f7 y la dama blanca da jaque mate con Dxf7.' }, hint: 'Defiende f7 o ataca a la dama: g6 la ataca y Qe7 protege f7.', explain: 'Siempre pregúntate qué amenaza el rival antes de desarrollar.' },
        ],
      },
      {
        id: 'strategy',
        title: 'Ideas de estrategia',
        intro: 'Cuando no hay tácticas, se juega con planes: piezas activas en el centro, un rey seguro y peones sanos.',
        exercises: [
          { id: 'st-knight', kind: 'board', fen: '4k3/p7/8/8/8/8/P7/1N2K3 w - - 0 1', prompt: '«Caballo en el borde, caballo en peligro». Llévalo a la casilla más central que puedas.', goal: { type: 'moveTo', squares: ['c3'] }, hint: 'Cc3 está más cerca del centro que a3 o d2.', explain: 'Un caballo en el centro controla hasta 8 casillas; en la esquina, solo 2.' },
          { id: 'st-pawns', kind: 'quiz', prompt: '¿Qué son los peones doblados?', options: ['Dos peones del mismo color en la misma columna', 'Dos peones en filas contiguas', 'Un peón que ha coronado', 'Dos peones protegiéndose'], answer: 0, explain: 'Los peones doblados suelen ser una debilidad porque no pueden protegerse entre sí.' },
          { id: 'st-king', kind: 'quiz', prompt: 'En la apertura y el medio juego, ¿dónde suele estar más seguro tu rey?', options: ['En el centro', 'Enrocado, detrás de sus peones', 'Avanzado para atacar', 'En la fila 4'], answer: 1, explain: 'El enroque lleva al rey a un rincón seguro; en el centro es vulnerable a los ataques.' },
        ],
      },
    ],
  },
];

// La última etapa son las «Pruebas»: partidas contra los cinco rivales de la Academia (ver main.js → startTrial).
export const TRIALS_STAGE = {
  id: 'trials',
  name: 'Pruebas finales',
  level: 'Maestro',
  color: '#ff5a6e',
  blurb: 'Cinco rivales de dificultad creciente. Supera las pruebas y te graduarás en la Academia.',
};

export const LESSONS = Object.fromEntries(STAGES.flatMap((s) => s.lessons.map((l) => [l.id, { ...l, stage: s.id }])));
export const ORDER = STAGES.flatMap((s) => s.lessons.map((l) => l.id)); // orden recomendado de las lecciones
export const LEVELS = ['Principiante', ...STAGES.map((s) => s.level), TRIALS_STAGE.level];
