# ♞ CHECKPOINT · Ajedrez competitivo

> Nombre provisional de la marca (antes «Gambito · Crónicas del Tablero»). Sistema visual en [docs/DESIGN.md](docs/DESIGN.md).

Ajedrez 3D con una **Academia** (de cero a experto), **partidas online**, **desafío diario**, misiones, pase de temporada y skins.
Gratis, sin anuncios y de **código abierto** (GPL-3.0). Funciona en el navegador, en móvil y se instala como app (PWA).

> Idea: que el ajedrez se sienta como un videojuego. Las piezas hablan, el tablero es 3D, hay temporadas y eventos,
> y todo lo que se compra es cosmético: **nunca se paga por ganar**.

## Qué incluye (beta)

| Área | Detalle |
|---|---|
| **Tablero 3D** | three.js: piezas torneadas, sombras, cámara con 3 ángulos, animaciones de captura, enroque, coronación y rey que cae en mate. Respaldo 2D si no hay WebGL. |
| **Academia** | Ruta de aprendizaje de cero a experto: 12 lecciones con 40+ ejercicios verificados con el motor de reglas (piezas, jaque y mate, movimientos especiales, táctica, finales con práctica contra la IA, aperturas y estrategia), pistas, estrellas, recompensas y «saltar de nivel». Los cinco rivales de la antigua campaña son las **pruebas finales**. |
| **Jugabilidad** | Selección y destinos legales claros, última jugada, jaque/mate, arrastrar y soltar o tocar origen y destino, teclado accesible con lector de pantalla, relojes con alerta de poco tiempo, estado de conexión del rival, y preferencias de sonido, animación y resaltados. El servidor valida jugadas, turno y reloj: las animaciones no afectan al tiempo y el cliente nunca declara resultados. |
| **Online** | Partida por enlace (`/g/CODIGO`), emparejamiento clasificatorio con Elo y ligas (Peón → Rey), relojes, tablas, revancha, espectadores y emotes (sin chat libre). |
| **Lobby competitivo** | Una sola pantalla con tu liga, cola clasificatoria, partidas con amigos/IA/Academia, desafío diario, misiones, temporada, ranking y partidas en vivo para espectar. Activo con el flag `lobby` (`public/config.js` → `window.GAMBITO_FLAGS`, o `?flag=lobby`). |
| **Desafío diario** | El mismo mate en 2-3 para todo el mundo, verificado en el servidor, con ranking por tiempo, racha y resultado compartible. |
| **Misiones y temporada** | Misiones diarias/semanales y pase de temporada (30 niveles gratuitos) con skins y oros. |
| **Royale Circuit** | Torneos eliminatorios programados por el servidor (Blitz de 8 y Rápida de 16, ampliable a 32/64): inscripción con plazo y cupo, cuadro con byes, relojes y resultados validados en el servidor, desempates explícitos, recuperación tras reinicios y pantalla en tiempo real. Sin bots. Ver [docs/CIRCUIT.md](docs/CIRCUIT.md). |
| **Juego limpio y métricas** | Una clasificatoria no puntúa si repite pareja más de 3 veces en 24 h o termina demasiado pronto; alertas de ritmo sospechoso para revisión; métricas en el log y en `/api/metrics`. |
| **Amigos** | Código de amigo, lista con presencia, retos e invitaciones a partida, bloqueos y reportes. Sin chat libre ni email (flag `social`). |
| **Repeticiones** | Historial de tus partidas online en el lobby y visor 3D con reproducción automática, saltos, velocidad y clip para compartir (flag `replays`). Solo quienes jugaron la partida pueden verla. |
| **Cartera segura** | Oros, XP e inventario se validan en el servidor (flag `wallet`): compras con precio del catálogo, recompensas online calculadas con la partida real y topes en lo que no se puede comprobar. |
| **Skins** | 6 sets de piezas, 6 tableros y 4 efectos de captura (materiales y texturas procedurales, sin imágenes). |
| **Compartir** | Tarjeta de imagen con tu tablero 3D y clip de las últimas jugadas (WebM grabado del canvas). |
| **Cuentas** | Cuentas de invitado automáticas + código de recuperación; progreso sincronizado en la nube. Sin email ni contraseñas. |
| **Tutorial** | 10 mini-retos de 1 minuto que enseñan las piezas, el jaque y el mate. |

## Empezar

Requisitos: **Node.js 24+** (usa `node:sqlite`, incluido en Node).

```bash
git clone https://github.com/kiancanessa/gambito.git && cd gambito
npm install
npm start            # http://localhost:5173
```

