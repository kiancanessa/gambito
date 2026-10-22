# Arquitectura

```
Navegador (public/)                         Servidor Node (server/)
┌──────────────────────────┐   HTTPS/JSON   ┌───────────────────────────────┐
│ main.js (navegación)     │ ─────────────▶ │ api.js   cuentas · nube ·     │
│ net.js  (sesión, nube)   │                │          diario · ranking      │
│ online.js (partidas)     │   WebSocket    │ ws.js    mensajes de juego     │
│ game.js + board3d.js     │ ◀────────────▶ │ rooms.js salas, relojes, reglas │
│ Stockfish (Web Worker)   │                │ matchmaker.js  cola por Elo    │
└──────────────────────────┘                │ db.js  SQLite (node:sqlite)    │
                                            │ static.js  estáticos + CSP     │
                                            └───────────────────────────────┘
```

Un solo proceso sirve estáticos, API y WebSocket en el mismo puerto. Las salas y la cola viven **en memoria**
(una única instancia); cuentas, guardados, partidas terminadas y resultados del diario viven en SQLite.

## Cuentas

- `POST /api/guest` crea una cuenta anónima y devuelve `{ token, recovery }`. El servidor guarda solo `sha256(token)`
  y `sha256(recovery)`. El token va en `Authorization: Bearer` y en el primer mensaje del WebSocket.
- `POST /api/recover { code }` rota el token y devuelve la sesión de esa cuenta.
- Nombre público: 3-16 caracteres, filtrado. Todo nombre se escapa en el cliente antes de pintarlo.

## API REST

| Método y ruta | Auth | Descripción |
|---|---|---|
| `POST /api/guest` | no | Crea cuenta de invitado |
| `POST /api/recover` | no | Recupera una cuenta con su código |
| `GET/PATCH /api/me` | sí | Perfil / cambiar nombre |
| `POST /api/me/recovery` | sí | Regenera el código de recuperación |
| `GET/PUT /api/save` | sí | Guardado en la nube (JSON ≤ 64 KB) |
| `GET /api/daily` | opcional | Puzzle del día, ranking y mi resultado |
| `POST /api/daily/submit` | sí | Envía solución (se verifica con chess.js) |
| `GET /api/leaderboard` | opcional | Top 20 por rating |
| `GET /api/wallet` | sí | Cartera verificada (oros, XP, nivel, inventario, equipado); se crea desde el guardado la primera vez |
| `POST /api/wallet/ops` | sí | Lote de operaciones (`buy`, `equip`, `spend`, `earn`, `reset`) ≤ 50; devuelve la cartera y el resultado de cada una |
| `GET /api/me/games` | sí | Tus últimas partidas online (`?limit=`, máx. 50): resultado, rival, control, jugadas |
| `GET /api/games/:id` | sí | Partida completa para la repetición (jugadas UCI, jugadores). Solo la ven quienes la jugaron; si no, 404 |
| `GET /api/circuit` | no | Royale Circuit: inscripción abierta, torneos en curso con sus partidas en directo y últimos campeones |
| `GET /api/circuit/me` | sí | Tus premios del Circuit (placement, oros, objeto) |
| `GET /api/social` | sí | Tu código de amigo, amigos (con presencia), solicitudes enviadas/recibidas y bloqueados |
| `POST /api/social/{request,respond,remove,block,unblock}` | sí | Solicitud (por `code`, o por `id` si habéis compartido partida), aceptar/rechazar, quitar, bloquear y desbloquear |
| `POST /api/report` | sí | Reporta a un jugador con quien has jugado (`reason`: abuso, trampas, nombre, otro) |
| `GET /api/live` | no | Hasta 6 partidas clasificatorias en curso (solo lectura; las de amigos no se listan) |
| `GET /api/metrics` | `METRICS_TOKEN` | Métricas internas (JSON o `?format=prom`); no existe sin el token configurado |
| `GET /api/stats`, `GET /healthz` | no | Estadísticas públicas / salud |

Hay límites de peticiones por IP y por usuario (`server/api.js`).

## Protocolo WebSocket (`/ws`, JSON)

