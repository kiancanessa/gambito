// Interruptores de funciones en desarrollo: lo nuevo nace apagado y se activa cuando está listo.
// Se pueden forzar por URL para probar: https://tu-sitio/?flag=lobby&flag=replays
const names = ['lobby', 'wallet', 'replays', 'circuit', 'social'];

const fromUrl = new URLSearchParams(location.search).getAll('flag');
const fromConfig = window.GAMBITO_FLAGS ?? {};

export const flags = Object.fromEntries(names.map((n) => [n, fromUrl.includes(n) || fromConfig[n] === true]));
