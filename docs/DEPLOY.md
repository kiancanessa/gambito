# Despliegue

Gambito es **un único servicio Node** (estáticos + API + WebSocket) con una base de datos SQLite. Necesita:

1. Un host con **Node 24** o Docker.
2. **Almacenamiento persistente** para `DATA_DIR` (la base de datos `gambito.db`).
3. **HTTPS** (los navegadores exigen HTTPS para instalar la PWA y para `wss://`).
4. **Una sola instancia**: las salas y la cola están en memoria.

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `5173` | Puerto HTTP/WebSocket |
| `DATA_DIR` | `./data` | Carpeta de la base de datos SQLite |
| `DB_FILE` | `$DATA_DIR/gambito.db` | Ruta del archivo de base de datos |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `TRUST_PROXY` | `1` si `NODE_ENV=production` | Usa `X-Forwarded-For` como IP real (límites de peticiones) |
| `ALLOWED_ORIGINS` | *(vacío)* | Otras webs autorizadas a usar la API y el WebSocket (cliente en Vercel), separadas por comas |
| `CSP_CONNECT_EXTRA` | *(vacío)* | Orígenes extra permitidos en `connect-src` de la CSP (solo si el cliente se sirve desde este servidor pero usa otra API) |

Límites anti-abuso (en `server/config.js`): 3 partidas abiertas por jugador, 8 salas nuevas por minuto, 20 WebSockets por IP,
6 conexiones por cuenta, 200 espectadores por sala y 5000 salas en total.

## Comprobar un despliegue

Tras cada despliegue ejecuta la prueba de humo (crea dos cuentas "Smoke ..." y juega una jugada de verdad):

```bash
npm run smoke -- https://TU-SERVIDOR
npm run smoke -- https://TU-SERVIDOR --origin=https://tu-cliente.vercel.app   # simula el cliente en Vercel
```

## Opción A · Fly.io (recomendada)

```bash
fly launch --no-deploy --copy-config      # elige un nombre de app único (edita fly.toml)
fly volumes create gambito_data --size 1  # volumen para la base de datos
fly deploy
fly scale count 1                         # ¡una sola máquina!
```

`fly.toml` ya trae el puerto, el volumen, la comprobación de salud `/healthz` y `auto_stop_machines = "off"`.
Dominio propio: `fly certs add tudominio.com` y apunta el DNS donde indique Fly.

## Opción B · Render (la más sencilla, sin instalar nada)

1. En [render.com](https://render.com) inicia sesión con GitHub → **New +** → **Blueprint** → elige el repositorio `gambito`.
2. Render lee `render.yaml` (servicio Docker, disco de 1 GB en `/data`, región Oregon). Confirma el plan **Starter**
   (≈ 7 USD/mes; hace falta tarjeta). **No uses el plan gratuito**: se duerme a los 15 min (corta las partidas) y borra la
   base de datos en cada despliegue.
3. Espera a que termine el despliegue y copia la URL (`https://gambito-xxxx.onrender.com`).
4. Comprueba: `npm run smoke -- https://gambito-xxxx.onrender.com`.

Esa misma URL ya sirve **el juego completo** (cliente + servidor, mismo origen). Los despliegues son automáticos con cada
`git push` a `main`. Los discos de Render son propiedad de root, por eso el contenedor no usa un usuario sin privilegios.

## Opción C · VPS con Docker

```bash
docker build -t gambito .
docker run -d --name gambito --restart unless-stopped -p 8080:8080 -v gambito_data:/data gambito
```

Pon delante un proxy con HTTPS que reenvíe también WebSockets, por ejemplo Caddy:

```
tudominio.com {
  reverse_proxy localhost:8080
}
```

## Vercel (solo el cliente)

Vercel **no puede ejecutar el servidor** (necesita un proceso persistente para WebSockets y SQLite), pero sí aloja el
cliente como sitio estático (`vercel.json` publica la carpeta `public/`). Así quedan disponibles la campaña, el tutorial,
la tienda y las partidas contra la IA; el **modo online, el desafío diario y la nube** requieren el servidor en Fly/Render/VPS.

```bash
node scripts/make-vercel-config.js   # regenera vercel.json (hash de CSP) si editas el script en línea de index.html
vercel deploy --prod
```

### Cliente en Vercel + servidor en Render/Fly

Para que el cliente de Vercel use un servidor remoto:

1. En `public/config.js` pon `BACKEND_URL = 'https://TU-SERVIDOR'` (solo se usa en dominios `*.vercel.app`).
2. Ejecuta `node scripts/make-vercel-config.js`: añade el servidor a la CSP (`connect-src`) de `vercel.json`.
3. En el servidor define `ALLOWED_ORIGINS=https://tu-cliente.vercel.app` (CORS y WebSocket).
4. `git push` (Vercel y Render se redespliegan solos) y comprueba con `npm run smoke -- https://TU-SERVIDOR --origin=https://tu-cliente.vercel.app`.

Si prefieres un solo sitio, usa directamente la URL del servidor: ya sirve el cliente.

## Copias de seguridad

`gambito.db` está en modo WAL: copia también `gambito.db-wal` y `gambito.db-shm`, o usa
`sqlite3 gambito.db ".backup copia.db"` con el servidor en marcha. Programa una copia diaria.

## Lista antes de abrir al público

- [ ] HTTPS activo y dominio configurado (cambia `repoLink` en `public/index.html` y las metaetiquetas `og:`).
- [ ] Volumen persistente montado en `/data` y copias de seguridad programadas.
- [ ] `fly scale count 1` (o equivalente): una sola instancia.
- [ ] Revisa `public/privacidad.html` (plantilla): pon tu contacto y los datos del responsable. El juego guarda un identificador anónimo y el progreso del jugador.
- [ ] Subir `VERSION` en `public/sw.js` en cada despliegue que cambie archivos estáticos.
- [ ] Amplía los puzzles: hay 75 (≈ 2,5 meses de desafíos diarios) y después se repiten en bucle. Añade más con
      `npm run puzzles -- 365 10 --append` (365 en total, 10 procesos de Stockfish; tarda un buen rato).
- [ ] Revisar la lista de palabras bloqueadas de nombres (`server/auth.js`) para tu idioma y comunidad.
- [ ] Monitorizar `/healthz` y `/api/stats` (jugadores en línea, partidas del día).

## Cuando haya mucha gente

Un solo proceso Node aguanta miles de WebSockets, pero no se puede replicar tal cual: las salas viven en memoria.
Siguiente paso: mover salas y cola a Redis y repartir WebSockets con sesiones pegajosas (ver `docs/ARCHITECTURE.md`).