Cliente → servidor: `invite {to}` (Social), `circuit_join`, `circuit_leave`, `circuit_sync` (Royale Circuit) y `auth {token}`, `create {tc, color}`, `join {code}`, `queue {tc}`, `dequeue`,
`move {uci}`, `resign`, `draw {action: offer|accept|decline}`, `emote {id}`, `rematch`, `leave`.

Servidor → cliente: `invite {from, code, tc}`, `invited`, `friend_request {from}`, `friends_changed` (Social), `circuit_state {circuit}` (vista completa del torneo del jugador), `circuit_match {code, round, label, opponent}` (entrar a su partida) y `authed`, `created {code}`, `state {…}`, `queued`, `matched {code}`, `emote`, `error {message, code?}`.

`state` es la **única fuente de verdad** de una sala: `fen`, `moves` (UCI), `turn`, `status` (`waiting|playing|over`),
`result`, `clocks` (ms restantes + bando en marcha), `players`, `drawOffer`, `rematchCode`, `ratingDelta`, `you` (`w|b|s`).
El cliente aplica las jugadas nuevas con animación; si detecta un desajuste (jugada rechazada, reconexión) reconstruye la partida.

Reglas de sala: el reloj de cada bando empieza tras su primera jugada; el incremento se suma desde la 3ª jugada;
rendirse antes de que ambos muevan aborta la partida sin tocar el ranking; 45 s sin conexión pierden la partida.

## Protecciones

- **Topes** (`server/config.js`, objeto `LIMITS`): 3 partidas abiertas por jugador, 8 salas nuevas por minuto, 20 WebSockets por
  IP, 6 conexiones por cuenta, 200 espectadores por sala, 5000 salas en total. Cancelar una sala vacía en espera la elimina al instante.
- **Final por tiempo:** si el rival no puede dar mate con su material (`hasMatingMaterial` en `rooms.js`), son tablas.
- **Cliente alojado aparte:** `ALLOWED_ORIGINS` activa CORS en la API y permite el origen en el WebSocket. El cliente toma la URL del
  servidor de `window.GAMBITO_API` (`public/config.js`). La sesión va en `Authorization: Bearer`, sin cookies.
- **CSP:** el importmap se autoriza por hash (con finales de línea normalizados a LF, igual que el navegador).

## Persistencia en alojamientos gratuitos

`server/persist.js` permite desplegar donde el disco es efímero (Render Free): con `DATABASE_URL` (Postgres de Neon) la base de datos
SQLite se restaura al arrancar y se copia con `VACUUM INTO` cada 3 min si hubo cambios (`total_changes()`) y al recibir SIGTERM.
Solo la instancia "propietaria" (columna `owner`) escribe la copia. En un despliegue solapado la nueva restaura pero no escribe
hasta el **relevo**: la antigua sube su copia `final` al apagarse, la nueva la fusiona (`mergeSnapshot`: filas nuevas se añaden;
en conflicto gana la más reciente o con más partidas) y toma la propiedad. Si no se puede leer la copia al arrancar, el servidor
entra en **modo degradado** (sin copias, sin pisar la buena) en vez de caerse.

## Cartera verificada (Fase 2)

`server/wallet.js` guarda oros, XP, inventario y equipado en las tablas `wallets` y `ledger` (libro de movimientos con clave única
`(user_id, ref)`, que hace idempotentes los reintentos). El cliente aplica los cambios al instante y los envía como operaciones
(`public/js/wallet.js`, flag `wallet`); cuando el servidor responde, **su cartera manda** y el estado local pasa a ser un espejo.
Las operaciones pendientes se guardan en `localStorage` y se reenvían al volver la conexión.

| Origen (`source`) | Cómo se valida |
|---|---|
| `buy`, `equip` | Precio y existencia según el catálogo (`SHOP` de `public/js/data.js`); saldo suficiente |
| `online` | El servidor busca la partida en `games` (el jugador debe haber participado) y calcula victoria/jaques él mismo |
| `puzzle` | Solo si existe el resultado en `daily_results` para ese día |
| `season` | El premio lo decide `SEASON` por nivel; una sola vez por nivel |
| `game`, `mission`, `tutorial`, `login` | No se pueden comprobar (la IA corre en el cliente): tope por evento y por 24 h |
| `spend` (pistas) | Importe máximo fijo y saldo suficiente |

