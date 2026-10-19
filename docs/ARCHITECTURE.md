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
| `GET /api/live` | no | Hasta 6 partidas clasificatorias en curso (solo lectura; las de amigos no se listan) |
| `GET /api/stats`, `GET /healthz` | no | Estadísticas públicas / salud |

Hay límites de peticiones por IP y por usuario (`server/api.js`).

## Protocolo WebSocket (`/ws`, JSON)

Cliente → servidor: `auth {token}`, `create {tc, color}`, `join {code}`, `queue {tc}`, `dequeue`,
`move {uci}`, `resign`, `draw {action: offer|accept|decline}`, `emote {id}`, `rematch`, `leave`.

Servidor → cliente: `authed`, `created {code}`, `state {…}`, `queued`, `matched {code}`, `emote`, `error {message, code?}`.

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

## Cliente

- `session.js` prepara la pantalla de partida y crea un `Game` por modo (IA local, online, desafío diario con
  `limitMoves`, tutorial con `scripted`).
- `game.js` aplica las reglas con chess.js, gestiona la IA (Stockfish en un Worker) y delega el dibujo en `board3d.js`
  (o en el tablero DOM de respaldo).
- `store.js` guarda el progreso en `localStorage`; `net.js` lo sincroniza con la nube (gana el guardado con más progreso
  si hay conflicto entre dispositivos).

## Escalado (siguiente paso)

Para más de una instancia hay que sacar las salas y el emparejamiento a un almacén compartido (p. ej. Redis) y
usar sesiones pegajosas o pub/sub para los WebSockets. Hasta entonces: una sola máquina (ver `docs/DEPLOY.md`).
