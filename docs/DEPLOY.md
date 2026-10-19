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
| `DATABASE_URL` | *(vacío)* | Postgres (Neon) donde se copia la base de datos en alojamientos **sin disco**. Si está definida, se restaura al arrancar y se guarda cada 15 min, al apagar y tras cambios |
| `PERSIST_INTERVAL_MS` | `900000` | Cada cuántos ms se guarda la copia (solo con `DATABASE_URL`) |
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

## Opción B · Render GRATIS + Neon + UptimeRobot (0 €, sin instalar nada)

El plan gratuito de Render **no tiene disco** (se borra al reiniciar) y **se duerme a los 15 minutos sin tráfico**. Se
resuelve con dos servicios gratuitos más:

- **Neon** (Postgres gratis): guarda una copia de la base de datos SQLite (cuentas, ranking, partidas). El servidor la
  restaura al arrancar y la guarda cada 15 min si hubo cambios, y siempre al apagarse (ver `server/persist.js`).
- **UptimeRobot**: llama a `/healthz` cada 5 min para que Render no lo duerma (y te avisa si se cae).

**Paso 1 · Neon.** En [neon.com](https://neon.com) → **New project** (nombre `gambito`, región cercana a Oregon/`us-west-2`).
En el panel pulsa **Connect** y copia la *connection string* (`postgresql://...neon.tech/...?sslmode=require`).
Compruébala antes de usarla (la cadena no sale de tu equipo):

```powershell
$env:DATABASE_URL = "postgresql://...neon.tech/...?sslmode=require"
npm run check:neon
```
Debe terminar en "Neon listo".

**Paso 2 · Render.** En [render.com](https://render.com) entra con GitHub → **New +** → **Blueprint** → repositorio `gambito`.
El plan ya es **Free**. Render te pedirá el valor de `DATABASE_URL`: pega la cadena de Neon. **Apply**.
Cuando termine el despliegue copia la URL (`https://gambito-xxxx.onrender.com`).

**Paso 3 · UptimeRobot.** En [uptimerobot.com](https://uptimerobot.com) → **Add New Monitor** → tipo **HTTP(s)**, URL
`https://gambito-xxxx.onrender.com/healthz`, intervalo **5 minutos**.

**Paso 4 · Comprobar.** `npm run smoke -- https://gambito-xxxx.onrender.com` (debe mostrar "Copia de la base de datos (Neon) sin errores").

Límites del plan gratuito, para ir con los ojos abiertos:

- **750 horas/mes** en total por cuenta de Render: alcanza para **un** servicio encendido 24/7 (744 h). No crees otro.
- Si el monitor falla un rato, el servicio se duerme y el primer visitante espera ≈ 1 minuto mientras despierta.
- La copia a Neon es cada 15 min (más a menudo agotaría las 100 CU-horas gratuitas de Neon, que se suspende a los 5 min
  de inactividad). Si el servidor muriera de golpe (no por un reinicio normal, que sí guarda al final), se perderían como
  máximo 15 minutos de cuentas nuevas y resultados. Los jugadores no pierden su progreso: el cliente lo guarda también en su navegador.
- Las partidas en curso se pierden si el servicio se reinicia (las salas viven en memoria).
- CPU compartida y 512 MB: suficiente para decenas de jugadores simultáneos; para más, pasa al plan de pago con disco.

Esa misma URL ya sirve **el juego completo** (cliente + servidor, mismo origen). Los despliegues son automáticos con cada
`git push` a `main`. Con plan de pago (Starter) puedes quitar `DATABASE_URL`, añadir un disco en `/data` y poner
`DATA_DIR=/data`: los discos de Render son propiedad de root, por eso el contenedor no usa un usuario sin privilegios.

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
