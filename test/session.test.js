// Sesión del cliente (PROMPT: entrar, crear cuenta y cerrar sesión): se ejecuta el net.js real contra un servidor real.
// Lo que debe cumplirse: cerrar sesión no deja rastro de la cuenta anterior, no se crea una cuenta sola después, y volver a entrar
// con el código (en cualquier formato) devuelve a la misma cuenta.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../server/config.js';
import { startServer } from '../server/index.js';

LIMITS.guestsPerHour = 100_000;

// Navegador mínimo para el módulo del cliente.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { GAMBITO_API: '', addEventListener() {} };

let app;
let net;
let mod;
const users = () => app.db.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n;

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0 });
  globalThis.window.GAMBITO_API = `http://127.0.0.1:${app.port}`;
  mod = await import('../public/js/net.js');
  net = mod.net;
});
after(() => app.close());

describe('cuentas en el cliente', () => {
  test('quien llega por primera vez NO recibe una cuenta sin preguntar: se le ofrece crear, entrar o jugar como invitado', async () => {
    assert.equal(net.loggedOut, true, 'primera visita = sin sesión');
    assert.equal(await mod.bootstrap(), false);
    assert.equal(net.user, null);
    assert.equal(users(), 0, 'el servidor no creó ninguna cuenta');
  });

  test('«Jugar como invitado» crea una cuenta marcada como invitado, con código de recuperación', async () => {
    const res = await mod.createGuestAccount();
    assert.equal(res.ok, true);
    assert.equal(net.guest, true);
    assert.equal(localStorage.getItem('gambito.guest.v1'), '1');
    assert.equal(net.loggedOut, false);
    assert.match(net.auth.recovery, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(users(), 1);
    globalThis.__first = { id: net.user.id, code: net.auth.recovery };
  });

  test('un invitado sin partidas no tiene rating que enseñar: «Sin clasificar», aunque el servidor guarde 1000 para emparejar', async () => {
    const { isRanked, ratingText } = await import('../public/js/data.js');
    assert.equal(net.user.rating, 1000);
    assert.equal(isRanked(net.user), false);
    assert.equal(ratingText(net.user), 'Sin clasificar');
    assert.equal(ratingText({ rating: 1016, games: 1 }), '1016 pts');
    assert.equal(isRanked(null), false);
  });

  test('reclamar la cuenta: un nombre no válido se rechaza y sigue siendo invitado; uno válido la convierte en cuenta propia', async () => {
    const bad = await mod.claimAccount('a!');
    assert.equal(bad.ok, false);
    assert.equal(net.guest, true);
    const ok = await mod.claimAccount('Clara QA');
    assert.equal(ok.ok, true);
    assert.equal(net.guest, false);
    assert.equal(localStorage.getItem('gambito.guest.v1'), null);
    assert.equal(net.user.name, 'Clara QA');
    assert.equal(net.user.id, globalThis.__first.id, 'es la misma cuenta: no se pierde lo jugado');
  });

  test('cerrar sesión borra la sesión local, marca la salida y deja el progreso limpio', async () => {
    const { state, save } = await import('../public/js/store.js');
    state.coins = 999;
    state.level = 7;
    save();
    await mod.logout();
    assert.equal(net.user, null);
    assert.equal(net.auth, null);
    assert.equal(net.loggedOut, true);
    assert.equal(net.guest, false);
    assert.equal(localStorage.getItem('gambito.auth.v1'), null);
    assert.equal(localStorage.getItem('gambito.loggedout.v1'), '1');
    assert.equal(state.coins, 100, 'los oros de la cuenta anterior no se quedan en el dispositivo');
    assert.equal(state.level, 1);
  });

  test('con la sesión cerrada, volver a arrancar NO crea una cuenta por detrás', async () => {
    const before = users();
    assert.equal(await mod.bootstrap(), false);
    assert.equal(net.user, null);
    assert.equal(users(), before);
  });

  test('crear cuenta con nombre: no es invitada, usa el nombre y devuelve el código', async () => {
    const res = await mod.createAccount('Dani QA');
    assert.equal(res.ok, true);
    assert.equal(res.json.user.name, 'Dani QA');
    assert.match(res.json.recovery, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(net.guest, false);
    assert.equal(net.loggedOut, false);
    assert.equal(localStorage.getItem('gambito.loggedout.v1'), null);
    globalThis.__second = { id: net.user.id, code: net.auth.recovery };
  });

  test('un nombre no permitido no rompe la creación: el servidor asigna uno automático', async () => {
    await mod.logout();
    const res = await mod.createAccount('admin');
    assert.equal(res.ok, true);
    assert.notEqual(res.json.user.name.toLowerCase(), 'admin');
    await mod.logout();
  });

  test('entrar con el código en minúsculas y con espacios devuelve a la misma cuenta y lo guarda con formato', async () => {
    const { id, code } = globalThis.__first;
    const messy = code.toLowerCase().replace(/-/g, ' ');
    const res = await mod.recoverAccount(messy);
    assert.equal(res.ok, true);
    assert.equal(net.user.id, id);
    assert.equal(net.auth.recovery, code, 'se guarda como XXXX-XXXX-XXXX');
    assert.equal(net.loggedOut, false);
    assert.equal(net.guest, false, 'quien entra con su código no es un invitado');
  });

  test('un código incorrecto no inicia sesión ni cambia la cuenta actual', async () => {
    const id = net.user.id;
    const res = await mod.recoverAccount('AAAA-BBBB-CCCC');
    assert.equal(res.ok, false);
    assert.equal(net.user.id, id);
  });

  test('una sesión caducada (servidor sin esa cuenta) no deja colgado a quien ya jugaba: se crea una invitada nueva', async () => {
    localStorage.setItem('gambito.auth.v1', JSON.stringify({ token: 'caducado', recovery: 'AAAA-BBBB-CCCC' }));
    net.user = null;
    assert.equal(await mod.bootstrap(), true);
    assert.ok(net.user?.id);
    assert.equal(net.guest, true);
  });

  test('cada cuenta conserva lo suyo: la otra cuenta sigue existiendo en el servidor tras cerrar sesión', async () => {
    const { id } = globalThis.__second;
    assert.ok(app.db.userById(id), 'la cuenta cerrada no se borra');
  });
});

describe('arte de los avatares', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');
  const art = readFileSync(path.join(root, 'cosmetics-art.js'), 'utf8');
  const data = readFileSync(path.join(root, 'cosmetics-data.js'), 'utf8');
  const keys = (name) => [...art.slice(art.indexOf(`const ${name} = {`)).split('\n};')[0].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

  test('cada avatar usa una pieza, una escena o una ilustración que existen', () => {
    const [pieces, scenes, arts] = [keys('PIECES'), keys('SCENES'), keys('ART')];
    assert.deepEqual(pieces.sort(), ['b', 'k', 'n', 'p', 'q', 'r']);
    const lines = data.split('\n').filter((l) => l.includes("avatar('"));
    assert.ok(lines.length >= 14);
    for (const l of lines) {
      const piece = l.match(/piece: '(\w+)'/)?.[1];
      const artId = l.match(/art: '(\w+)'/)?.[1];
      const scene = l.match(/scene: '(\w+)'/)?.[1];
      assert.ok(piece ? pieces.includes(piece) : arts.includes(artId), `avatar sin arte válido: ${l.slice(0, 60)}`);
      if (scene) assert.ok(scenes.includes(scene), `escena desconocida «${scene}»`);
    }
  });

  test('los avatares son vectoriales: ya no dependen de glifos de texto que cada fuente desplaza', () => {
    assert.doesNotMatch(art, /av-glyph|asset\.glyph|VS\}/);
    assert.doesNotMatch(data, /avatar\([^)]*glyph:/);
  });
});
