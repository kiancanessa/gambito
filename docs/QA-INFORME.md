# Informe de QA, seguridad y rendimiento (PROMPT 10)

Alcance: todo lo construido hasta el PROMPT 08 (Academia, lobby, Circuit, progresión, cosméticos, comunidad, espectadores, repeticiones).
Fecha de la auditoría: 2026-10-22. Entorno: Windows 11, Node con `node:test`, servidores locales en memoria y el Browser del escritorio.
Principio: cada afirmación de este informe indica cómo se comprobó. Lo que no se pudo ejecutar figura en «No probado».

## 1. Resumen

| | |
|---|---|
| Problemas encontrados | **6** (1 crítico, 1 alto, 2 medios, 2 bajos) |
| Corregidos en esta entrega | **6** |
| Pruebas automáticas antes → después | 325 → **394** (69 nuevas, 0 fallos) |
| Pruebas nuevas que fallaban con el código anterior | **sí**, comprobado (sección 4) |
| Riesgos pendientes | 7 (sección 6) |

## 2. Problemas encontrados y corregidos

| # | Gravedad | Prioridad | Problema | Cómo se encontró | Corrección |
|---|---|---|---|---|---|
| 1 | **Crítica** | P0 | **Una sola petición tumba el servidor.** `GET /%E0%A4%A` (secuencia `%` mal formada) lanzaba `URIError` en `static.js`; dentro de un manejador `async` sin captura era un rechazo no controlado y Node terminó el proceso (salida 1). Cualquiera podía reiniciar el servidor a voluntad, perdiendo torneos y partidas en curso. | Lectura del código + reproducción local: sin el arreglo, 3 rutas dejaban la petición sin respuesta y sin manejador de rechazos el proceso terminaba con `URIError: URI malformed` y código 1 | `static.js` responde 400 a `%` mal formado y a bytes nulos; `index.js` envuelve el manejador HTTP en `try/catch` (500 controlado); el arranque registra los rechazos no controlados en vez de morir |
| 2 | **Alta** | P0 | **Todos los límites por IP se podían esquivar.** `index.js` y `ws.js` tomaban la **primera** entrada de `X-Forwarded-For`, que escribe el propio cliente. Cambiando la cabecera se saltaban: cuentas nuevas (20/h), recuperación de cuenta (10 intentos/10 min → fuerza bruta del código), 240 peticiones/min, tope de sockets y emparejamientos de la misma IP. Además permitía crecer sin límite el mapa de cubos en memoria. | Lectura del código; prueba nueva contra el código anterior: 3 de 3 pruebas de límites fallan | Nuevo `server/ip.js`: se toma la entrada **contada desde el final** (la que añade el proxy), configurable con `TRUSTED_PROXY_HOPS` (1 por defecto), con tope de longitud. Ver riesgo R1 sobre el despliegue |
| 3 | Media | P1 | **Cuerpos JSON `null`, `[]`, números o cadenas daban error 500** en 14 rutas de la API (`body.name` sobre `null` lanza `TypeError`), ruido en registros y respuesta de «error interno» en vez de 400. | Prueba de cuerpos hostiles sobre 19 rutas × 8 formas: 14 fallan con el código anterior | `readJson` solo admite objetos; el resto es 400 |
| 4 | Media | P1 | **`/api/stats` (público) publicaba `lastError` de la copia de seguridad**: ese texto procede del driver de Postgres y puede contener el nombre del servidor y mensajes de autenticación de la base de datos. | Lectura del código; prueba con un almacén que falla y precondición comprobada; falla con el código anterior | El endpoint expone solo `failing: true/false`; el detalle queda en los registros |
| 5 | Baja | P2 | **Historial: un fallo de red en la primera carga decía «No hay partidas con este filtro»** (error presentado como ausencia de datos). | Simulación de fallo de `fetch` en el navegador + lectura de `history.js` | Estado de error con «Reintentar» cuando la primera petición falla |
| 6 | Baja | P2 | **Las pantallas con sondeo (lobby, amigos, espectar, partidas online) seguían consultando con la pestaña oculta.** Medido: 20 peticiones a la API en 30 s en el lobby (≈ 30/min por pestaña) contra un límite de 120/min por cuenta; con 3-4 pestañas se acercaba al 429. | Medición en el navegador | Los temporizadores no consultan si `document.hidden` |

