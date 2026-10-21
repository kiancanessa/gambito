# Royale Circuit

Torneos eliminatorios de ajedrez, programados por un **organizador automático** y arbitrados por el servidor.
Este documento recoge el diseño del PROMPT 04, qué cambió respecto a la Fase 4 original y los criterios de aceptación con la prueba que cada uno tiene.

## De dónde se partía y qué cambia

| Antes (Fase 4) | Ahora |
|---|---|
| Un torneo «bajo demanda», solo de 8, que arrancaba 60 s después de la primera inscripción | Organizador automático: siempre hay un próximo torneo por formato (`CIRCUIT.formats`), alineado al reloj |
| Estados `registering`, `running`, `finished` | `scheduled → open → closed → running → finished` y `cancelled` |
| Se rellenaba con **bots** | **Sin bots**: si no hay jugadores presentes suficientes, el torneo se cancela |
| Todo en memoria: un reinicio perdía el torneo | Torneo, inscritos y cada partido de cada ronda en SQLite; `recover()` los reconstruye |
| Avance sin barrera transaccional | Cada cierre de partido es una transacción con compare-and-set |
| Pantalla de un solo torneo | Lista de torneos, detalle con cuadro, historial y campeones, en tiempo real |

## Estados

```
scheduled ──(hora de apertura)──▶ open ──(cierre o cupo lleno)──▶ closed ──(hora de inicio)──▶ running ──▶ finished
                                                                      └──(menos presentes que el mínimo)──▶ cancelled
```

- **Programado:** existe, aún no se admiten inscripciones.
- **Inscripción abierta:** se puede entrar y salir; plazo y cupo se comprueban en la base de datos con la hora del servidor.
- **Inscripción cerrada:** ya no se entra ni se sale. Si se llenó el cupo, empieza 30 s después en vez de esperar a la hora prevista.
- **En curso:** al empezar se ordena a los **presentes** (con socket conectado) por rating, se retira a los ausentes y se crea el cuadro entero.
- **Cancelado:** menos jugadores presentes que `minPlayers` (4 en Blitz de 8, 8 en Rápida de 16).

## Formatos y ampliación

`CIRCUIT.formats` define tamaño máximo, mínimo, control de tiempo y frecuencia. El cuadro (`bracket.js`) funciona para cualquier potencia de dos:
con menos inscritos que plazas, los mejores cabezas de serie reciben un **bye**. Para 32 o 64 jugadores basta añadir un formato
(`{ id, name, size: 32, minPlayers, tc, everyMs }`): no hay constantes de 8 en la lógica, los nombres de ronda y los puestos (`r32`, `r16`, `quarter`, `semi`, `final`) se calculan.

## Reglas

- **Una plaza por usuario y torneo** (clave primaria) y **un solo torneo vivo por usuario** (comprobado dentro de la transacción de inscripción).
- **Desempate:** una partida sin ganador (tablas o abortada) se repite con los colores cambiados; tras 3 sin decisión pasa el mejor cabeza de serie (mayor rating al inscribirse; a igualdad, quien se inscribió antes).
- **Incomparecencia:** quien no se sienta en su sala en 60 s pierde; si no aparece ninguno, pasa el mejor cabeza de serie.
- **Desconexión en partida:** la sala da 45 s de gracia y después da la victoria al rival.
- **Ausentes al empezar:** se retiran del cuadro (no cuentan para el mínimo).
- **Premios:** por puesto, cosméticos o monedas, nunca ventaja de juego; se cobran una sola vez por la cartera verificada.

## Integridad

- El cliente solo puede **pedir** inscribirse (`circuit_join`), salir (`circuit_leave`) o mirar (`circuit_watch`). No existe ningún mensaje para declarar resultados ni tocar el cuadro; los mensajes inventados no hacen nada.
- `circuit-store.js`: `completeMatch` hace, en `BEGIN IMMEDIATE`, (1) cerrar el partido solo si no estaba cerrado y los dos jugadores son los suyos, (2) eliminar al perdedor, (3) colocar al ganador en la plaza siguiente solo si estaba vacía. Si algo falla, se deshace todo.
- `finish` corona al campeón una sola vez y escribe el historial y los premios con `INSERT OR IGNORE`.
- Las partidas son salas normales: movimientos, turnos y reloj los valida el servidor (`rooms.js`).

