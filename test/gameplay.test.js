// Jugabilidad: preferencias (valores, límites, animación y movimiento reducido) y récords personales.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Entorno mínimo de navegador para importar los módulos del cliente sin DOM.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let reduced = false;
globalThis.matchMedia = () => ({ matches: reduced });
globalThis.document = { documentElement: { classList: { contains: () => false } }, addEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { vibrate: (p) => (globalThis.__buzz = p) }, configurable: true });

const { DEFAULTS, animScale, buzz, prefs, setPref } = await import('../public/js/prefs.js');
const { state } = await import('../public/js/store.js');
const { defaultRecords, updateRecords } = await import('../public/js/records.js');

test('las preferencias arrancan con valores razonables y se validan al guardarlas', () => {
  assert.deepEqual({ ...prefs }, DEFAULTS);
  setPref('volume', 5);
  assert.equal(prefs.volume, 1, 'el volumen no pasa de 1');
  setPref('volume', -2);
  assert.equal(prefs.volume, 0);
  setPref('animations', 'turbo');
  assert.equal(prefs.animations, 'full', 'un valor desconocido vuelve al predeterminado');
  setPref('showLegal', false);
  assert.equal(JSON.parse(store.get('checkpoint.prefs')).showLegal, false, 'se guardan en este dispositivo');
  setPref('showLegal', true);
  setPref('volume', 0.7);
});

test('animScale: completas = 1, rápidas = 0,5, sin animación = 0; movimiento reducido nunca da más de «rápidas»', () => {
  setPref('animations', 'full');
  assert.equal(animScale(), 1);
  setPref('animations', 'fast');
  assert.equal(animScale(), 0.5);
  setPref('animations', 'off');
  assert.equal(animScale(), 0);
  setPref('animations', 'full');
  reduced = true;
  assert.equal(animScale(), 0.5);
  reduced = false;
});

test('la vibración respeta la preferencia y el movimiento reducido', () => {
  globalThis.__buzz = undefined;
  buzz(20);
  assert.equal(globalThis.__buzz, 20);
  globalThis.__buzz = undefined;
  setPref('haptics', false);
  buzz(20);
  assert.equal(globalThis.__buzz, undefined);
  setPref('haptics', true);
  reduced = true;
  buzz(20);
  assert.equal(globalThis.__buzz, undefined);
  reduced = false;
});

test('récords: la primera marca solo fija la línea de base; después se anuncian las mejoras', () => {
  state.records = defaultRecords();
  // primera victoria: ni racha de 1 ni rating base se anuncian
  assert.deepEqual(updateRecords({ result: 'win', plies: 40, checks: 1, rating: 1010 }), []);
  assert.equal(state.records.bestWinStreak, 1);
  assert.equal(state.records.peakRating, 1010);
  // sube el rating: récord
  const up = updateRecords({ result: 'win', plies: 31, checks: 2, rating: 1028 });
  assert.deepEqual(up.map((n) => n.id), ['rating']);
  // tercera victoria seguida: racha de 3
  const streak = updateRecords({ result: 'win', plies: 50, checks: 0, rating: 1020 });
  assert.deepEqual(streak.map((n) => n.id), ['streak']);
  assert.match(streak[0].label, /3 victorias/);
  // una derrota reinicia la racha pero no borra el mejor registro
  updateRecords({ result: 'loss', plies: 30, checks: 0 });
  assert.equal(state.records.winStreak, 0);
  assert.equal(state.records.bestWinStreak, 3);
});

test('récords: el mate más rápido y los jaques solo cuentan al superar una marca previa', () => {
  state.records = defaultRecords();
  assert.deepEqual(updateRecords({ result: 'win', plies: 41, checks: 5, mate: true }), [], 'primer mate: línea de base');
  const faster = updateRecords({ result: 'win', plies: 25, checks: 1, mate: true });
  assert.deepEqual(faster.map((n) => n.id), ['mate']);
  assert.match(faster[0].label, /13 jugadas/);
  const slower = updateRecords({ result: 'win', plies: 60, checks: 1, mate: true });
  assert.ok(!slower.some((n) => n.id === 'mate'));
  const checks = updateRecords({ result: 'win', plies: 70, checks: 7, mate: false });
  assert.ok(checks.some((n) => n.id === 'checks'), 'siete jaques supera la marca de cinco');
  // una derrota por mate no es récord
  assert.deepEqual(updateRecords({ result: 'loss', plies: 10, checks: 0, mate: true }), []);
});