## 3. Qué se comprobó y cómo

### 3.1 Funcionalidad (Browser del escritorio, servidor local con datos reales sembrados)

- **15 pantallas** (inicio, lobby, rápida, academia, Circuit, diario, clasificación, progreso, amigos, espectar, historial, personalización, perfil, ajustes, online) abren y pintan contenido sin errores de JavaScript (hook de `error`, `unhandledrejection` y `console.error` activo). ✔ ejecutado.
- **Controles de pestañas y filtros**: 7 pestañas de progreso, 4 filtros de historial, 3 de clasificación, 10 categorías y 3 filtros de personalización, 4 modos y 6 controles de tiempo del lobby: pulsados sin errores; en progreso y personalización se verificó que cambia la pestaña activa y el contenido. ✔ ejecutado.
- **Recarga y enlaces**: `/u/ID`, `/r/ID`, `/r/ID?m=N` y `/r/<token>` abren directamente la pantalla correcta tras recargar. Un token de sesión caducado se sustituye por una cuenta nueva sin romper la app. ✔ ejecutado.
- **Estados de carga/error/vacío** con `fetch` forzado a fallar y a devolver 500 en 10 pantallas: ninguna queda en carga infinita ni lanza excepciones; según una búsqueda de texto (no una revisión visual), 6 muestran aviso de error y 4 (historial, perfil, progreso, amigos) conservan el último dato cargado sin aviso (corregido solo el caso de primera carga en historial; ver R5). ✔ ejecutado.
- **Datos ficticios**: búsqueda de `fake|mock|dummy|lorem|simulad` en el cliente: solo la partida de demostración decorativa del inicio (animación, no un dato). ✔ ejecutado.
- **Funciones antiguas**: suite completa (394 pruebas, 0 fallos) y `npm run smoke` contra un servidor local (13 comprobaciones ✔: estáticos, CSP, Stockfish wasm, cuentas, guardado, WebSocket, sala y jugada). ✔ ejecutado.

### 3.2 Integridad del ajedrez

Ya existían 23 pruebas de reglas y 5 de partida; se añadieron 6 de extremo a extremo por WebSocket (`test/integrity.test.js`):
- un tercero en una partida llena es espectador y no puede mover, rendirse, ofrecer ni aceptar tablas ni pedir revancha;
- jugada fuera de turno, ilegal o con pieza ajena: rechazada y el estado no cambia;
- la misma cuenta en dos pestañas enviando la misma jugada: se aplica una vez;
- desconexión y vuelta: recupera su asiento con las jugadas; un intruso no puede ocupar el asiento libre;
- rendirse 6 veces + 4 rondas de mensajes posteriores: **una sola partida guardada y el Elo no cambia después**;
- tras el mate la sala no admite jugadas ni cambia el resultado.

Con las ya existentes (reloj del servidor, bandera, desconexión de 45 s, tablas, abandono, resultado duplicado en torneos, cuadro y avance solo por el servidor) el servidor es la autoridad sobre jugadas, tiempo, resultado y avance. ✔ ejecutado.

### 3.3 Seguridad (`test/security.test.js`, `test/proxy.test.js`)

