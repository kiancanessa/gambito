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
| 4 · Resto de pantallas | ✅ | **Jugar**: la clasificatoria es el modo principal (ritmo y «Buscar rival»); Partida rápida, Royale Circuit, Jugar con amigos y Entrenamiento son bloques compactos que despliegan su configuración, y solo hay **un botón primario** a la vista (sin conexión, el principal pasa a ser la IA). Se retiran del lobby las tarjetas repetidas (perfil, misiones, temporada, amigos, ranking, en vivo, historial: ya están en sus secciones) y la arena 3D; pide 3 endpoints cada 12 s en vez de 6. **Circuit**: el torneo destacado (en el que estás o el abierto) va primero y en grande, los demás compactos y «Cómo funciona» después; un solo primario. **Ranking**: filas legibles (puesto, emblema, nombre, rating), tu fila marcada con «Tú» y fijada al final si estás fuera del top; sin variación de puesto porque no se guarda. **Perfil**: identidad y rango arriba, accesos a Historial, Progreso, Personalizar y Amigos, y pestañas Resumen, Logros y Cuenta. **Personalización**: categorías en varias filas en escritorio |
| 5 · Repaso final | ✅ | **Un primario por pantalla**: Progreso, Ajustes y Academia dejan de tener botones cian que compiten (en la Academia solo el «Empezar» de la cabecera; la lección siguiente se distingue con el borde). Los botones de Amigos pierden iconos decorativos (`➕`, `👤`, `⚔`, `▶`). El antiguo «PLAY NOW» (Academia y Circuit) es ahora un botón primario normal. **Campos de texto**: el buscador de amigos usaba el estilo nativo (fondo blanco); ahora todos los campos comparten el estilo oscuro y el foco visible. **CSS heredado**: se eliminan 346 reglas cuyas clases ya no aparecen en el HTML ni en el JS (lobby y arena antiguos, inicio antiguo, tienda antigua): `style.css` 63,6 → 50,9 KB y `checkpoint.css` 86,9 → 66,6 KB (−33 KB sin comprimir). Se conservan las clases que se generan por plantilla (`set-*`, `board-*`, `crown-*`, `st-*`, etc.) |

### Cómo se comprobó que la poda no cambia nada

Se midieron los estilos calculados (22 propiedades de cada elemento visible) con el CSS nuevo y con el anterior, en la misma sesión: **13 pantallas en escritorio, 10 en móvil (375 px) y la pantalla de partida**. Resultado: 0 diferencias, salvo Circuit en escritorio, cuyas diferencias son el estado del torneo, que cambió entre las dos mediciones (`scheduled` → `closed`), no el estilo. No se comprobaron estados que no estaban en pantalla (modales, tutorial, estados de error).

### Retirada del 3D (fase 4)

- Se borran `board3d.js`, `arena3d.js`, `arena-caps.js`, `public/vendor/three` (2,1 MB) y el importmap; ninguna pantalla los usaba ya.
- Funciones que dependían del 3D y se han rehecho en 2D: **animaciones de coronación** (cosméticos «Coronación»: `crownFx` en `game.js` + clases `crown-*`), **tarjeta para compartir** (el tablero se dibuja en un canvas) y **vídeo del final** (WebM grabado del canvas 2D del clip, también desde el clip de la repetición). Comprobado en el navegador: tarjeta PNG de 139 KB, vídeo WebM de 107 KB y capa de coronación que aparece y se retira.
- `test/cosmetics.test.js` exige ahora el recurso 2D de cada cosmético (CSS de piezas, tableros y coronaciones) en lugar del material 3D.
## Datos de los highlights

- **Propios:** solo partidas guardadas por el servidor (`/api/me/games` y `/api/games/:id`, verificadas al leerlas). Se toman como «buena jugada» únicamente `checkmate`, `brilliant`, `sacrifice`, `opportunity`, `promotion` y `turnaround`, y siempre del propio jugador. Los criterios están en `docs/REPETICIONES.md`. Nada se inventa: si no hay jugadas destacadas se dice y se ofrece analizar.
- **Mundiales:** `public/js/world-highlights.js`. Partidas del siglo XIX de dominio público, con jugadores, lugar y año bien documentados. `test/highlights.test.js` comprueba que todas las jugadas son legales, que terminan en mate con el resultado anunciado, que la jugada clave es la indicada y que un «sacrificio» entrega al menos 5 puntos de material. Las explicaciones describen lo que se ve en la secuencia; la evaluación numérica la da Stockfish en el navegador cuando se pide.
- **Ampliar:** con más de tres partidas aparecen las pestañas por categoría (sacrificios, combinaciones, mates, defensas, finales, estrategia y errores castigados). Una fuente externa (por ejemplo, PGN de bases de datos abiertas) entraría como un archivo de datos con su licencia y pasaría la misma prueba.

## Pendiente y riesgos

- Fase 5 (arriba). Progreso, Amigos, Historial, Ajustes y Academia aún usan algunos iconos emoji y tarjetas densas; `minimal.css` las suaviza pero no las reorganiza.
- Las piezas son glifos Unicode con contorno (como antes); un juego de piezas SVG propio mejoraría la legibilidad en tamaños pequeños.

## Revisión tras las pruebas de uso: cuentas, avatares y tablero de la repetición

