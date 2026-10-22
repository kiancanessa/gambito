// IP del cliente detrás de un proxy (PROMPT 10). Si el servidor se fiara de la PRIMERA entrada de X-Forwarded-For (que escribe el
// propio cliente), cualquiera esquivaría todos los límites (cuentas nuevas, recuperación, peticiones, sockets) cambiando la cabecera.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';

process.env.TRUST_PROXY = '1'; // antes de importar el servidor: la configuración se lee al cargar
const { startServer } = await import('../server/index.js');
const { clientIp } = await import('../server/ip.js');
const { LIMITS } = await import('../server/config.js');

let app;
let base;
before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0 });
  base = `http://127.0.0.1:${app.port}`;
});
after(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
  return app.close();
});

const recover = (xff) => fetch(`${base}/api/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ code: 'AAAA-BBBB-CCCC' }) });
const req = (xff, remote = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });

describe('clientIp', () => {
  test('sin proxy de confianza se usa la dirección del socket y se ignora la cabecera', () => {
    assert.equal(clientIp(req('1.2.3.4'), { trust: false }), '10.0.0.1');
  });
  test('con un proxy de confianza manda la ÚLTIMA entrada: la que añadió el proxy, no la que escribió el cliente', () => {
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.9')), '203.0.113.9');
    assert.equal(clientIp(req('203.0.113.9')), '203.0.113.9');
    assert.equal(clientIp(req(undefined)), '10.0.0.1');
    assert.equal(clientIp(req('')), '10.0.0.1');
  });
  test('TRUSTED_PROXY_HOPS cuenta proxys desde el final; nunca se sale de la cadena', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.9, 172.16.0.5')), '203.0.113.9');
    assert.equal(clientIp(req('203.0.113.9')), '203.0.113.9', 'cadena más corta que los saltos: la primera disponible');
    process.env.TRUSTED_PROXY_HOPS = 'basura';
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.9')), '203.0.113.9');
    delete process.env.TRUSTED_PROXY_HOPS;
  });
  test('valores absurdos no se convierten en claves enormes', () => {
    assert.ok(clientIp(req(`${'9'.repeat(5000)}`)).length <= 64);
    assert.ok(clientIp(req(Array(500).fill('1.1.1.1').join(','))).length <= 64);
  });
});

describe('los límites no se esquivan cambiando X-Forwarded-For', () => {
  test('/api/recover (10 intentos por 10 min): inventar la primera entrada no da intentos nuevos', async () => {
    const statuses = [];
    for (let i = 0; i < 14; i += 1) statuses.push((await recover(`198.51.100.${i}, 203.0.113.50`)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404), 'los 10 primeros se procesan');
    assert.ok(statuses.slice(10).every((s) => s === 429), `a partir del 11.º: ${statuses.slice(10)}`);
  });
  test('otro cliente real (otra entrada final) tiene su propio cupo', async () => {
    assert.equal((await recover('198.51.100.1, 203.0.113.77')).status, 404);
  });
  test('sockets: el tope por IP tampoco se esquiva con una cabecera inventada', async () => {
    const opened = [];
    const results = [];
    for (let i = 0; i < LIMITS.wsPerIp + 3; i += 1) {
      results.push(
        await new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: { 'X-Forwarded-For': `192.0.2.${i}, 203.0.113.90` } });
          ws.on('open', () => (opened.push(ws), resolve('open')));
          ws.on('error', () => resolve('rechazado'));
          ws.on('unexpected-response', () => resolve('rechazado'));
        }),
      );
    }
    opened.forEach((w) => w.close());
    assert.equal(results.filter((r) => r === 'open').length, LIMITS.wsPerIp);
    assert.ok(results.slice(LIMITS.wsPerIp).every((r) => r === 'rechazado'));
  });
  test('cuentas de invitado: el tope por hora e IP tampoco se esquiva', async () => {
    const saved = LIMITS.guestsPerHour;
    LIMITS.guestsPerHour = 3;
    try {
      const out = [];
      for (let i = 0; i < 6; i += 1) out.push((await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i}, 203.0.113.99` }, body: '{}' })).status);
      assert.deepEqual(out, [201, 201, 201, 429, 429, 429]);
    } finally {
      LIMITS.guestsPerHour = saved;
    }
  });
});