Migración idempotente: la primera vez que se pide la cartera se crea desde el guardado antiguo, recortado (máx. 20 000 oros, solo
objetos del catálogo). Después, el guardado en la nube ya no decide estos campos. `mergeSnapshot` también fusiona estas tablas y
tolera copias de versiones sin ellas. Lo que sigue en el cliente: temporada (XP), misiones, progreso de la Academia y estadísticas.

## Repeticiones (Fase 3)

Cada partida online terminada ya se guarda en `games` con sus jugadas; la Fase 3 solo las expone. `public/js/replay.js` abre la pantalla de
partida en modo espectador sin motor (`remote.send` vacío y `game.over = true`) y la gobierna con una barra: inicio/anterior/
reproducir/siguiente/final, velocidad 0,5×–2× y deslizador. Avanzar de uno en uno anima la jugada; retroceder o saltar reconstruye
la posición con `loadMoves`. **Compartir** reutiliza `share.js`: tarjeta o clip de las últimas jugadas hasta el punto que estés viendo.

## Royale Circuit (Fase 4, rediseñado en el PROMPT 04)

Torneos eliminatorios **programados por un organizador automático** (sin bots, sin salas de usuario). Diseño, estados, reglas,
protocolo y criterios de aceptación: **[CIRCUIT.md](CIRCUIT.md)**. Resumen:

- `server/bracket.js`: cuadro de eliminación simple, puro y probado (cabezas de serie, byes, avance, puestos) para 4, 8, 16, 32 y 64.
- `server/circuit-store.js` + tablas `circuit_tournaments / circuit_entries / circuit_matches`: cada paso es una transacción con
  comprobación de estado (compare-and-set), así que un resultado no se aplica dos veces ni un jugador ocupa dos plazas.
- `server/tournaments.js` (`CircuitManager`): estados `scheduled → open → closed → running → finished | cancelled`, un único `tick()`
  que mueve los estados por hora, recuperación tras reinicio (`recover`) y difusión en tiempo real (`circuit_list`, `circuit_state`).
- Las partidas son `Room` normales con asientos reservados y estrictos; el servidor decide cada resultado y el cliente no puede declarar nada.
- Al terminar se guarda en `tournaments` y `tournament_results` (historial y premios); los premios se cobran por la cartera con la
  fuente `circuit` (clave `circuit:<id>`, solo para quien tiene resultado). El set exclusivo **Corona del Circuito** no se compra.
- `CIRCUIT_EVERY_MS`, `CIRCUIT_MIN_PLAYERS` y `CIRCUIT_LEAD_MS` acortan el calendario para probarlo a mano.

## Progresión (PROMPT 05)

`server/progression.js` + `xp-rules.js`: XP de cuenta, misiones, logros y temporadas **verificados en el servidor**. `RoomManager.onGameSaved`
avisa al terminar cada sala; el módulo analiza la partida guardada (`games`) y concede XP idempotente (`progress_events`, clave única
por jugador y evento) por el libro de cuentas de la cartera (`wallets.grantInTx`). Las misiones se recalculan con los eventos del
periodo al reclamarlas (`mission_claims`, `season_claims`); la clasificación de temporada vive en `season_stats`. Detalle y criterios
de aceptación: **[PROGRESION.md](PROGRESION.md)**.

## Cosméticos (PROMPT 06)

`public/js/cosmetics-data.js` es el catálogo (compartido con el servidor); el inventario vive en la cartera (`owned` / `equipped`) y solo el
servidor lo amplía: `server/cosmetics.js` concede los artículos de nivel y logro (`sync`) y valida el equipado. Detalle en **[COSMETICOS.md](COSMETICOS.md)**.

## Comunidad (PROMPT 07)

`server/community-store.js` (tablas `user_privacy`, `moderation`, `public_games`, `community_events`), `server/profiles.js` (perfiles recortados por
privacidad), `server/community.js` (reglas de eventos de creadores) y el retraso de espectadores en `server/rooms.js`. Detalle, límites y variables
(`SPECTATOR_DELAY_*_MS`, `ADMIN_TOKEN`) en **[COMUNIDAD.md](COMUNIDAD.md)**.

