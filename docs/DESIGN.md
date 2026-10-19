# Sistema de diseño CHECKPOINT

CHECKPOINT es el nombre provisional de la marca (antes «Gambito»; el repositorio y las claves de `localStorage` conservan el nombre antiguo
para no romper cuentas ni guardados). La interfaz es oscura, técnica y sobria: **el tablero es el protagonista** y nada decorativo compite con él.

## Dónde vive

- `public/css/style.css`: estilos heredados de cada pantalla.
- `public/css/checkpoint.css`: **se carga después** y manda. Redefine los tokens antiguos (`--bg`, `--panel`, `--gold`…) para que todo lo heredado adopte la
  paleta nueva, y reestiliza los componentes comunes. Un cambio de tema se hace aquí.
- `public/js/shell.js`: navegación principal (barra superior en escritorio, barra inferior en móvil), flags y tarjeta de cuenta del inicio.

## Tokens (`:root` en `checkpoint.css`)

| Grupo | Tokens | Uso |
|---|---|---|
| Superficies | `--cp-void` `--cp-obsidian` `--cp-graphite` `-2` `-3` | Fondo, tarjetas, controles. Cuanto más claro, más elevado |
| Líneas | `--cp-line`, `--cp-line-2` | Bordes de 1 px (reposo / realzado) |
| Texto | `--cp-text`, `--cp-muted`, `--cp-dim` | Principal, secundario, desactivado |
| Acción | `--cp-cyan` (+ `--cp-cyan-ink` para el texto encima) | **Una sola acción primaria por vista**, foco, selección, progreso |
| Progreso | `--cp-violet` | Barras de progreso (violeta → cian), Royale Circuit |
| Estado | `--cp-good`, `--cp-bad`, `--cp-warn` | Éxito, error/en vivo, aviso |
| Moneda | `--cp-coin` | **Solo** para oros y estrellas; el resto del color es cian/violeta |
| Forma | `--cp-r-sm` 8, `--cp-r` 12, `--cp-r-lg` 16 | Radios |
| Espacio | `--cp-s1…s6` (4, 8, 12, 16, 24, 32 px) | Separaciones |
| Movimiento | `--cp-fast` 140 ms, `--cp-ease` | Transiciones cortas; sin bucles que distraigan |

Tipografía: pila de sistema, sin descargas (CSP y rendimiento). Títulos y cifras en `--font-title` (**Bahnschrift** en Windows, con respaldos), en
mayúsculas y con tracking; texto en `--font`. Si algún día se autoalojan fuentes (OFL), basta cambiar esas dos variables.

## Componentes

- **`.play-now`**: el botón principal (PLAY NOW). Cian sólido, banda diagonal y flecha. En el lobby (`.lb-cta`) cambia de acción según el modo elegido.
- **`.btn`** (`.primary`, `.danger`, `.buy`), **`.seg`** (segmentos), **`.switch`** (interruptor accesible con `role="switch"`).
- **`.lb-card`**: tarjeta estándar (grafito con borde y brillo superior). **`.eyebrow`**: cabecera de sección con marca cian.
- **`.emblem`**: emblema hexagonal de liga con el color de la liga (`.sm`, `.big`).
- **`.pill`** (`ok`, `todo`, `soon`, `live`, `bad`): estados cortos. **`.tile`**: acceso del inicio. **`.ev-list`**: torneos y eventos.
- **Navegación**: `.main-nav` + `.nav-link` (≥ 900 px) y `.tabbar` + `.tab` (< 900 px). `data-nav` define la sección iluminada;
  `data-flag="x"` oculta el elemento si el flag `x` está apagado; `data-play` apunta a `lobby` u `online` según el flag `lobby`.
- **Iconos**: sprite SVG al inicio de `index.html` (`<use href="#i-nombre">`); trazo de 1,8 px heredando `currentColor`.

## Reglas

1. Una acción primaria por vista; el resto, `.btn` neutro.
2. Cian = acción/selección, violeta = progreso, ámbar = solo moneda. Nada de neón ni degradados que resten legibilidad.
3. Cero botones sin función: cada `data-go` apunta a una pantalla real (lo comprueba `test/ui.test.js`).
4. Móvil primero: sin desbordes horizontales, objetivos táctiles ≥ 40 px, barra inferior con zona segura (`env(safe-area-inset-bottom)`).
5. Respeta «Reducir movimiento» (Ajustes) y `prefers-reduced-motion`.

## Pantallas

Inicio · Lobby (`Jugar`) · Royale Circuit · Partida · Clasificaciones · Perfil · Misiones y recompensas (Misiones / Temporada / Personalizar) ·
Historial y repeticiones · Amigos · Ajustes y personalización · y los modos Campaña, Online, Desafío diario y Contra la IA.
