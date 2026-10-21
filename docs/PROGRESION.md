# Progresión, misiones y temporadas

Sistema de progresión de CHECKPOINT (PROMPT 05). Objetivo: dar motivos para seguir jugando sin recompensas abusivas, y que **el servidor sea quien verifica y concede todo**.

## Qué existía y qué cambia

| Antes | Ahora |
|---|---|
| Misiones, XP de temporada y pase calculados en el navegador (`missions.js`, `season.js`) | Calculados y pagados en el servidor (`server/progression.js`); el cliente solo los muestra (`progress.js`) |
| El monedero aceptaba `season:1:30` sin comprobar XP | Rechazado (`moved`); el pase se reclama en `/api/progress/claim`, que recalcula el nivel con XP verificada |
| XP por partidas que decía el cliente (IA y online) | Online: la concede el servidor con la partida que arbitró. Práctica local: 60 XP por evento y 300 al día |
| Racha de entrada que se reinicia al faltar un día | Sin rachas que se pierdan: el contador solo suma, nunca se reinicia |
| Una sola temporada fija | Temporadas con id, fechas, tema, historial, clasificación propia y transición segura |

## Principios

1. **El nivel de cuenta es independiente del rating.** Sube con XP, no con Elo; perder terminando una partida también progresa.
2. **No toda la XP es por ganar.** Participar y terminar vale 40 XP; ganar es un extra de 10. Abandonar solo da 10.
3. **Solo cuenta lo que el servidor vio o puede comprobar:** partidas online que arbitró, desafío diario resuelto, torneos terminados y repeticiones de partidas propias. Las partidas contra la IA y la Academia no se pueden verificar, así que no dan misiones ni XP de temporada.
4. **Nada caduca por faltar.** Lo completado ayer se reclama hoy; las recompensas de una temporada se reclaman hasta 14 días después de que acabe; no hay penalizaciones.

## XP de una partida (`xp-rules.js`)

| Concepto | XP |
|---|---|
| Participar | 25 (10 si abandonas) |
| Terminar sin abandonar | +15 |
| Victoria / tablas | +10 / +6 |
| Clasificatoria | +8 |
| Jaque mate · jaques (hasta 3) · coronación | +10 · +3 c/u · +5 |
| Ganar a un rival con 100+ de rating más (clasificatoria) | +10 |
| **Máximo por partida** | **70** |

Una partida cuenta si no se abortó y tiene al menos 10 jugadas. Límites contra el granjeo: máximo **3 partidas por pareja de rivales y día**, y pasados **800 XP de partidas en un día** la XP baja al 25 % (se amortigua, no se bloquea). Otras fuentes: desafío diario +40, repasar una partida propia +15 (hasta 45 al día, una vez por partida), Royale Circuit según el puesto.

## Misiones

- Diarias (3) y semanales (3) sacadas de un conjunto, de forma determinista (las mismas para todos). Periodos en UTC: el día y la semana (lunes).
- Estados: **pendiente → en progreso → completada → reclamada**. El progreso se recalcula en el servidor con los eventos verificados del periodo.
- Ejemplos: completar 3 partidas, terminar una sin abandonar, participar en un Royale Circuit, completar el desafío táctico, revisar una partida en la repetición, ganar sin perder la dama / con negras / a un rival mejor.
- Reclamar: `POST /api/progress/claim { kind: 'mission', slot, id, period }`. Una restricción de clave primaria (`mission_claims`) y el libro de cuentas impiden cobrar dos veces, incluso con peticiones simultáneas. Solo se reclaman el periodo actual y el anterior.

## Temporadas

- `SEASONS` (`progression-data.js`): id, nombre, fechas, tema visual (color, glifo, frase), niveles, XP por nivel y recompensas **gratuitas** (monedas y cosméticos que ya existen en la tienda, nunca ventajas de juego). Hoy: T1 (hasta 30-nov-2026), T2 (1-dic-2026 → 28-feb-2027) y T3 (1-mar → 31-may-2027). Sin huecos ni solapes (comprobado en test).
- **XP de temporada** = XP verificada con `season_id` de la fecha del evento. Una temporada nueva empieza de cero y la anterior queda intacta.
- **Clasificación:** `season_stats` guarda un rating propio de cada temporada que arranca a medio camino de 1000 y suma los cambios Elo de las partidas clasificatorias. Aparecen quienes tienen al menos 3. Al acabar la temporada la tabla se congela sola (las filas llevan el id de temporada).
- **Transición segura:** el instante exacto del cambio asigna el evento a la nueva; los premios de la anterior se pueden reclamar 14 días más; fuera de toda temporada la XP de cuenta sigue contando. Lo reclamado con el sistema anterior (`ledger` con `season:<id>:<nivel>`) cuenta como reclamado.
- Si ya posees el objeto de una recompensa, se compensa con 60 monedas.

## Logros y desbloqueos

- 24 logros por hitos (partidas, victorias, mates, clasificatorias, Circuit, desafíos, repeticiones, misiones, nivel, pase). Las estadísticas salen de `games`, `daily_results` y `tournament_results`, así que **se recuperan los hitos del historial anterior** sin migrar nada. Se desbloquean y pagan una sola vez.
- Recompensas visuales por nivel de cuenta: marcos de avatar y títulos (solo estéticos). Se desbloquean solos; la elección se guarda en el guardado local.
- Historial de progresión: los últimos 30 movimientos de XP con su origen.

## Integridad (resumen)

| Amenaza | Defensa |
|---|---|
| Recargar la página / repetir peticiones | Cada concesión tiene una clave `ref` única por jugador (`progress_events` + libro de cuentas) |
| Partidas artificiales | Solo cuentan partidas de salas del servidor, con ≥10 jugadas, no abortadas; tope por pareja y día y tope diario |
| Eventos manipulados | El cliente no envía eventos de XP: solo pide ver, reclamar o registrar una revisión (validada: partida propia, terminada, una vez) |
| Reclamar sin cumplir / dos veces / mal periodo | Recalculo en la misma transacción (`BEGIN IMMEDIATE`), claves primarias, caducidad de periodos |
| Nivel de pase falsificado | Se calcula con XP verificada; el antiguo cobro por monedero ya no existe |
| Castigo por faltar | No hay: sin rachas que se pierdan, sin caducidad de lo acumulado |

## API

`GET /api/progress` (resumen completo) · `POST /api/progress/claim` · `POST /api/progress/review` · `GET /api/season/leaderboard?season=N` (pública). Por WebSocket el servidor envía `{ t: 'progress', xp, level, leveledUp, unlocked, achievement }` a cada jugador cuando gana XP.

## Criterios de aceptación y prueba

Todo en `test/progression.test.js` (41 pruebas): reglas de XP, idempotencia, partidas cortas/abortadas/abandono, tope por pareja y día, tope diario, misiones (estados, doble reclamo, periodos, falsificación), temporadas (nivel, reclamo, legado, objeto repetido, transición, hueco, clasificación), logros retroactivos, repeticiones, torneo, desbloqueos, ausencia de rachas, API (sesión, cuerpos falsificados, recarga, partida online real con aviso por WebSocket) y fusión de copias de la base de datos.

## Límites conocidos

- Las partidas contra la IA no dan progresión verificable (el servidor no las ve): es una decisión de integridad.
- Una cuenta puede farmear partidas con otra propia hasta los topes (3 por pareja y día; 70 XP por partida; 800 XP al día). Los logros usan el recuento de partidas del historial.
- La XP de temporada y las misiones de la temporada anterior al estreno de este sistema no se pueden reconstruir (eran locales): solo se conservan las recompensas ya reclamadas.