- 12 rutas con `%` mal formado, bytes nulos, `..%2f`, `%2e%2e`, `..%5c`: 4xx y servidor vivo; archivos fuera de `public/` y ocultos (`/server`, `/package.json`, `/data/*.db`, `/.env`, `/.git`): 403/404. ✔
- 19 rutas con 8 cuerpos hostiles (`null`, array, número, booleano, cadena, `__proto__`/`constructor`, anidado ×200, vacío): nunca 5xx. Cuerpos de 200 KB: 413. ✔
- Autenticación: sin token, vacío, `Basic`, `bearer` en minúscula, 5 KB, recovery como token, token en mayúsculas: 401. ✔
- Exposición de datos: `/api/me`, perfiles, clasificación, circuito, stats, live y partidas públicas sin `hash|recovery|token|email|last_seen`. ✔
- Autorización: partida ajena (404, ni siquiera confirma que existe), crear enlace de repetición de otra persona, cancelar un evento ajeno, responder a una solicitud inexistente, reportarse a uno mismo. ✔
- Manipulación: claves peligrosas al equipar (`__proto__`, `constructor`, arrays), guardado en la nube inflado (oros, nivel, set exclusivo del Circuit): recortado/ignorado. ✔
- **Duplicar recompensas con peticiones paralelas**: 20 reclamaciones simultáneas de revisión → 1 concesión; 20 envíos del desafío diario → 1 entrada y 1 concesión de XP; 10 compras simultáneas → 1 cobro; inscripción al mismo torneo desde 3 sockets → 1 inscripción. ✔
- WebSocket: sin identificarse nada funciona; 29 mensajes de tipos raros más un binario no rompen nada; >2 KB corta la conexión (1009); 500 mensajes seguidos → ≤ 45 respuestas. ✔
- Proxy: `clientIp` (con/sin confianza, saltos, valores absurdos) y los límites de `/api/recover`, sockets y cuentas de invitado ya no se esquivan cambiando la primera entrada. ✔
- XSS: un evento de comunidad con `"><img src=x onerror=…>`, `<script>` y comillas, insertado **saltándose** el saneado del servidor, se ve como texto en lobby, espectar y detalle del Circuit: sin elementos inyectados ni atributos `on*`. ✔ ejecutado en el navegador.
- Secretos en el cliente: búsqueda de cadenas de conexión, `ADMIN_TOKEN`, `DATABASE_URL`, `Bearer …`, tokens de 48 hex, `eval`/`new Function`/`document.write`: ninguno (prueba automática). `.env` y `data/*.db` están en `.gitignore`. ✔

### 3.4 Rendimiento (Browser, servidor local)

- Carga del inicio: 49 peticiones, 627 KB transferidos (585 KB de JS, de los cuales **418 KB son three.js**), 248 ms hasta `load`, 18 MB de heap.
- Memoria: 4 rondas × 11 pantallas (44 navegaciones): heap 16,4 → 14,9 → 14,6 → 14,9 MB y **1706 nodos DOM constantes**: sin fugas apreciables.
- Sondeo: el lobby hace ≈ 30 peticiones/min (6 endpoints cada 12 s). Corregido para pestañas ocultas (problema 6).
- Reconexión del WebSocket con retroceso exponencial (0,8 s → 15 s). Código leído, no forzado.
- Móvil (375 px): sin desbordes horizontales en Espectar y en el visor de repeticiones (medido en el PROMPT 07/08; no se repitió en todas las pantallas).

## 4. Pruebas ejecutadas y resultado

| Conjunto | Pruebas | Resultado |
|---|---|---|
| Suite completa existente + nueva (`npm test`) | 394 | **394 ✔, 0 ✖** |
| `test/security.test.js` | 49 | 49 ✔ |
| `test/proxy.test.js` | 8 | 8 ✔ |
| `test/integrity.test.js` | 6 | 6 ✔ |
| `test/client-static.test.js` | 6 | 6 ✔ (con mutación comprobada: detecta un import a un archivo inexistente, un `export` que falta y un `$('#id')` que no existe) |
| `npm run smoke` (servidor local) | 13 comprobaciones | todas ✔ |

**Pruebas que fallaron durante el trabajo (y por qué):**
- Con el **código anterior** (comprobado guardando los cuatro archivos de servidor modificados): fallan 3/3 pruebas de límites por proxy, 14/19 rutas de cuerpos hostiles y la de `/api/stats`; la de `%` mal formado deja el proceso muerto. Con el código nuevo pasan todas.
- Al escribir las pruebas fallaron 6 por **errores de las propias pruebas** (forma de datos supuesta, agotar el límite de 240 peticiones/min por IP compartiendo un servidor, jugadas insuficientes para el mínimo de 10). Se corrigieron las pruebas; ninguna aserción sobre el servidor se debilitó. Una aserción provisional con `|| true` se eliminó antes de ejecutar.
- La prueba de `/api/stats` era **vacía al principio** (el error de copia no llegaba a producirse con una base en memoria); se añadió una precondición que lo comprueba y se usó un archivo temporal.

## 5. Confirmación de funciones previas

