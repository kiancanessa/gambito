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

## Opción A · Fly.io (recomendada)

```bash
fly launch --no-deploy --copy-config      # elige un nombre de app único (edita fly.toml)
fly volumes create gambito_data --size 1  # volumen para la base de datos
fly deploy
fly scale count 1                         # ¡una sola máquina!
```

`fly.toml` ya trae el puerto, el volumen, la comprobación de salud `/healthz` y `auto_stop_machines = "off"`.
Dominio propio: `fly certs add tudominio.com` y apunta el DNS donde indique Fly.

## Opción B · Render

Conecta el repositorio, elige "Blueprint" y usa `render.yaml`. **Los discos persistentes requieren plan de pago**;
en el plan gratuito la base de datos se borra en cada despliegue (sirve para probar, no para lanzar).

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
