# Cosméticos y colección personal

Sistema de personalización de CHECKPOINT (PROMPT 06): cada jugador construye su identidad visual con una colección pequeña y ampliable. **Todo es estético**: nada cambia reglas, tamaño de objetivos ni información visible. El inventario lo decide el servidor.

## Qué había y qué cambia

| Antes | Ahora |
|---|---|
| Tienda con 3 tipos (piezas, tableros, efectos de captura), todo comprable con oros | Catálogo único de **10 categorías** y ~90 artículos (`cosmetics-data.js`) con 7 métodos de desbloqueo |
| Marcos y títulos locales por nivel (`state.flair`) en la página de progresión | Inventario y equipamiento en la cartera del servidor; la página de progresión enlaza con la personalización |
| Efecto de victoria fijo (confeti) y coronación única | Efectos de victoria y animaciones de coronación equipables |
| Sin avatar propio (solo el emblema de liga) | Avatar, marco, insignia, título y decoración del perfil, visibles en la barra superior, el perfil y la progresión |

## Catálogo

Categorías: **avatares, marcos, tableros, piezas, efectos de captura, efectos de victoria, animaciones de coronación, insignias, títulos y decoración del perfil.**

Cada artículo (`ITEMS`) tiene: `id` único por categoría, `name`, `desc`, `category`, `asset` (recurso visual o referencia a uno existente), `rarity` (solo estética), `unlock` (método) y `status` (`active` / `soon`). Ampliar el catálogo es añadir un objeto; los tests comprueban que cada artículo visual tiene su recurso (material 3D, clase CSS, partículas, ilustración o animación).

| `unlock.type` | Quién lo concede | Ejemplo |
|---|---|---|
| `default` | todos | Peón, Sin marco, Confeti |
| `level` | el servidor al alcanzar el nivel de cuenta | Caballo (3), Marco Cian (5), Fuegos artificiales (8) |
| `achievement` | el servidor al conseguir un logro | Cometa (primera victoria), Nova (campeón del Circuit) |
| `season` | recompensa gratuita del pase (se reclama allí) | Marco Dosel (T2, nivel 22), Avatar Loto (T3, nivel 20) |
| `circuit` | premio del Royale Circuit | Corona del Circuito |
| `purchase` | compra con **oros** (moneda blanda que se gana jugando) a precio fijado en el servidor | Tableros y piezas de siempre |
| `future` | aún nadie (`status: 'soon'`) | Nébula, Marco Eclipse |

**Compras:** el único flujo de compra es el de oros que ya existía, validado en el servidor. **No hay pagos reales**: `future` deja la estructura preparada para una futura tienda, que no se implementará hasta que exista un catálogo validado y un flujo seguro.

## Servidor

- **Inventario** = `wallet.owned` (claves `categoría:id`) y **equipamiento** = `wallet.equipped` (una pieza por categoría). Las cuentas anteriores se completan con lo predeterminado al leerlas (sin duplicados).
- `server/cosmetics.js`: `sync` concede, de forma idempotente (libro de cuentas `cosm:<clave>`), los artículos por nivel o logro; se ejecuta al abrir la personalización y tras cada concesión de XP o logro (gancho `after` de la progresión). `equip` valida categoría, existencia, disponibilidad y propiedad.
- Rutas: `GET /api/cosmetics` (inventario real + nivel + logros) y `POST /api/cosmetics/equip` (`403` si no lo tienes, `400` si no existe). Por WebSocket llega `{ t: 'cosmetics', unlocked }` cuando se desbloquea algo.
- **El cliente no puede otorgarse artículos:** `buy` rechaza (`exclusive`) lo que no se vende, el guardado importado solo admite artículos comprables, `earn` no tiene una fuente de cosméticos y `equip` exige poseer el artículo (probado con peticiones falsificadas).

## Cliente

- `customize.js` (cargado con `import()` solo al abrir la sección): categorías con contador, filtros **Todos / Desbloqueados / Bloqueados**, tarjetas con indicador del método de desbloqueo, **vista previa** (identidad completa + recurso grande, y pruebas de efectos de captura, victoria y coronación), botón **Equipar / Comprar**, confirmación visual (tarjeta destacada, aviso y mensaje para lectores de pantalla), esqueleto de carga y estado de error con reintento.
- **Carga diferida:** las miniaturas 3D de piezas y tableros solo se generan cuando la tarjeta entra en pantalla (`IntersectionObserver`).
- `cosmetics-art.js`: avatares (glifos y 5 ilustraciones SVG), marcos (CSS), insignias, títulos y decoración. Sin imágenes externas.
- Efectos: `fx.js` (`victoryFx`: confeti, fuegos artificiales, lluvia de laurel, aurora y nova; respeta «animaciones: desactivadas») y `board3d.js` (`crownAnimation`: clásica, ascenso, halo y polvo de estrellas; solo anima la pieza que aparece).
- Piezas nuevas (Mármol y Pizarra, Cobalto y Plata) y tablero Pizarra: solo materiales y color, con su equivalente 2D.

## Derechos

Arte original: formas, degradados, símbolos genéricos y glifos de ajedrez Unicode. No hay personajes, logotipos ni nombres de otros juegos (comprobado en test).

## Criterios de aceptación y prueba (`test/cosmetics.test.js`, 18 pruebas)

Catálogo completo y coherente · una pieza por defecto por categoría · métodos de desbloqueo que apuntan a logros, temporadas, niveles y precios reales · recurso visual existente para cada artículo · cosméticos puramente estéticos · sin marcas de terceros · cuenta nueva solo con lo predeterminado · equipar valida propiedad y datos raros · desbloqueo por nivel y por logro (también del historial) sin duplicados y con aviso · premios de temporada y circuito una sola vez · rutas con sesión · compras fijadas por el servidor, sin duplicados · importación de guardado, cartera y equipar por operación no otorgan nada.

## Límites

- Los avatares y marcos de otros jugadores todavía no se muestran (no hay perfiles públicos); se ven en tu barra, tu perfil y tu progresión.
- La animación de coronación solo existe en el tablero 3D (el tablero 2D de reserva no anima la coronación).