- **Tablero de la repetición (bug):** las filas sin piezas se aplastaban (la fila 3 medía una fracción de las demás) porque la rejilla no fijaba la altura de las filas. Ahora `grid-template-rows: repeat(8, minmax(0, 1fr))`; medido: las 8 filas miden igual (55 px).
- **Entrar, crear cuenta y cerrar sesión** (`auth.js`, `net.js`). Antes la app creaba una cuenta de invitado sola y no había forma de salir. Ahora:
  - **Perfil → Cuenta → Cerrar sesión**: avisa de que el código de recuperación es la única forma de volver (lo muestra con «Copiar»), envía lo pendiente (cartera y guardado), olvida la sesión, **vacía el progreso local y la cola de operaciones** (nada de una cuenta puede acabar en otra) y recarga. La cuenta sigue en el servidor.
  - Con la sesión cerrada **no se crea ninguna cuenta por detrás**. Se abre el diálogo **Entrar / Crear cuenta** (se puede seguir sin cuenta con la Academia y la IA); arriba aparece el botón «Entrar»; las pantallas online explican que hace falta una cuenta en vez de decir «sin conexión».
  - **Entrar** = escribir el código (acepta minúsculas, espacios o guiones; se guarda como `XXXX-XXXX-XXXX`). **Crear cuenta** = nombre público opcional (se valida y, si el servidor lo rechaza por una palabra no permitida, avisa del nombre asignado) y muestra el código antes de continuar. Sin contraseñas ni correos, como hasta ahora.
  - `test/session.test.js` ejecuta el `net.js` real contra un servidor real (arranque, cierre, no recrear cuenta, crear con nombre, entrar con código desordenado, código incorrecto) y falla si se quita la protección de «no crear cuenta tras cerrar sesión» (comprobado).
- **Iconos de usuario descentrados:** el avatar de pieza era un glifo de texto (`♟`) y cada fuente lo colocaba distinto, además de que una regla del contenedor anulaba su centrado. Ahora todos son **siluetas SVG** dibujadas en un lienzo 64×64, centradas siempre igual.
- **Más carácter en los perfiles:**
  - Cada avatar tiene su **escena** (rayos, estrellas, rejilla, llamas, olas, pétalos, halo) y un brillo según su rareza; los legendarios llevan un destello animado (desactivado con movimiento reducido).
  - **Cuatro avatares nuevos**, todos por nivel: Centinela (8), Gambito (12), Fantasma (20) y Monarca (35).
  - **Lo bloqueado enseña su silueta** (con el color de su rareza) en lugar de un candado vacío; la vista previa grande sí muestra el aspecto completo, y el texto dice cuántos niveles faltan («te faltan 14 niveles»).
  - **Perfil → Resumen** estrena «Tu colección»: barra de desbloqueados y los **próximos objetivos** (avatares, marcos, coronaciones, efectos...), con su nivel y lo que falta. La tarjeta del perfil tiene un aura del color de la rareza del avatar equipado.

## Primera visita, invitados y modo oscuro forzado (prueba con otra persona en un móvil Android)

Un hermano abrió el enlace en un móvil (navegador con «modo oscuro para sitios web») y vio el tablero del tutorial con casillas rojizas y **todas las piezas blancas**, y se quejó de que no había forma de crear cuenta y de que el invitado aparecía con 1000 de Elo.

- **Tablero «todo blanco» (causa probable, no reproducida en un dispositivo real):** los navegadores con oscurecimiento forzado (Samsung Internet, Chrome en Android) invierten los colores de las páginas que no declaran su tema: las casillas claras salen rojizas y las piezas negras se vuelven claras. La app es oscura por diseño y no lo declaraba. Ahora lo hace (`<meta name="color-scheme" content="dark">` y `:root { color-scheme: dark }`), que es lo que esos navegadores respetan. En local, con un usuario nuevo, el tablero del tutorial sale correcto (casillas crema y marrón, pieza negra oscura), así que el problema no estaba en los estilos. **Pendiente de confirmar en ese móvil.**
- **Pieza tapada:** el botón de preferencias de la partida estaba sobre la casilla a8 y escondía el rey negro del primer paso del tutorial. Ahora está junto a las acciones de la partida.
- **Bienvenida:** quien llega por primera vez ya **no recibe una cuenta sin preguntar**. Ve «Bienvenido a CHECKPOINT» con **Crear cuenta**, **Entrar** y **Jugar como invitado** (y «Ahora no» para mirar sin cuenta).
- **Invitado:** puede jugar al instante. Arriba tiene un botón **Crear cuenta** que *reclama* la misma cuenta (elige nombre y guarda el código, sin perder lo jugado) y el perfil lo marca como «Invitado». Quien tiene una sesión caducada sigue recibiendo una cuenta de invitado nueva en vez de quedarse bloqueado.
- **Sin Elo 1000 de adorno:** el 1000 es solo el punto de partida del emparejamiento. Hasta que se termina la primera clasificatoria se muestra **«Sin clasificar»** (barra superior, lobby, perfil, hub online y perfil público; el servidor añade `ranked` al perfil) y no se asigna liga. Los invitados no tienen rating visible hasta jugar una clasificatoria.
  - **Decisión de producto abierta:** ahora un invitado *puede* jugar clasificatoria y su rating aparece tras la primera partida. Si se prefiere que la clasificatoria exija cuenta, sería un cambio en el lobby (y en el servidor, si debe ser algo más que una recomendación, porque «invitado» es hoy una marca local).

### Código viejo tras un despliegue (service worker)

Al verificar en producción, el navegador de pruebas cargó una mezcla de módulos antiguos y nuevos (el diálogo de bienvenida con textos de la versión anterior y la lógica nueva). La causa estaba en `sw.js`: servía los `.js` y `.css` **de la caché y los actualizaba después**, así que cualquier visitante recurrente veía una versión vieja de cada módulo (a veces cada uno de una distinta) hasta recargar dos veces. Ahora el código de la app (js, css, html) va **red primero** con revalidación y la caché solo como respaldo sin conexión, y se subió la versión de la caché a `checkpoint-v2` para vaciar las copias antiguas. Los archivos que no cambian (vendor, iconos) siguen en caché.