- `npm run dev` reinicia el servidor al cambiar archivos del servidor.
- `npm test` ejecuta las pruebas (servidor, WebSocket, límites, Elo, puzzles).
- `npm run smoke -- https://TU-SERVIDOR` prueba un servidor desplegado (cuentas, WebSocket y una jugada real).
- `npm run puzzles -- 365 10 --append` amplía `server/puzzles.json` con Stockfish (objetivo, procesos; sin `--append` lo regenera).
- `node scripts/dev-bot.js CODIGO` mete un bot en una sala para probar el online tú solo
  (o `queue:blitz5` para probar el emparejamiento).
- `node scripts/make-icons.js` regenera los iconos de la app.

El estado del servidor (cuentas, guardados, partidas, ranking) vive en un SQLite en `data/` (ignorado por git).

## Estructura

```
public/            cliente (HTML + CSS + JS modular, sin build)
  js/main.js         arranque, navegación, pruebas finales, tienda
  js/board3d.js      escena 3D: tablero, piezas, skins, cámara, animaciones
  js/game.js         controlador de partida (IA local, online, tutorial, puzzles)
  js/session.js      prepara la pantalla de partida para cada modo
  js/online.js       multijugador (hub, sala, relojes, emotes, revancha)
  js/social.js       amigos, invitaciones, bloqueos y reportes
  js/circuit.js      Royale Circuit (inscripción, cuadro, entrada a partidas, premios)
  js/replay.js       historial y visor de repeticiones
  js/shell.js        navegación principal, flags y cuenta del inicio (CHECKPOINT)
  js/ranking.js · js/history.js · js/settings.js   clasificaciones, historial y ajustes
  js/wallet.js       cartera verificada (cola de operaciones y espejo del servidor)
  js/lobby.js        lobby competitivo (agrega online, diario, misiones, temporada)
  js/net.js          API REST, sesión de invitado, nube y WebSocket
  js/daily.js        desafío diario    js/missions.js · js/season.js   progreso
  js/tutorial.js     tutorial          js/share.js   tarjeta y clip
  js/academy.js      Academia: pantalla de progreso y ejecución de lecciones
  js/academy-data.js contenido de la Academia y juez de ejercicios (puro, probado)
  js/prefs.js · feedback.js · records.js   preferencias de partida, avisos y récords personales
  js/arena3d.js · arena-caps.js   arena 3D del lobby (carga diferida) y detección de capacidades
  vendor/            chess.js, three.js y Stockfish (copiados de npm)
server/            Node: estáticos + API + WebSocket en un solo puerto
  index.js · api.js · ws.js · rooms.js · matchmaker.js · daily.js · db.js · elo.js · auth.js · static.js
scripts/           generador de puzzles, bot de desarrollo, iconos
test/              pruebas con el runner de Node (node:test)
docs/              arquitectura y despliegue
```

## Desplegar

Una imagen Docker lo contiene todo (`Dockerfile`). Hay una receta **100 % gratuita** (Render Free + Neon + UptimeRobot,
`render.yaml`) y otra para Fly.io (`fly.toml`). Guía paso a paso, dominio, HTTPS y límites de escalado en **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Contribuir

¡Las contribuciones son bienvenidas! Mira **[CONTRIBUTING.md](CONTRIBUTING.md)** y la lista de ideas abajo.

### Hoja de ruta

- [ ] Torneos "Battle" de 32/64 jugadores en vivo y clanes
- [ ] Más etapas de la Academia (finales avanzados, repertorios) y modos de evento (niebla de guerra, 960...)
- [ ] Pase premium cosmético, emotes y marcos de perfil
- [ ] Cuentas con email/OAuth y moderación
- [ ] Análisis de partidas
- [ ] Servidor escalable (Redis para salas y emparejamiento)

## Licencia y créditos

Distribuido bajo **GNU GPL v3** (ver [LICENSE](LICENSE)). Se incluye [Stockfish.js](https://github.com/nmrugg/stockfish.js)
(GPLv3), por lo que el conjunto se publica bajo la misma licencia: quien lo distribuya o lo ofrezca como servicio debe
mantener el código fuente disponible bajo GPL.
Otras bibliotecas: [chess.js](https://github.com/jhlywa/chess.js) (BSD-2), [three.js](https://threejs.org) (MIT), [ws](https://github.com/websockets/ws) (MIT).

## Honestidad técnica (qué confía en el cliente)

Es una beta pensada para validar el juego. Hoy el servidor **valida las jugadas, relojes y resultados** de las partidas
online y **verifica la solución** del desafío diario, pero: las monedas, skins y misiones se guardan desde el cliente
(son solo cosméticos), y el tiempo del desafío diario lo informa el cliente. Una cuenta de invitado se protege con un token
secreto y un código de recuperación: si pierdes ambos, no hay forma de recuperarla.
