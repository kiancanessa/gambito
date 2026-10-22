// «World-class moves»: jugadas de partidas históricas reales (siglo XIX, de dominio público).
//
// Reglas de este archivo:
//  - Solo partidas cuyos jugadores, lugar y año están bien documentados en la historia del ajedrez.
//  - Las jugadas se guardan en SAN y se COMPRUEBAN con las reglas (test/highlights.test.js): todas legales, el mate final existe
//    y la jugada destacada es la indicada. Si una sola jugada no cuadra, la prueba falla.
//  - La explicación describe lo que pasa en el tablero (lo que se puede comprobar viendo las jugadas siguientes), no una
//    evaluación inventada. La evaluación numérica, si se pide, la calcula Stockfish en el navegador en ese momento.
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
    idea: 'Anderssen entrega la dama en d7 para sacar al rey negro a la columna d: el jaque doble de alfil y torre lo obliga a volver, y el alfil termina dando mate en e7.',
  },
];
