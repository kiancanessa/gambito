// Comprueba tu conexión a Neon ANTES de desplegar: crea una tabla de prueba, guarda y lee una copia, y la borra.
// La cadena de conexión se queda en tu equipo (variable de entorno); no toca los datos reales de Gambito.
//
//   PowerShell:  $env:DATABASE_URL = "postgresql://...neon.tech/...?sslmode=require"; node scripts/check-neon.js
//   bash:        DATABASE_URL="postgresql://..." node scripts/check-neon.js
import { randomBytes, randomUUID } from 'node:crypto';
import { PgStore } from '../server/persist.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL (la cadena de conexión de Neon).');
  process.exit(1);
}

const store = new PgStore(url, { table: 'gambito_snapshots_check' });
const owner = randomUUID();
let ok = true;
const step = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) ok = false;
};

try {
  const t0 = Date.now();
  await store.init();
  step('Conexión y creación de la tabla de prueba', true, `${Date.now() - t0} ms (la primera vez Neon despierta)`);
  step('Tabla vacía al principio', (await store.meta()) === null);
  await store.claim(owner);
  const payload = randomBytes(200_000); // 200 KB aleatorios, como una base de datos
  step('Guardar copia (200 KB)', (await store.save(payload, owner)) === true);
  const back = await store.load();
  step('Leer la copia: idéntica byte a byte', Buffer.isBuffer(back) && Buffer.compare(back, payload) === 0);
  step('Copia final marcada para el relevo', (await store.save(payload, owner, { final: true })) === true && (await store.meta()).final === true);
  step('Otra instancia no puede escribir', (await store.save(Buffer.from('x'), randomUUID())) === false);
  await store.drop();
  step('Tabla de prueba eliminada', true);
} catch (err) {
  step('Ejecución sin errores', false, err.message);
} finally {
  await store.close();
}
console.log(ok ? '\nNeon listo: ya puedes usar esta cadena como DATABASE_URL en Render ✔' : '\nHay problemas con la conexión a Neon (revisa la cadena de conexión).');
process.exit(ok ? 0 : 1);
