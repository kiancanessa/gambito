# Comunidad: amigos, perfiles, espectadores y eventos (PROMPT 07)

Capa social de CHECKPOINT. Principio rector: **el servidor decide y el cliente solo muestra**. Nada de lo que se ve de otra persona
(perfil, presencia, partidas) llega al navegador sin pasar por sus ajustes de privacidad, y nunca se expone email, hash, token ni última conexión.

## 1. Auditoría previa

Ya existía (Fase 5): código de amigo, solicitudes, lista, presencia, invitaciones, bloqueos y reportes (`server/social.js`), espectadores en
`server/rooms.js` y repeticiones propias. Faltaba: buscar jugadores, perfiles públicos, privacidad configurable, historial entre dos personas,
protección frente a spam de invitaciones, moderación, retransmisión retrasada para competición, partidas públicas y eventos de creadores.

## 2. Modelo de privacidad

Tabla `user_privacy` (valores por defecto entre paréntesis):

| Ajuste | Valores |
|---|---|
| `profile` | `public` (por defecto) · `friends` · `private` |
| `searchable` | sí (por defecto) / no: si no, solo te encuentran con tu código |
| `show_online` | sí / no: la presencia solo la ven amigos aunque esté activa |
| `accept_requests` | sí / no |
| `accept_invites` | `friends` (por defecto) · `nobody` |

- `GET/PATCH /api/me/privacy` valida cada clave y rechaza las desconocidas con 400.
- `GET /api/users/:id` devuelve un perfil recortado al nivel permitido. Un bloqueo en cualquiera de los dos sentidos responde 404.
- La búsqueda (`GET /api/users/search?q=`, mínimo 2 letras, máximo 10 resultados, caracteres `%`/`_` escapados) excluye a uno mismo, bloqueados
  en ambos sentidos, cuentas no buscables y cuentas restringidas.
- Perfiles de cuentas privadas o restringidas no aparecen en partidas públicas ni en listados.

## 3. Moderación

- Los reportes se guardan con motivo de una lista (abuso, trampas, nombre, otro). Con **3 personas distintas en 7 días** la cuenta pasa a
  estado `review`. **No hay sanciones automáticas.**
- El estado `restricted` (oculta de búsqueda y perfil limitado, no puede enviar solicitudes) solo lo pone una persona administradora.
- Las rutas `/api/admin/reports` y `/api/admin/moderate` **solo existen si se define `ADMIN_TOKEN`** y se comparan en tiempo constante
  (`Authorization: Bearer …`). CLI: `npm run moderate` (`scripts/moderate.js`), por ejemplo `ADMIN_TOKEN=… npm run moderate -- https://tu-servidor list`
(también `restrict <id> [nota]`, `review <id>` y `clear <id>`).

## 4. Invitaciones y anti-spam

`server/ws.js`: una invitación por pareja origen→destino cada 30 s, máximo 5 invitaciones por minuto a una misma persona, y rechazo directo si
el destino tiene `accept_invites: 'nobody'`. Solicitudes de amistad: 30 acciones/min por usuario y límites de Fase 5.

## 5. Espectadores y retraso configurable

- Solo lectura: el servidor ignora cualquier jugada, rendición, oferta o chat de un espectador (probado).
- Cada sala tiene `specDelay`. Los espectadores reciben instantáneas de la partida **con ese retraso**; los jugadores no.
  Por defecto: **Circuit 20 s**, clasificatoria 0, partidas con amigos 0.
  Variables: `SPECTATOR_DELAY_CIRCUIT_MS`, `SPECTATOR_DELAY_RANKED_MS`.
- **Evaluación:** el retraso protege la competición contra ayuda externa en directo (motor, coach en la sala) con un coste bajo: las instantáneas
  se clonan y se encolan por sala, sin infraestructura extra. En clasificatoria lo dejamos en 0 porque el rating pesa poco y la inmediatez
  mejora la experiencia; se puede subir sin tocar código. El resultado final también se retransmite con retraso.
- Las partidas de torneo aparecen en `/api/live` con `kind: 'circuit'`, torneo y ronda. La partida de un perfil privado no aparece.

## 6. Partidas públicas y repeticiones

Tabla `public_games`, rellenada al guardar partidas clasificatorias y de Circuit. La privacidad se comprueba **al leer**, de modo que cambiar un
ajuste oculta también lo ya guardado. `GET /api/public/games` y `/api/public/games/:id` no exigen sesión; la repetición pública no permite reportar
como en las propias.

## 7. Eventos de comunidad

Torneos eliminatorios creados por jugadores, sobre el mismo motor que el Circuit (`scheduleCommunity`), pero **sin premios, XP, historial de
leyenda ni logros** (evita granjas de recompensas con cuentas amigas). Reglas en `server/community.js`:

- Nivel de cuenta mínimo 3; máximo 2 eventos activos por organizador y 3 al día.
- 4, 8 o 16 jugadores; controles `blitz3_2`, `blitz5`, `rapid10`.
- Empiezan entre 10 minutos y 14 días desde la creación; el título y la descripción no admiten enlaces.
- El organizador puede cancelar antes de que empiece (`POST /api/events/:tid/cancel`); `GET /api/events/rules` publica las reglas.
- Cuadro, resultados y campeón se ven en la misma pantalla del Circuit, con insignia «Comunidad» y organizador.

## 8. Enlaces compartibles

El servidor estático sirve la app para `/u/ID` (perfil), `/t/ID` (torneo), `/r/ID` (repetición pública) y `/g/CODE` (sala). El cliente los abre
al arrancar y respeta la privacidad: un perfil privado muestra «reservado», no los datos.

## 9. Límites y riesgos conocidos

- Presencia basada en sockets abiertos de **una instancia**; con varias réplicas haría falta un bus (Redis).
- Los eventos de comunidad dependen de que haya suficientes inscritos; si no se llega al mínimo se cancelan como los del Circuit.
- Sin chat, voz ni streaming propio, por diseño. La moderación es manual: `restricted` y los avisos de `review` los gestiona una persona.
- El retraso del Circuit se calibró sin pruebas con competidores reales; conviene revisarlo tras los primeros torneos.
