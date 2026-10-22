// Antes: escena 3D compartida (inicio ↔ partida) y miniaturas 3D de la tienda. Desde el rediseño minimalista el tablero
// competitivo es 2D y el inicio es un centro de highlights, así que aquí no se carga three.js. Se mantiene la misma API
// (stage = null) para que el resto del código, que ya tenía el camino 2D, siga funcionando igual.
export const stage = null;

export const initStage = () => null;
export function stopDemo() {}
export function mountHome() {}
export function mountGame() {}

// Sin escena 3D no hay miniaturas renderizadas: la personalización usa sus vistas previas 2D.
export const thumbFor = () => null;
