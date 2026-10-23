// «World-class moves»: jugadas de partidas históricas reales (siglo XIX, de dominio público).
//
// Reglas de este archivo:
//  - Solo partidas cuyos jugadores, lugar y año están bien documentados en la historia del ajedrez.
//  - Las jugadas se guardan en SAN y se COMPRUEBAN con las reglas (test/highlights.test.js): todas legales, el mate final existe
//    y la jugada destacada es la indicada. Si una sola jugada no cuadra, la prueba falla.
//  - La explicación describe lo que pasa en el tablero (lo que se puede comprobar viendo las jugadas siguientes), no una
//    evaluación inventada. La evaluación numérica, si se pide, la calcula Stockfish en el navegador en ese momento.
//  - `notes`: comentarios jugada a jugada («por qué es buena»). Cada nota lleva `facts`, hechos del tablero que la prueba
//    comprueba con las reglas (jaque, mate, captura, material entregado, jugada forzada, clavadas, casillas atacadas o protegidas...).
//    Si un comentario afirma algo que el tablero no cumple, la prueba falla. Lo que no se pueda comprobar así no se escribe.
// Para añadir más: PGN de una fuente fiable, metadatos verificados y una explicación que se pueda comprobar con la secuencia.

export const WORLD_CATEGORIES = {
  sacrifice: 'Sacrificios brillantes',
  tactic: 'Combinaciones tácticas',
  mate: 'Jaques mates',
  defense: 'Defensas extraordinarias',
  endgame: 'Finales instructivos',
  strategy: 'Jugadas estratégicas',
  punished: 'Errores castigados',
};

