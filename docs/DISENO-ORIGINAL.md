# GAMBITO: Crónicas del Tablero — Documento de diseño (GDD v0.1)

## Contexto
Quieres un juego web de ajedrez tan adictivo y "cultural" como Fortnite: historia, cosméticos, eventos y ganas de volver cada día. Decisiones tomadas:
- **Gancho principal:** campaña con historia (mundo + personajes).
- **Reglas:** ajedrez clásico como base + modos locos opcionales por eventos.
- **Alcance ahora:** solo diseño (sin código todavía). El plan de construcción queda como fase siguiente.

Nombre de trabajo: **Gambito: Crónicas del Tablero** (cambiable).

---

## 1. La idea en una frase
Un roguelike narrativo donde el ajedrez es el "combate": recorres un reino en guerra, cada pieza es un personaje con historia, y cada partida (real, con reglas reales) decide el destino de una ciudad.

**Por qué engancha:** ajedrez real (aprendes de verdad) + progreso constante + historia que quieres ver continuar + cosméticos que enseñas a tus amigos.

---

## 2. Historia y mundo
**Premisa:** El Reino de Escaquia fue partido en 64 casillas por una magia antigua, "La Gran Partida". El Rey Blanco desapareció y la Reina Negra gobierna con puño de hierro. Eres un **Peón sin nombre** que despierta en el borde del tablero y descubre que los peones pueden **coronarse** (promocionar) y cambiar el destino del reino.

**Estructura narrativa:**
- **5 Reinos (capítulos)** con estética propia: Valle de Peones (tutorial), Bosque de Alfiles (diagonales), Fortaleza de Torres (columnas/filas), Llanuras de Caballeros (saltos), Corte de la Reina (final).
- **Jefes = grandes maestros ficticios** inspirados en estilos reales (el Atacante agresivo, el Muro defensivo, el Tramposo de gambitos…). Cada jefe enseña un concepto de ajedrez real.
- **Piezas con personalidad:** tu Caballo sarcástico, tu Torre gruñona, tu Alfil filósofo. Comentan tus jugadas (aciertos, errores, jaques).
- **Giro final:** el Rey Blanco eres tú en una partida anterior (narrativa de "bucle" que justifica el roguelike).

**Mecánica de historia:** cada capítulo = mapa de nodos (estilo Slay the Spire): partida normal, puzzle, evento con elección, tienda, jefe. Las elecciones cambian aliados y recompensas.

---

## 3. Bucle de juego (el "loop" adictivo)
1. **Partida corta (3–10 min):** vs. IA con personalidad y nivel escalable, o rápida en línea más adelante.
2. **Recompensa inmediata:** monedas + XP + "cofre" según estilo (jaque, captura limpia, remontada, mate en X).
3. **Progreso visible:** barra de capítulo, nivel de jugador, colección.
4. **Gancho de regreso:** misión diaria, racha, evento de temporada, jefe semanal.
5. **Gasto:** tienda de cosméticos y desbloqueo de aliados.

Principio de diseño: **nunca pagar por ganar**. Todo lo comprable es estético o narrativo; la fuerza de la IA o del rival no depende de lo que tengas.

---

## 4. Modos de juego
| Modo | Descripción |
|---|---|
| **Campaña** | Historia + mapa de nodos + jefes. Corazón del juego. |
| **Rápida vs IA** | Partida clásica con nivel elegido; ideal para sesiones cortas. |
| **Puzzles del Reino** | Tácticas cortas ("mate en 2") integradas como obstáculos del mapa. |
| **Modo Evento (locos)** | Reglas alteradas por tiempo limitado: Niebla de Guerra (solo ves tus casillas vecinas), Tablero Móvil (casillas que giran), Peones Explosivos, Ajedrez 960, Bullet 1 min, Rey de la Colina. Un nuevo evento cada 1–2 semanas. |
| **Desafío diario** | Una posición del día igual para todos con ranking de tiempo/movimientos. |
| **Torneos Battle (futuro)** | Eliminatoria de 32/64 jugadores en vivo, estilo "último en pie". |
| **Amigo/Duelo (futuro)** | Retar por enlace compartible. |

---

## 5. Economía y cosméticos ("skins")
**Monedas:**
- **Oros** (blandas): se ganan jugando. Compran la mayoría de cosas.
- **Gemas** (premium, opcional/futuro): atajos cosméticos y packs de temporada. Mantener justo, no pay-to-win.

**Qué se personaliza:**
- **Sets de piezas:** Clásico, Samurái, Cyberpunk, Piratas, Dragones, Dulces, Pixel-art, Mármol vs Obsidiana.
- **Tableros:** Madera, Neón, Espacio, Lava/Hielo, Jardín japonés. Algunos animados.
- **Efectos de captura/jaque/mate:** explosión de partículas, relámpago, cenizas, confeti.
- **Emotes y frases de piezas**, marcos de perfil, títulos ("Verdugo de Alfiles").
- **Coronación:** animación especial al promocionar un peón (momento "wow").
- **Rareza** (común → legendario) con colores y brillo, como en Fortnite.