## Reinicios del servidor

Todo cambio de estado se escribe antes de aplicarse en memoria. Al arrancar, `recover()` carga los torneos vivos:

- inscripciones y torneos programados siguen donde estaban;
- los partidos que estaban en juego (las salas viven en memoria) vuelven a «listo» y se **repiten desde cero**, con los mismos colores y empates acumulados; los ya cerrados no se tocan;
- durante `restartGraceMs` no se arranca ningún torneo cerrado, para que los jugadores puedan reconectar y no se cancele por «ausentes».

La base de datos se copia a Neon como siempre; `mergeSnapshot` incorpora las tablas del Circuit (gana la revisión más alta de cada torneo).

## Protocolo

| Dirección | Mensaje | Efecto |
|---|---|---|
| → servidor | `circuit_watch {id?}` / `circuit_unwatch` | suscripción a la lista (y al detalle de `id`) |
| → servidor | `circuit_join {id}` / `circuit_leave {id}` | inscripción / salida (validadas en la base de datos) |
| → servidor | `circuit_sync` | reasociar el socket a tus torneos (también se hace al identificarse) |
| ← cliente | `circuit_list {list}` | torneos vivos, historial y campeones |
| ← cliente | `circuit_state {circuit}` | detalle con cuadro, tu estado (`you`) y reglas |
| ← cliente | `circuit_match {code, label, opponent}` | tu partida está lista: el cliente entra solo |
| ← cliente | `circuit_error {reason, message}` | `closed`, `already`, `busy`, `full`, `unknown`, `notin`, `limit` |

API pública (solo lectura): `GET /api/circuit`, `GET /api/circuit/t/:id`, `GET /api/circuit/me` (premios del usuario).

## Criterios de aceptación y prueba

| Criterio | Prueba |
|---|---|
| El organizador programa siempre el siguiente torneo, sin inventar torneos ni participantes, y no se duplican | `circuit.test.js` · organizador y estados |
| Los 6 estados ocurren a su hora | `circuit.test.js` · «programado → … → cancelado» |
| Inscripción única, un torneo vivo por usuario, fuera de plazo y con cupo lleno se rechaza | `circuit-store.test.js` · inscripción; `circuit.test.js` · inscripciones |
| Cancelar la inscripción solo mientras está abierta | `circuit-store.test.js`, `circuit.test.js` |
| Cuadro de eliminación simple con byes y seeds para 2…64 jugadores | `bracket.test.js` |
| Ausentes retirados; cancelación si no se llega al mínimo | `circuit.test.js` · arranque, ausentes y byes |
| Un resultado duplicado no avanza dos veces al ganador | `circuit-store.test.js` · avance atómico; `circuit.test.js` · integridad |
| El cliente no puede declarar resultados ni mover el cuadro | `circuit.test.js` · «el cliente no puede…» |
| Empates: repetición con colores cambiados y desempate explícito | `circuit.test.js` · empates |
| Incomparecencias | `circuit.test.js` · incomparecencia |
| Cada ronda persistida; reinicio seguro | `circuit-store.test.js` · persistencia; `circuit.test.js` · recuperación tras un reinicio |
| Torneo completo con 8 jugadores reales, premios cobrables una sola vez, pantalla en tiempo real | `circuit.test.js` · partida completa |
| Historial de torneos y campeones | `circuit.test.js` (API `recent` y `champions`) |

## Límites conocidos

- Con pocos jugadores conectados, muchos torneos se cancelarán por falta de mínimo: es lo honesto sin bots. Se puede bajar `minPlayers` por formato.
- Las salas son efímeras: un reinicio repite desde cero la partida que estuviera en juego.
- Un único proceso lleva los torneos (Render Free); el compare-and-set protege frente a llamadas simultáneas dentro del proceso y frente a una instancia que se solape un instante durante un despliegue, no a dos servidores activos sobre bases distintas.