## Social (Fase 5)

`server/social.js` (tablas `friend_codes`, `friendships`, `blocks`, `reports`). Sin email ni chat libre: cada jugador tiene un **código de amigo** de
8 caracteres (`ABCD-EFGH`) que comparte fuera del juego. La amistad se pide con el código (30 acciones/min por usuario) o por `id` solo si
habéis **compartido partida** (sala viva o historial en `games`; nunca con bots), y se acepta desde el otro lado; si los dos se piden, se acepta sola.
Límites: 100 amigos, 20 solicitudes enviadas, 200 bloqueos, 5 reportes al día.

- **Presencia:** `online`, `queue` o `playing`, calculada con los sockets abiertos (`presence()` en `ws.js`); el cliente la consulta cada 15 s.
- **Invitaciones:** `invite {to}` solo desde tu sala en espera y a un amigo no bloqueado; llega como `invite` a todas sus conexiones y expira a los 2 min en el cliente.
- **Bloquear** borra la amistad, impide solicitudes en ambos sentidos (siempre responde «no encontrado», sin revelar quién bloqueó) y el matchmaker no los empareja (`canMatch`).
- **Reportes:** se guardan con motivo de una lista; uno por objetivo y día. No hay sanciones automáticas (se podrían usar para linchar a alguien): `npm run reports` los lista por número de personas distintas, leyendo la copia de Neon o una base local.

## Cliente

- `session.js` prepara la pantalla de partida y crea un `Game` por modo (IA local, online, desafío diario con
  `limitMoves`, tutorial con `scripted`).
- `game.js` aplica las reglas con chess.js, gestiona la IA (Stockfish en un Worker) y delega el dibujo en `board3d.js`
  (o en el tablero DOM de respaldo).
- `store.js` guarda el progreso en `localStorage` (con `wallet` activo, `wallet.js` lo concilia con el servidor); `net.js` lo sincroniza con la nube (gana el guardado con más progreso
  si hay conflicto entre dispositivos).

## Métricas y juego limpio (Fase 6)

`server/metrics.js` es un registro mínimo (contadores con etiquetas, medidores calculados al leer, histograma de latencia HTTP y retraso del bucle
de eventos con `perf_hooks`) sin dependencias. Se alimenta desde `rooms.js` (jugadas, partidas por modo/resultado), `ws.js` (conexiones, mensajes por
tipo, mensajes descartados por límite), `api.js` (cuentas creadas, operaciones de cartera por resultado), `tournaments.js` y `fairplay.js`.

`server/fairplay.js` reacciona de dos formas distintas, adrede:

1. **Protege el ranking (automático):** una clasificatoria no mueve el Elo si es la 4.ª+ contra el mismo rival en 24 h (reparto de puntos entre
   cuentas), ni si termina por rendición/desconexión antes de la 6.ª jugada. La sala informa con `unrated: 'pair' | 'quick'`. Además,
   `BLOCK_SAME_IP_RANKED=1` impide emparejar dos cuentas de la misma IP.
2. **Alertas para revisar (no sanciona):** con el tiempo que tardó cada jugada (`room.thinks`) se detecta ritmo casi idéntico (`uniform_timing`: ≥ 15
   jugadas, media ≥ 1,5 s y variación < 12 %) o jugar casi todo al instante (`instant_moves`: ≥ 20 jugadas, ≥ 60 % bajo 400 ms, no en bala). Se
   guardan en `game_flags` y se leen con `npm run reports`. No se evalúan las primeras 3 jugadas de cada bando ni las partidas con bots.

Sin motor de ajedrez en el servidor no se pueden detectar jugadas de ordenador por calidad; estas señales son baratas y solo orientan.

## Escalado (siguiente paso)

Para más de una instancia hay que sacar las salas y el emparejamiento a un almacén compartido (p. ej. Redis) y
usar sesiones pegajosas o pub/sub para los WebSockets. Hasta entonces: una sola máquina (ver `docs/DEPLOY.md`).