**Pase de Temporada (Battle Pass):** 40–60 niveles, pista gratuita + pista premium, temas narrativos ("Temporada 1: La Noche de las Torres"). Misiones semanales rellenan la barra.

**Tienda diaria rotativa:** 4–6 artículos que cambian cada 24 h (sensación de "escasez" saludable).

---

## 6. Elementos de retención (lo que engancha)
- **Racha diaria** con recompensas crecientes y "perdón" (un día de gracia).
- **Misiones diarias y semanales** ("Da jaque con un alfil", "Gana sin perder una pieza").
- **Logros** con insignias coleccionables (Mate del pastor, Mate del loco, Enroque tardío, Remontada épica).
- **Rangos y ligas** por temporada (Peón → Gran Maestro) con reinicio suave.
- **Repetición de la mejor jugada:** al terminar, un clip animado del momento más espectacular listo para compartir.
- **Análisis amable:** un "Sabio" resume 3 momentos clave (no un muro de números) y propone un mini-puzzle de tu error.
- **Coleccionismo:** álbum de piezas/personajes con progreso al 100%.
- **Eventos en vivo y temporadas** con historia que avanza en el calendario.

---

## 7. Cómo enseñar ajedrez sin aburrir
- **Tutorial dentro de la historia:** cada reino desbloquea una pieza y su movimiento.
- **IA que se adapta** (dificultad dinámica): pierde a propósito si estás frustrado, aprieta si ganas mucho. Mantiene la sensación de "casi gano".
- **Pistas opcionales** que cuestan una moneda blanda.
- **Feedback inmediato y positivo** (sonidos, partículas, voces de piezas) en vez de "has cometido un error".
- **Modos de tablero reducido** (5x5, 6x6) como "mini-aventuras" para principiantes.

---

## 8. Estilo visual y sonoro
- **Dirección artística:** fantasía estilizada (low-poly o 2D pintado), colores saturados, personajes expresivos. Distinto de lo "serio y aburrido" de los sitios de ajedrez actuales.
- **Juice:** animaciones de piezas con peso, cámara que se acerca en capturas, vibración visual en jaque, música dinámica que sube de intensidad hacia el mate.
- **UI:** móvil primero (vertical), botones grandes, pocas pantallas hasta jugar.

---

## 9. Qué lo diferencia
| Sitios actuales (chess.com/lichess) | Gambito |
|---|---|
| Foco competitivo, árido para novatos | Foco en aventura, el ajedrez es el "combate" |
| Cosméticos secundarios | Cosméticos centrales + pase de temporada |
| Sin historia | Campaña con personajes y giros |
| Mismo juego siempre | Eventos y modos que cambian cada semana |
| Progreso = solo Elo | Progreso = reino, colección, historia, ranking |

---

## 10. Hoja de ruta propuesta (cuando pases a construir)
1. **Prototipo jugable (MVP):** tablero web, reglas completas (usar librería `chess.js`), IA con `Stockfish.js` en niveles, animaciones básicas.
2. **Vertical slice:** Reino 1 completo (mapa de nodos + jefe + historia + 3 sets de piezas + 2 tableros + monedas y tienda local).
3. **Meta-progresión:** misiones diarias, rachas, logros, guardado en navegador.
4. **Cuentas y nube:** login, guardado remoto, ranking diario (backend ligero).
5. **Multijugador:** amigos por enlace, luego matchmaking y torneos.
6. **Live-ops:** eventos semanales, pase de temporada, tienda rotativa.

Piezas técnicas recomendadas (a validar cuando toque): HTML/CSS/JS o un motor web (Phaser/PixiJS) para animación, `chess.js` para reglas, `Stockfish.js` (WASM) para IA.

---

## 11. Riesgos y cómo mitigarlos
- **Alcance enorme:** empezar con un solo reino y pocos cosméticos; validar diversión antes de crecer.
- **Que no sea "ajedrez de verdad":** mantener las reglas clásicas como base y aislar los modos locos en eventos.
- **Frustración del novato:** dificultad adaptable + pistas + modos pequeños.
- **Percepción pay-to-win:** compras solo estéticas, declarado públicamente.

## 12. Siguientes decisiones abiertas
- Nombre definitivo y tono (épico, cómico, oscuro).
- Estilo artístico final (2D pintado vs 3D low-poly).
- Idioma(s) y público objetivo principal (niños, jóvenes, adultos casuales).
- Cuándo introducir multijugador.

## Verificación (de este entregable)
Al ser un documento de diseño, la verificación es tu revisión: confirmar que la premisa, los modos, la economía y la hoja de ruta reflejan lo que imaginas. Si quieres, el siguiente paso es convertir esto en un documento compartible o empezar el prototipo jugable de la Fase 1.
