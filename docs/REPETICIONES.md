# Repeticiones inteligentes y momentos destacados (PROMPT 08)

Convierte las partidas terminadas en algo que apetece revisar y compartir, sin gastar recursos del servidor y sin abrir la puerta a falsificar resultados.

## 1. Qué ya existía y qué se reutiliza

- **Formato de historial:** la tabla `games` guarda las jugadas como lista JSON de movimientos UCI (`["e2e4","e7e5", …]`) con ganador y motivo. No se crea un formato nuevo ni se duplica en PGN: el visor y el análisis derivan SAN y FEN de esa lista con chess.js.
- **Visor (Fase 3):** reproducción sobre la escena 3D con inicio/anterior/reproducir/siguiente/final, velocidad y deslizador; tarjeta de imagen y vídeo del final (`share.js`).
- **Motor:** Stockfish.js (WASM) ya se sirve en `public/vendor/stockfish`. Se reutiliza en el navegador.

## 2. Visor

| Función | Cómo |
|---|---|
| Reproducir/pausar, paso a paso, inicio, final, velocidad | Barra del visor; teclado: ← → Inicio Fin y espacio |
| Ir a una posición | Deslizador, o pulsar cualquier jugada de la lista o de un momento destacado |
| Notación | Lista completa de jugadas (SAN) con la actual resaltada y clicable |
| Resultado y participantes | Tarjeta con nombres públicos, rating y liga, resultado en palabras, controles y contexto de torneo |
| Reanudar | `?m=N` en el enlace abre en esa jugada; sin parámetro se retoma donde lo dejaste (se guarda solo en tu navegador) |

## 3. Integridad: nadie falsifica una repetición

1. **Única fuente:** las jugadas y el resultado salen de `games`, que solo escribe el servidor al terminar una sala. No hay ninguna ruta de escritura sobre una partida (`PUT/PATCH/DELETE/POST` sobre `/api/games/:id` devuelven 405; `POST …/share` ignora cualquier cuerpo).
2. **Verificación al leer** (`server/replay.js → verifyGame`): se reproducen las jugadas con las reglas del ajedrez y se comprueba el resultado.
   - `proof: 'moves'` si se deduce de la posición: jaque mate (y que ganó quien dio el mate), rey ahogado, material insuficiente, triple repetición, 50 jugadas.
   - `proof: 'server'` si lo decidió el reloj o un evento (tiempo, rendición, desconexión, tablas acordadas, abortada). Se comprueban las incoherencias que sí se pueden detectar (abortada con 2 o más jugadas, rendición sin partida, tablas con ganador…).
   - Jugadas ilegales o resultado que no cuadra → `integrity.ok = false` y el visor lo marca «Sin verificar».
3. **El análisis es solo local:** el cálculo de Stockfish y los clips ocurren en el navegador, nunca se envían al servidor y no tocan rating, torneos ni historial. Un `?m=` es solo una posición de visualización.
4. Probado en `test/replay-share.test.js` (incluye manipular la base de datos y comprobar que se marca).

## 4. Enlaces y privacidad

- **Partida pública** (clasificatoria o de torneo, y ningún jugador con perfil privado o restringido): `/r/ID`, `/r/ID?m=N`. La privacidad se comprueba al leer.
- **Partida privada** (con amigos, o con un jugador privado): no se ve por id. Cualquiera de los dos jugadores puede **crear un enlace** (`POST /api/games/:id/share`) con un token aleatorio `rs…` (15 bytes). Un solo token por partida, no contiene ni revela el id de la partida y cualquiera de los dos jugadores puede **revocarlo** (`DELETE`). Máximo 20 acciones por minuto.
- El enlace muestra los nombres públicos, las jugadas y el resultado. Nunca correos, tokens ni datos de cuenta.

## 5. Momentos destacados (`public/js/moments.js`)

Módulo puro (se prueba en Node). Cada momento indica su origen: **Jugadas** (se deduce solo de la partida) o **Motor** (necesita evaluar posiciones).

| Momento | Origen | Criterio |
|---|---|---|
| Jaque mate | Jugadas | La jugada termina en `#` |
| Coronación | Jugadas | La jugada promociona (con o sin captura) |
| Victoria en torneo / Campeón | Jugadas + contexto del servidor | Partida de Circuit con ganador; campeón si es la final y el ganador es el campeón registrado |
| Material cedido | Jugadas | Quien mueve pierde ≥ 2 puntos de material netos tras la respuesta rival y sigue sin recuperarlos 2 jugadas después. **Es solo una sospecha**: sin motor no se sabe si fue sacrificio o error |
| Error / Error grave / Imprecisión | Motor | La jugada baja la probabilidad de ganar ≥ 20 / 30 / 10 puntos (bandas de Lichess) |
| Error aprovechado / Oportunidad perdida | Motor | Tras un error rival: se mantiene ≥ 65 % de ganar, o se tira una ventaja ≥ 60 % |
| Sacrificio sólido / brillante | Motor | Cede ≥ 2 puntos de material, no empeora la posición más de 3 puntos, no ocurre con la partida ya ganada (> 85 %), deja ≥ 40 % de ganar; es «brillante» solo si 2 jugadas después la ventaja ha crecido ≥ 5 puntos |
| Remontada | Motor | Pasa de ≤ 25 % a ≥ 60 % de ganar |

Una captura **nunca** basta para llamar «brillante» a una jugada. Con análisis, el motor manda: el «material cedido» desaparece y queda como error, sacrificio o cambio normal. Los umbrales viven en `THRESHOLDS` y están cubiertos por `test/moments.test.js`.

**Análisis** (`public/js/analysis.js`): Stockfish en un worker propio, profundidad 11 y 250 ms por posición (≈ 6 s para una partida corta, 20-30 s para 60 jugadas), con progreso y cancelación. Las posiciones terminales se puntúan por reglas. El resultado se cachea en `localStorage` por partida. Si el motor no carga, se avisa y los momentos «Jugadas» siguen disponibles.

## 6. Clip 2D (`public/js/clip.js`)

Primera versión: animación sobre un canvas 2D, en el navegador de quien lo ve, con la marca CHECKPOINT, nombres públicos, resultado y contexto de torneo o modo. Se elige el momento (hasta 5) o el final. Botones: repetir, copiar enlace a esa jugada y abrir en la repetición. Respeta `prefers-reduced-motion`.

- **No se genera ningún vídeo en el servidor.**
- **Exportación a vídeo (mejora posterior):** `share.js` ya graba el final en 3D con `MediaRecorder`; grabar este mismo canvas sería un cambio pequeño (`canvas.captureStream`). Se deja para cuando se compruebe que se usa.

## 7. Límites conocidos

- El análisis depende del dispositivo: en móviles antiguos tarda más. Es opcional y cancelable.
- Un sacrificio que ya llevaba a mate forzado no se marca «brillante» porque la partida estaba ganada (criterio conservador a propósito).
- La caché de análisis no se comparte entre dispositivos.
- El contexto de torneo se obtiene por el código de sala; si el cuadro no lo conserva, la partida se muestra sin ronda.
- Con partidas muy largas (> 200 jugadas) el análisis es lento; conviene un límite o análisis parcial si se usa mucho.
