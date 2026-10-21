// Decide si el lobby usa la arena 3D o su alternativa 2D. Es una función pura para poder probarla.
//
// El 3D es una mejora opcional: la arena 2D (capas CSS) siempre está debajo y es la que se ve si algo falla.
//  - Preferencia del usuario (Ajustes): '0' la apaga. El modo «Tablero 2D» también la apaga (significa «sin gráficos 3D»).
//  - Movimiento reducido: se renderiza un solo fotograma, sin bucle de animación.
//  - Equipos débiles (≤ 2 núcleos, ≤ 2 GB, ahorro de datos): se usa solo la alternativa 2D.
export function arenaMode({ pref = 'auto', board2d = false, webgl = true, cores = 8, memory = 8, saveData = false, reducedMotion = false } = {}) {
  if (pref === '0' || board2d) return { use3d: false, reason: 'ajustes', animate: false };
  if (!webgl) return { use3d: false, reason: 'sin-webgl', animate: false };
  if (saveData) return { use3d: false, reason: 'ahorro-datos', animate: false };
  if (cores <= 2 || memory <= 2) return { use3d: false, reason: 'equipo-limitado', animate: false };
  return { use3d: true, reason: reducedMotion ? 'movimiento-reducido' : 'ok', animate: !reducedMotion };
}

// `?2d` se lee al cargar: la aplicación reescribe la URL al navegar y después ya no estaría.
const URL_2D = typeof location !== 'undefined' && new URLSearchParams(location.search).has('2d');

// Lee las señales reales del navegador (en pruebas se pasan a mano).
export function readCapabilities(webgl) {
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  return {
    pref: read('checkpoint.arena3d') ?? 'auto',
    board2d: read('checkpoint.2d') === '1' || URL_2D,
    webgl,
    cores: navigator.hardwareConcurrency ?? 8,
    memory: navigator.deviceMemory ?? 8,
    saveData: !!navigator.connection?.saveData || matchMedia('(prefers-reduced-data: reduce)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion'),
  };
}
