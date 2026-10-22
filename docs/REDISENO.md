# Rediseño minimalista y centro de highlights

Objetivo: una interfaz limpia y premium con menos elementos, jerarquía clara y un tablero 2D impecable. Se trabaja por fases pequeñas.

## Auditoría inicial

- La navegación superior tenía 7 entradas (Inicio, Jugar, Academia, Circuit, Clasificación, Progreso, Amigos) y la barra móvil 5. La barra superior mostraba a la vez nivel, barra de XP, racha, oros, perfil, sonido y ajustes.
- El inicio era una portada: logotipo gigante, «PLAY NOW», una rejilla de 8 accesos que repetía la navegación y una partida de demostración en 3D (la Ópera de Morphy en bucle).
- El tablero de partida ya tenía dos caminos: escena 3D (three.js, `board3d.js`) y tablero 2D en DOM (`#board`) como alternativa. Reglas, historial, multijugador y cosméticos funcionaban en los dos.
- Estilos en tres capas: `style.css` (base), `checkpoint.css` (sistema CHECKPOINT) y, desde ahora, `minimal.css`.

## Fases

| Fase | Estado | Qué |
|---|---|---|
| 1 · Sistema visual y navegación | ✅ | `minimal.css`: paleta (#080A0E, #11151C, #20DDF3, #F5F7FA, #929BAA), tipografía con escala corta, botones en tres niveles (primario, secundario y `ghost`), estados de foco, desactivado y carga, sin brillos ni capas decorativas, tarjetas de una sola superficie. Navegación de 5 secciones (Inicio, Jugar, Circuit, Ranking y Perfil) igual en escritorio y móvil, con `aria-current`. Barra superior: oros, sonido, ajustes y una píldora de perfil con nombre, rating y nivel; la racha sale de la barra (sigue en Progreso). Academia, Espectar y Diario cuelgan de Jugar; Progreso, Amigos, Historial, Personalización y Ajustes cuelgan de Perfil |
| 2 · Inicio como centro de highlights | ✅ | Encabezado compacto (saludo, frase y «Jugar»/«Entrenar»). **Your best moves**: momentos de tus partidas reales con `moments.js` (mates y coronaciones por las jugadas; sacrificios, errores aprovechados y remontadas solo con el análisis de Stockfish, que se puede lanzar desde ahí). **World-class moves**: tres partidas históricas verificadas (Morphy 1858, Anderssen–Kieseritzky 1851, Anderssen–Dufresne 1852). Cada highlight tiene tablero 2D, reproducción, avanzar/retroceder/reiniciar, salto a la jugada clave, notación, explicación breve, partida completa en el visor, práctica de la posición contra la IA y evaluación con Stockfish bajo demanda. Estados vacío, de carga y de error. La sección mundial se monta al entrar en pantalla |
| 3 · Tablero 2D como estándar | ✅ | Las partidas usan siempre el tablero 2D (se quitan la cámara 3D y el ajuste «Tablero 2D»). three.js ya no se descarga al abrir la app (antes 418 KB comprimidos). La arena 3D del lobby queda como opción en Ajustes, apagada por defecto. Los cosméticos de piezas y tableros se ven igual en el 2D y en los highlights |
| 4 · Resto de pantallas | ⏳ pendiente | Jugar (modos con un primario claro), Circuit (torneo destacado, cuadro y campeón), Ranking (posición, avatar, nombre, rating y usuario actual), Perfil (identidad, rating, estadísticas, historial, logros y cosméticos por secciones), Personalización (rejilla y filtros) |
| 5 · Repaso final | ⏳ pendiente | Revisión visual de todas las pantallas en móvil y escritorio y limpieza de estilos heredados (`style.css` y `checkpoint.css`) que `minimal.css` ya no necesita sobrescribir |

## Datos de los highlights

- **Propios:** solo partidas guardadas por el servidor (`/api/me/games` y `/api/games/:id`, verificadas al leerlas). Se toman como «buena jugada» únicamente `checkmate`, `brilliant`, `sacrifice`, `opportunity`, `promotion` y `turnaround`, y siempre del propio jugador. Los criterios están en `docs/REPETICIONES.md`. Nada se inventa: si no hay jugadas destacadas se dice y se ofrece analizar.
- **Mundiales:** `public/js/world-highlights.js`. Partidas del siglo XIX de dominio público, con jugadores, lugar y año bien documentados. `test/highlights.test.js` comprueba que todas las jugadas son legales, que terminan en mate con el resultado anunciado, que la jugada clave es la indicada y que un «sacrificio» entrega al menos 5 puntos de material. Las explicaciones describen lo que se ve en la secuencia; la evaluación numérica la da Stockfish en el navegador cuando se pide.
- **Ampliar:** con más de tres partidas aparecen las pestañas por categoría (sacrificios, combinaciones, mates, defensas, finales, estrategia y errores castigados). Una fuente externa (por ejemplo, PGN de bases de datos abiertas) entraría como un archivo de datos con su licencia y pasaría la misma prueba.

## Pendiente y riesgos

- Fase 4 y 5 (arriba). Algunas pantallas antiguas aún usan iconos emoji y tarjetas con mucho contenido; `minimal.css` las suaviza pero no las reorganiza.
- `board3d.js` y `arena3d.js` siguen en el repositorio: la arena se puede activar en Ajustes y `board3d.js` ya no lo importa nadie. Se puede borrar en la fase 5.
- Las piezas son glifos Unicode con contorno (como antes); un juego de piezas SVG propio mejoraría la legibilidad en tamaños pequeños.