export const WORLD_HIGHLIGHTS = [
  {
    id: 'opera-1858',
    title: 'La dama que abre la columna',
    white: 'Paul Morphy',
    black: 'Duque de Brunswick y conde Isouard',
    event: 'Partida amistosa en la Ópera de París',
    year: 1858,
    result: '1-0',
    categories: ['sacrifice', 'mate'],
    san: 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#',
    ply: 31,
    key: 'Qb8+',
    notes: [
      { ply: 13, tag: 'Doble presión', text: 'La dama ataca el peón de b7 y, a su lado, el alfil de c4 presiona f7. Las blancas amenazan por dos sitios a la vez.', facts: { attacks: { by: 'b3', squares: ['b7'] } } },
      { ply: 17, tag: 'Clavada', text: 'El alfil clava el caballo de f6 contra la dama de e7: si el caballo se mueve, las negras pierden la dama.', facts: { pin: { from: 'g5', pinned: 'f6', behind: 'e7' } } },
      { ply: 19, tag: 'Sacrificio', text: 'El caballo captura en b5 y, tras …cxb5, se pierde por un peón. Es una entrega para abrir líneas contra el rey negro.', facts: { gives: 2 } },
      { ply: 21, tag: 'Jaque', text: 'El alfil recupera el material con jaque y obliga a las negras a responder bloqueando.', facts: { check: true } },
      { ply: 23, tag: 'Ataque con enroque', text: 'El enroque largo pone la torre en d1, frente al caballo de d7, que ya está clavado por el alfil de b5.', facts: { attacks: { by: 'd1', squares: ['d7'] }, pin: { from: 'b5', pinned: 'd7', behind: 'e8' } } },
      { ply: 27, tag: 'Presión máxima', text: 'La segunda torre vuelve a la columna d y ataca la torre de d7, que sigue clavada por el alfil: no puede huir.', facts: { attacks: { by: 'd1', squares: ['d7'] }, pin: { from: 'b5', pinned: 'd7', behind: 'e8' } } },
      { ply: 29, tag: 'Jaque que gana una torre', text: 'El alfil captura la torre con jaque. Además, la dama de b3 tiene la columna b libre hasta b8: ahí llegará el golpe final.', facts: { check: true, capture: 'r', clear: { from: 'b3', to: 'b8' } } },
      { ply: 31, tag: 'Sacrificio de dama', text: 'La dama se entrega en b8 con jaque: el caballo de d7 tiene que capturarla, y era justo la pieza que tapaba la columna d.', facts: { check: true, gives: 9, forced: true } },
      { ply: 32, tag: 'Forzado', text: 'El caballo captura la dama y se va de d7: ahora la torre de d1 ve toda la columna hasta d8.', facts: { capture: 'q', clear: { from: 'd1', to: 'd8' } } },
      { ply: 33, tag: 'Jaque mate', text: 'La torre llega a d8 protegida por el alfil de g5, que además vigila e7. El rey negro no tiene ninguna casilla libre.', facts: { mate: true, defends: { by: 'g5', square: 'd8' } } },
    ],
    idea: 'Morphy entrega la dama en b8: el caballo de d7 tiene que capturarla, la columna d queda libre y la torre da mate en d8 con el apoyo del alfil de g5.',
  },
  {
    id: 'immortal-1851',
    title: 'La partida inmortal',
    white: 'Adolf Anderssen',
    black: 'Lionel Kieseritzky',
    event: 'Partida amistosa durante el torneo de Londres',
    year: 1851,
    result: '1-0',
    categories: ['sacrifice', 'mate'],
    san: 'e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#',
    ply: 43,
    key: 'Qf6+',
    notes: [
      { ply: 33, tag: 'Amenaza múltiple', text: 'El caballo ataca a la vez la dama de f6 y las casillas e7 y c7: las blancas suman amenazas en vez de defender sus torres.', facts: { attacks: { by: 'd5', squares: ['f6', 'e7', 'c7'] } } },
      { ply: 35, tag: 'Torres en el aire', text: 'Anderssen deja las dos torres sin defensa (…Qxa1+ y …Bxg1 son posibles) y prefiere seguir atacando al rey negro.', facts: { canCapture: ['a1', 'g1'] } },
      { ply: 41, tag: 'Jaque forzado', text: 'Jaque con el caballo desde g7: el rey negro solo tiene una jugada legal, ir a d8.', facts: { check: true, capture: 'p', forced: true } },
      { ply: 43, tag: 'Sacrificio de dama', text: 'La dama se entrega en f6 con jaque. Las negras solo tienen dos jugadas legales y, tras …Nxf6, llega el mate en la jugada siguiente.', facts: { check: true, gives: 9, replies: 2, mateNext: true } },
      { ply: 45, tag: 'Jaque mate', text: 'Mate con un alfil: las blancas ganan sin torres ni dama, solo con un alfil y dos caballos. Los de d5 y g7 cierran las casillas de escape.', facts: { mate: true, material: { white: { q: 0, r: 0, b: 1, n: 2 } } } },
    ],
    idea: 'Con las dos torres ya entregadas, Anderssen sacrifica también la dama: el caballo de g8 la captura en f6 y el alfil da mate en e7, porque los caballos de d5 y g7 cierran todas las casillas del rey.',
  },
  {
    id: 'evergreen-1852',
    title: 'La partida siempreviva',
    white: 'Adolf Anderssen',
    black: 'Jean Dufresne',
    event: 'Partida amistosa en Berlín',
    year: 1852,
    result: '1-0',
    categories: ['sacrifice', 'mate'],
    san: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O d3 Qb3 Qf6 e5 Qg6 Re1 Nge7 Ba3 b5 Qxb5 Rb8 Qa4 Bb6 Nbd2 Bb7 Ne4 Qf5 Bxd3 Qh5 Nf6+ gxf6 exf6 Rg8 Rad1 Qxf3 Rxe7+ Nxe7 Qxd7+ Kxd7 Bf5+ Ke8 Bd7+ Kf8 Bxe7#',
    ply: 41,
    key: 'Qxd7+',
    notes: [
      { ply: 33, tag: 'Sacrificio de caballo', text: 'El caballo da jaque desde f6. Si el peón de g7 lo captura, las blancas recuperan la pieza con una amenaza.', facts: { check: true, gives: 3 } },
      { ply: 35, tag: 'Recaptura con ataque', text: 'El peón recaptura en f6 y ahora ataca el caballo de e7, que además está bajo la torre de e1.', facts: { attacks: { by: 'f6', squares: ['e7'] } } },
      { ply: 39, tag: 'Torre por caballo', text: 'La torre captura el caballo de e7 con jaque. Las negras recapturan y las blancas preparan el golpe sobre d7.', facts: { check: true, capture: 'n', gives: 2 } },
      { ply: 41, tag: 'Sacrificio de dama', text: 'La dama se entrega en d7 con jaque: el rey puede capturarla (…Kxd7) o irse a f8. Capturándola, los alfiles dan jaques seguidos hasta el mate.', facts: { check: true, capture: 'p', gives: 8, replies: 2, checksTo: 47 } },
      { ply: 45, tag: 'Jaque protegido', text: 'Segundo jaque con el alfil: el rey no puede capturarlo porque la torre de d1 protege la casilla d7.', facts: { check: true, defends: { by: 'd1', square: 'd7' } } },
      { ply: 47, tag: 'Jaque mate', text: 'El alfil captura en e7 con mate: lo protege el peón de f6, que además vigila g7. El rey no puede capturar ni escapar.', facts: { mate: true, capture: 'n', defends: { by: 'f6', square: 'e7' }, attacks: { by: 'f6', squares: ['g7', 'e7'] } } },
    ],
    idea: 'Anderssen entrega la dama en d7 para sacar al rey negro a la columna d: el jaque doble de alfil y torre lo obliga a volver, y el alfil termina dando mate en e7.',
  },
];
