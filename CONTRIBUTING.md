# Contribuir a Gambito

¡Gracias por querer ayudar! Gambito es un proyecto abierto (GPL-3.0) y cualquier mejora suma.

## Preparar el entorno

```bash
npm install
npm start      # http://localhost:5173
npm test       # debe pasar antes de abrir un PR
```

Necesitas Node.js 24+. No hay paso de build: el cliente es JavaScript modular servido tal cual desde `public/`.

## Cómo proponer cambios

1. Abre un *issue* para cambios grandes (nuevos modos, cambios de reglas del juego o de economía).
2. Crea una rama, haz commits pequeños y claros y abre un *pull request*.
3. Añade o actualiza pruebas en `test/` si tocas el servidor (`server/`).
4. Si cambias algo visual, adjunta una captura o un GIF.

## Criterios de diseño (por favor, respétalos)

- **Nunca pagar por ganar.** Todo lo comprable es cosmético o narrativo.
- **Ajedrez real como base.** Los modos "locos" son eventos opcionales; las reglas clásicas no se tocan.
- **El servidor es la autoridad** en lo competitivo: jugadas, relojes, resultados y ranking se validan en `server/`.
- **Sin chat libre.** Se comunica con emotes y frases rápidas para evitar toxicidad.
- **Accesible y rápido.** Móvil primero, sin dependencias pesadas, usable con teclado.
- Todo texto del jugador que venga del servidor se escapa (`esc()` en `public/js/ui.js`) antes de pintarlo.

## Estilo de código

- JavaScript moderno (ES modules), sin transpilar. Comentarios en español y que expliquen el *porqué*.
- Mantén los módulos pequeños y con una sola responsabilidad (mira `docs/ARCHITECTURE.md`).

## Ideas para empezar

Busca `good first issue` o elige de la hoja de ruta del README: nuevas skins (materiales en `public/js/board3d.js`
+ entradas en `public/js/data.js`), nuevos puzzles, traducciones, accesibilidad, drag & drop de piezas...

## Código de conducta

Sé amable y constructivo. No se tolera el acoso ni la discriminación.
