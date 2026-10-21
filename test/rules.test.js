// Integridad competitiva: el servidor es la única autoridad sobre jugadas, turno, reloj y resultado.
// Se prueba la sala (`Room`) directamente con sockets simulados, y por WebSocket que un cliente no puede declarar nada.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, mock, test } from 'node:test';
import { Chess } from 'chess.js';
import WebSocket from 'ws';
import { openDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { RoomManager } from '../server/rooms.js';

let db;
let mgr;
before(() => {
  db = openDb(':memory:');
  mgr = new RoomManager(db);
});
after(() => {
  mgr.close();
  db.close();
});
afterEach(() => mock.timers.reset());

const fakeWs = (user) => {
  const ws = { readyState: 1, meta: { user }, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
  ws.last = (t) => [...ws.sent].reverse().find((m) => m.t === t);
  return ws;
};
const user = (id) => ({ id, name: id, rating: 1000, games: 0 });

// Sala con dos jugadores sentados (blancas = w, negras = b) y, opcionalmente, una posición inicial.
function match({ tc = 'blitz5', fen = null, rated = false } = {}) {
  const room = mgr.create({ tcId: tc, rated, colorPref: 'w' });
  const w = fakeWs(user(`w-${room.code}`));
  const b = fakeWs(user(`b-${room.code}`));
  if (rated) for (const u of [w.meta.user, b.meta.user]) db.createUser({ id: u.id, name: u.id, tokenHash: `t-${u.id}`, recoveryHash: `r-${u.id}` });
  room.seat(w.meta.user, w);
  room.seat(b.meta.user, b);
  if (fen) room.chess = new Chess(fen);
  return { room, w, b };
}
const play = (room, ws, uci) => room.move(ws, uci);
const sequence = (room, w, b, list) => list.forEach((uci, i) => play(room, i % 2 === 0 ? w : b, uci));

describe('jugadas, turno y formato', () => {
  test('una jugada legal se acepta y cambia el turno', () => {
    const { room, w } = match();
    play(room, w, 'e2e4');
    assert.equal(room.uci.length, 1);
    assert.equal(room.chess.turn(), 'b');
    assert.equal(room.status, 'playing');
  });

  test('fuera de turno, ilegal o mal formada: rechazada, el estado no cambia y se resincroniza al cliente', () => {
    const { room, w, b } = match();
    const fen = room.chess.fen();
    play(room, b, 'e7e5'); // no es su turno
    assert.equal(w.last('error') ?? null, null);
    assert.match(b.last('error').message, /turno/);
    play(room, w, 'e2e5'); // peón no salta tres casillas
    assert.match(w.last('error').message, /ilegal/i);
    for (const bad of ['', 'e2', 'zz99', 'e2e4e5', 42, null, { from: 'e2' }]) play(room, w, bad);
    assert.equal(room.chess.fen(), fen, 'ninguna jugada rechazada altera la partida');
    assert.equal(room.uci.length, 0);
    assert.equal(w.last('state').moves.length, 0, 'tras el error el cliente recibe el estado real');
  });

  test('no se puede mover una pieza del rival ni comerse a las propias', () => {
    const { room, w } = match();
    play(room, w, 'e7e6'); // pieza negra
    play(room, w, 'a1a2'); // la torre no puede ocupar la casilla de su peón
    assert.equal(room.uci.length, 0);
  });

  test('un espectador no puede mover', () => {
    const { room, w } = match();
    const spec = fakeWs(user('espectador'));
    room.seat(spec.meta.user, spec);
    assert.equal(spec.meta.role, 's');
    play(room, spec, 'e2e4');
    assert.equal(room.uci.length, 0);
    play(room, w, 'e2e4');
    assert.equal(room.uci.length, 1);
  });
});

describe('reglas especiales', () => {
  test('enroque corto: mueve el rey y la torre', () => {
    const { room, w, b } = match();
    sequence(room, w, b, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1']);
    assert.equal(room.uci.at(-1), 'e1g1');
    assert.match(room.chess.fen().split(' ')[0], /RNBQ1RK1$/, 'torre en f1 y rey en g1');
  });

  test('enroque con el rey en jaque o casilla de paso atacada es ilegal', () => {
    // la dama negra en f8 ataca f1: el rey no puede cruzarla
    const { room, w } = match({ fen: '5q1k/8/8/8/8/8/8/R3K2R w KQ - 0 1' });
    play(room, w, 'e1g1');
    assert.equal(room.uci.length, 0, 'enroque corto cruzando f1 atacada');
    play(room, w, 'e1c1'); // a la larga sí está permitido (d1 y c1 libres de ataque)
    assert.equal(room.uci.length, 1);
  });

  test('captura al paso: solo en la jugada inmediata y retira el peón capturado', () => {
    const { room, w, b } = match();
    sequence(room, w, b, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
    assert.equal(room.uci.length, 5);
    const [placement] = room.chess.fen().split(' ');
    assert.ok(!placement.includes('d5') && room.chess.get('d5') == null, 'el peón negro de d5 desaparece');
    assert.equal(room.chess.get('d6')?.color, 'w');

    // si se deja pasar el turno, ya no se puede capturar al paso
    const t = match();
    sequence(t.room, t.w, t.b, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'a2a3', 'a6a5']);
    play(t.room, t.w, 'e5d6');
    assert.equal(t.room.uci.length, 6, 'e5d6 ya no es legal');
  });

  test('coronación: exige pieza válida (dama, torre, alfil o caballo) y se aplica', () => {
    const { room, w } = match({ fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1' });
    play(room, w, 'a7a8'); // sin pieza
    play(room, w, 'a7a8k'); // rey: no existe como promoción
    play(room, w, 'a7a8p');
    assert.equal(room.uci.length, 0);
    play(room, w, 'a7a8n');
    assert.equal(room.chess.get('a8').type, 'n');
    assert.equal(room.chess.get('a8').color, 'w');
    const q = match({ fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1' });
    play(q.room, q.w, 'a7a8q');
    assert.equal(q.room.chess.get('a8').type, 'q');
    assert.equal(q.room.status, 'playing');
  });
});

describe('fin de partida', () => {
  test('jaque mate: gana quien lo da, la sala se cierra y no admite más jugadas', () => {
    const { room, w, b } = match();
    sequence(room, w, b, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.equal(room.status, 'over');
    assert.deepEqual(room.result, { winner: 'b', reason: 'jaque mate' });
    play(room, w, 'a2a3');
    assert.equal(room.uci.length, 4);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM games WHERE code = ?').get(room.code).n, 1, 'la partida se guarda una sola vez');
  });

  test('rey ahogado: tablas', () => {
    const { room, w } = match({ fen: '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1' });
    play(room, w, 'g5g6');
    assert.equal(room.status, 'over');
    assert.deepEqual(room.result, { winner: null, reason: 'rey ahogado' });
  });

  test('material insuficiente: tablas', () => {
    const { room, w } = match({ fen: '4k3/8/8/8/8/8/4p3/4K1B1 w - - 0 1' });
    play(room, w, 'e1e2'); // el rey captura el último peón: rey y alfil contra rey
    assert.deepEqual(room.result, { winner: null, reason: 'material insuficiente' });
  });

  test('triple repetición: tablas', () => {
    const { room, w, b } = match();
    sequence(room, w, b, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
    assert.deepEqual(room.result, { winner: null, reason: 'triple repetición' });
  });

  test('tablas acordadas: hace falta oferta de uno y aceptación del otro; no se puede aceptar la propia', () => {
    const { room, w, b } = match();
    sequence(room, w, b, ['e2e4', 'e7e5']);
    room.drawAction(w, 'offer');
    room.drawAction(w, 'accept'); // no puede aceptarse a sí mismo
    assert.equal(room.status, 'playing');
    room.drawAction(b, 'accept');
    assert.deepEqual(room.result, { winner: null, reason: 'tablas acordadas' });
  });

  test('abandono: antes de que ambos muevan se aborta sin ganador; después pierde quien abandona', () => {
    const early = match();
    play(early.room, early.w, 'e2e4');
    early.room.resign(early.b);
    assert.deepEqual(early.room.result, { winner: null, reason: 'abortada' });

    const late = match();
    sequence(late.room, late.w, late.b, ['e2e4', 'e7e5']);
    late.room.resign(late.w);
    assert.deepEqual(late.room.result, { winner: 'b', reason: 'rendición' });
  });
});

describe('reloj', () => {
  test('el servidor mide el tiempo: el reloj del bando que mueve baja y el incremento se suma desde la 3.ª jugada', () => {
    const { room, w, b } = match({ tc: 'blitz3_2' });
    sequence(room, w, b, ['e2e4', 'e7e5']);
    assert.equal(room.running, 'w', 'el reloj empieza tras la primera jugada de cada bando');
    const before = room.clocks.w;
    play(room, w, 'g1f3');
    assert.ok(room.clocks.w >= before - 50 + 2000 - 50, 'incremento de 2 s');
    assert.equal(room.running, 'b');
  });

  test('tiempo agotado: pierde quien se queda sin tiempo, aunque su cliente no diga nada', () => {
    const { room, w, b } = match();
    sequence(room, w, b, ['e2e4', 'e7e5']);
    room.clocks.w = 5;
    room.lastTick = Date.now() - 1000; // hace 1 s que le tocaba
    room.checkFlag();
    assert.deepEqual(room.result, { winner: 'b', reason: 'tiempo' });
  });

  test('mover con el reloj ya a cero es tiempo agotado, no una jugada válida', () => {
    const { room, w, b } = match();
    sequence(room, w, b, ['e2e4', 'e7e5']);
    room.clocks.w = 10;
    room.lastTick = Date.now() - 5000;
    play(room, w, 'g1f3');
    assert.deepEqual(room.result, { winner: 'b', reason: 'tiempo' });
    assert.equal(room.uci.length, 2, 'la jugada tardía no cuenta');
  });

  test('tiempo agotado con rival sin material para dar mate: tablas', () => {
    const { room, w } = match({ fen: '4k3/8/8/8/8/8/8/4K1B1 w - - 0 1' });
    // mueve el alfil (negras no tienen material): gana por tiempo solo quien pueda mate
    play(room, w, 'g1f2');
    room.clocks.b = 5;
    room.lastTick = Date.now() - 1000;
    room.running = 'b';
    room.checkFlag();
    assert.equal(room.result.winner, null, 'las blancas tienen alfil solo: mate imposible, tablas');
  });
});

describe('desconexión y recuperación', () => {
  test('al desconectarse, el estado informa de la cuenta atrás; si no vuelve en 45 s pierde', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { room, w, b } = match();
    sequence(room, w, b, ['e2e4', 'e7e5']);
    room.detach(b);
    const snap = room.snapshot('w');
    assert.equal(snap.players.b.online, false);
    assert.ok(snap.players.b.dcLeft > 40_000 && snap.players.b.dcLeft <= 45_000);
    assert.equal(snap.players.w.dcLeft, 0);
    mock.timers.tick(45_100);
    assert.deepEqual(room.result, { winner: 'w', reason: 'desconexión' });
  });

  test('si vuelve a tiempo, la partida continúa y la cuenta atrás desaparece', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { room, w, b } = match();
    sequence(room, w, b, ['e2e4', 'e7e5']);
    room.detach(b);
    mock.timers.tick(30_000);
    const back = fakeWs(b.meta.user);
    room.seat(b.meta.user, back);
    assert.equal(back.meta.role, 'b', 'recupera su asiento');
    assert.equal(room.snapshot('b').players.b.dcLeft, 0);
    mock.timers.tick(60_000);
    assert.equal(room.status, 'playing');
    play(room, w, 'g1f3');
    assert.equal(room.uci.length, 3);
  });

  test('desconexión antes de que ambos muevan: se aborta, sin ganador', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { room, w } = match();
    play(room, w, 'e2e4');
    room.detach(room.players.b.socks.values().next().value);
    mock.timers.tick(45_100);
    assert.deepEqual(room.result, { winner: null, reason: 'abortada' });
  });
});

describe('por WebSocket: el cliente no puede declarar resultados', () => {
  let app;
  let base;
  before(async () => {
    app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }], metricsLogMs: 0 });
    base = `http://127.0.0.1:${app.port}`;
  });
  after(() => app.close());

  async function client(name) {
    const g = await (await fetch(`${base}/api/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'auth', token: g.token }));
    await new Promise((r) => setTimeout(r, 120));
    return { ws, msgs, send: (m) => ws.send(JSON.stringify(m)) };
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  test('mensajes inventados (win, result, over, setClock, fen…) no cambian nada', async () => {
    const [a, b] = [await client('Honrado1'), await client('Tramposo2')];
    a.send({ t: 'create', tc: 'blitz5', color: 'w' });
    await pause(150);
    const code = a.msgs.find((m) => m.t === 'created').code;
    b.send({ t: 'join', code });
    await pause(150);
    const room = app.rooms.get(code);
    for (const msg of [
      { t: 'win' }, { t: 'result', winner: 'b' }, { t: 'over', winner: 'b', reason: 'jaque mate' }, { t: 'setClock', w: 0 },
      { t: 'fen', fen: '7k/8/8/8/8/8/8/K6Q w - - 0 1' }, { t: 'state', status: 'over', result: { winner: 'b' } }, { t: 'move', uci: 'e2e4', winner: 'w' },
      { t: 'draw', action: 'accept' }, { t: 'rematch' },
    ]) {
      b.send(msg);
    }
    await pause(250);
    assert.equal(room.status, 'playing', 'la partida sigue en juego');
    assert.equal(room.result, null);
    assert.equal(room.uci.length, 0, 'solo el turno de blancas habría podido mover, y e2e4 vino de las negras');
    assert.equal(room.chess.fen().split(' ')[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
    a.ws.close();
    b.ws.close();
  });

  test('las negras no pueden resignar «en nombre» de las blancas: solo se rinde quien envía el mensaje', async () => {
    const [a, b] = [await client('Blancas3'), await client('Negras4')];
    a.send({ t: 'create', tc: 'blitz5', color: 'w' });
    await pause(150);
    const code = a.msgs.find((m) => m.t === 'created').code;
    b.send({ t: 'join', code });
    await pause(150);
    a.send({ t: 'move', uci: 'e2e4' });
    await pause(80);
    b.send({ t: 'move', uci: 'e7e5' });
    await pause(80);
    b.send({ t: 'resign', as: 'w' });
    await pause(150);
    const room = app.rooms.get(code);
    assert.deepEqual(room.result, { winner: 'w', reason: 'rendición' }, 'pierden las negras, que fueron quienes enviaron el mensaje');
    a.ws.close();
    b.ws.close();
  });
});