La suite completa de las fases anteriores (reglas, partidas, torneos del Circuit, cartera, progresión, cosméticos, social, comunidad, repeticiones, persistencia) sigue en verde (394/394) y el smoke local pasa. Los cambios de cliente son mínimos (`history.js`, y condición de pestaña oculta en 4 temporizadores).

## 6. Riesgos pendientes

| # | Gravedad | Riesgo | Recomendación |
|---|---|---|---|
| R1 | **Alta (verificar al desplegar)** | La corrección del problema 2 supone **un proxy de confianza** delante del servidor. En Render no se ha podido comprobar cuántas entradas añade la cadena (balanceador y posible CDN). Si hubiera 2, todos los usuarios compartirían el cupo del proxy y los límites (240/min, cuentas nuevas) podrían saltar para gente legítima | Tras desplegar: 12 llamadas a `POST /api/recover` con `X-Forwarded-For` distintos desde una red deben dar 429 desde la 11.ª, **y desde otra red (móvil) la primera debe seguir dando 404**. Si la segunda da 429, sube `TRUSTED_PROXY_HOPS` |
| R2 | Media | Límite por IP de 240/min con ≈ 30 peticiones/min por lobby abierto: 8 jugadores tras la misma IP (aula, oficina) agotan el cupo | Agrupar las 6 consultas del lobby en un endpoint o enviarlas por WebSocket; subir el límite para IPs conocidas |
| R3 | Media | El tiempo del desafío diario lo declara el cliente (`seconds`, mínimo 2 s): la clasificación diaria se puede falsear. El mate sí se verifica y la XP se da una vez al día | Medir en el servidor desde la primera consulta autenticada del día |
| R4 | Media | Un invitado no tiene caducidad de token ni cierre de sesión remoto; perder el código de recuperación = perder la cuenta | Caducidad deslizante y «cerrar otras sesiones» |
| R5 | Baja | Con la API caída, historial (tras la primera carga), perfil, progreso y amigos conservan datos antiguos sin avisar | Marca «sin conexión» común |
| R6 | Baja | three.js (418 KB) se descarga al abrir el inicio; las respuestas JSON de la API no se comprimen (p. ej. `/api/progress` 9,8 KB) | Carga diferida del motor 3D; gzip en la API |
| R7 | Baja | Solo las rutas compartibles (`/u`, `/t`, `/r`, `/g`) sobreviven a una recarga; recargar en cualquier otra pantalla vuelve al inicio | Enrutado por hash (`#/progreso`) |

## 6 bis. No probado (no se afirma)

- **Producción (Render/Vercel/Neon):** no se atacó ni se hicieron pruebas destructivas contra el despliegue real; en concreto no se envió `GET /%E0%A4%A` a producción porque habría reiniciado el servicio. La vulnerabilidad se reprodujo localmente.
- **Conexión lenta real:** no hay estrangulado de red en el Browser; se simularon fallos y respuestas 500 sustituyendo `fetch`, pero no latencias altas ni pérdida de paquetes.
- **Dispositivos móviles reales** y navegadores distintos de Chromium; solo emulación de 375 px.
- **Pruebas de navegador automatizadas y repetibles:** no hay Playwright/Puppeteer en el proyecto. Las comprobaciones de navegador se hicieron a mano con el Browser del escritorio y no forman parte de `npm test`; lo repetible es `client-static.test.js` y las pruebas de servidor.
- **Carga/estrés** con muchos jugadores simultáneos y torneos de 16-64 plazas; el reinicio del servidor a mitad de un torneo solo está cubierto por las pruebas existentes.
- **Clic en todos los botones:** un rastreo automático genérico resultó poco fiable (excluyó las acciones con efecto y acabó abriendo el tutorial, que bloquea la navegación) y se descartó. Cubierto: navegación principal, pestañas, filtros, modos y selectores listados en 3.1. **No** se pulsaron las acciones con efecto (comprar, reclamar, bloquear, reiniciar progreso, etc.) en el navegador; su lógica está cubierta por las pruebas de servidor.
- **Nuevas rutas de la API de comunidad/repeticiones ante usuarios con sesión de otro navegador** (varias sesiones a la vez) más allá de las pruebas de sockets múltiples.
