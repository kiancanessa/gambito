// Fase 6: métricas internas y juego limpio (protección del ranking + alertas de ritmo), sin Redis ni servicios de pago.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { FAIRPLAY, analyzeTimings } from '../server/fairplay.js';
import { LIMITS } from '../server/config.js';
import { createMetrics } from '../server/metrics.js';
import { startServer } from '../server/index.js';

const PUZZLES = [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }];
let app;
let base;

before(async () => {
  LIMITS.guestsPerHour = 500;
  app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', puzzles: PUZZLES, metricsLogMs: 0 });
  base = `http://127.0.0.1:${app.port}`;
});
after(() => {
  LIMITS.guestsPerHour = 20;
  delete process.env.METRICS_TOKEN;
  delete process.env.BLOCK_SAME_IP_RANKED;
  return app.close();
});

const json = { 'Content-Type': 'application/json' };
const guest = async (name) => (await fetch(`${base}/api/guest`, { method: 'POST', headers: json, body: JSON.stringify({ name }) })).json();
const me = async (g) => (await (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${g.token}` } })).json()).user;

async function connect(g) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    waiters.slice().forEach((w) => w.test(m) && (waiters.splice(waiters.indexOf(w), 1), w.resolve(m)));
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const f = msgs.find(pred);
        if (f) return resolve(f);
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push({ test: pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    close: () => ws.close(),
  };
  c.send({ t: 'auth', token: g.token });
  await c.waitFor((m) => m.t === 'authed');
  return c;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Pone a dos jugadores en una clasificatoria y juega `moves` jugadas; luego rinde `resigner` ('w' o 'b').
async function rankedGame(wa, wb, moves, resigner = 'b') {
  const mark = wa.msgs.length;
  wa.send({ t: 'queue', tc: 'blitz3' });
  wb.send({ t: 'queue', tc: 'blitz3' });
  const matched = await wa.waitFor((m) => m.t === 'matched' && wa.msgs.indexOf(m) >= mark);
  const code = matched.code;
  const sa = await wa.waitFor((m) => m.t === 'state' && m.code === code && m.status === 'playing');
  const whiteIsA = sa.you === 'w';
  const [white, black] = whiteIsA ? [wa, wb] : [wb, wa];
  const script = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'd7d6'];
  for (let i = 0; i < moves; i += 1) {
    (i % 2 === 0 ? white : black).send({ t: 'move', uci: script[i] });
    await pause(40);
  }
  (resigner === 'w' ? white : black).send({ t: 'resign' });
  const over = await wa.waitFor((m) => m.t === 'state' && m.code === code && m.status === 'over');
  await pause(60);
  return { code, over, whiteIsA };
}

describe('métricas', () => {
  test('el endpoint no existe sin token, exige token y devuelve JSON o formato Prometheus', async () => {
    delete process.env.METRICS_TOKEN;
    assert.equal((await fetch(`${base}/api/metrics`)).status, 404, 'sin METRICS_TOKEN el endpoint no existe');
    process.env.METRICS_TOKEN = 'secreto-de-prueba';
    assert.equal((await fetch(`${base}/api/metrics`)).status, 401);
    assert.equal((await fetch(`${base}/api/metrics`, { headers: { Authorization: 'Bearer otro' } })).status, 401);
    const h = { Authorization: 'Bearer secreto-de-prueba' };

    const g = await guest('Medido');
    const ws = await connect(g);
    const snap = await (await fetch(`${base}/api/metrics`, { headers: h })).json();
    assert.equal(typeof snap.uptimeSeconds, 'number');
    assert.equal(snap.gauges.ws_connections >= 1, true);
    assert.equal(typeof snap.gauges.memory_rss_mb, 'number');
    assert.equal(typeof snap.gauges.event_loop_delay_ms_p99, 'number');
    assert.equal(snap.counters.guests_created_total >= 1, true);
    assert.equal(snap.counters['ws_messages_total{t="auth"}'] >= 1, true);
    assert.equal(snap.counters['http_requests_total{status="2xx"}'] >= 1, true);
    assert.equal(snap.http_latency_ms.count >= 1, true);

    const prom = await (await fetch(`${base}/api/metrics?format=prom`, { headers: h })).text();
    assert.match(prom, /^gambito_uptime_seconds \d+/m);
    assert.match(prom, /gambito_ws_connections \d+/);
    assert.match(prom, /gambito_http_latency_ms_bucket\{le="\+Inf"\}/);
    ws.close();
  });

  test('la línea de log resume el estado en una sola línea', () => {
    const m = createMetrics();
    m.gauge('ws_connections', () => 3);
    m.inc('games_total', { result: 'decisive' });
    m.inc('games_total', { result: 'draw' });
    m.inc('moves_total', {}, 10);
    m.observeHttp(12);
    const line = m.line();
    assert.match(line, /^\[metrics\] up=\d+s ws=3 /);
    assert.match(line, /games=2 moves=10 flags=0/);
    assert.equal(line.includes('\n'), false);
    m.stop();
  });
});

describe('juego limpio: análisis de ritmo', () => {
  const thinks = (role, list) => list.map((ms) => ({ role, ms }));
  const human = Array.from({ length: 30 }, (_, i) => 800 + ((i * 7919) % 9000)); // ritmo irregular

  test('un ritmo humano irregular no levanta alertas', () => {
    assert.deepEqual(analyzeTimings(thinks('w', human), 'w', 300), []);
  });

  test('un ritmo casi idéntico jugada tras jugada se marca como regular', () => {
    const robotic = Array.from({ length: 30 }, (_, i) => 3000 + (i % 3) * 20);
    const flags = analyzeTimings(thinks('w', robotic), 'w', 300);
    assert.deepEqual(flags.map((f) => f.kind), ['uniform_timing']);
    assert.ok(flags[0].score > 0.8);
  });

  test('jugar casi todo al instante se marca, pero no en bala ni con pocas jugadas', () => {
    const instant = Array.from({ length: 30 }, (_, i) => 100 + (i % 5) * 50);
    assert.deepEqual(analyzeTimings(thinks('b', instant), 'b', 300).map((f) => f.kind), ['instant_moves']);
    assert.deepEqual(analyzeTimings(thinks('b', instant), 'b', 60), [], 'en bala hay jugadas rápidas legítimas');
    assert.deepEqual(analyzeTimings(thinks('b', instant.slice(0, 10)), 'b', 300), [], 'pocas jugadas: no se concluye');
    assert.deepEqual(analyzeTimings(thinks('w', instant), 'b', 300), [], 'solo cuenta el bando analizado');
  });

  test('las primeras jugadas (de memoria) no cuentan', () => {
    const opening = [200, 200, 200];
    assert.deepEqual(analyzeTimings(thinks('w', [...opening, ...human]), 'w', 300), []);
    assert.equal(FAIRPLAY.skipOpeningMoves, 3);
  });
});

describe('juego limpio: protección del ranking', () => {
  test('una rendición antes de la 6.ª jugada no mueve el Elo y deja una alerta', async () => {
    const [a, b] = [await guest('Rapido1'), await guest('Rapido2')];
    const [wa, wb] = [await connect(a), await connect(b)];
    const before = [(await me(a)).rating, (await me(b)).rating];
    const { over } = await rankedGame(wa, wb, 2, 'b');
    assert.equal(over.result.reason, 'rendición');
    assert.equal(over.unrated, 'quick');
    assert.equal(over.ratingDelta, null);
    assert.deepEqual([(await me(a)).rating, (await me(b)).rating], before);
    const flags = app.db.raw.prepare("SELECT kind FROM game_flags WHERE kind = 'quick_end'").all();
    assert.ok(flags.length >= 1);
    wa.close();
    wb.close();
  });

  test('la 4.ª clasificatoria contra el mismo rival en 24 h no puntúa y se marca', async () => {
    const [a, b] = [await guest('Pareja1'), await guest('Pareja2')];
    const [wa, wb] = [await connect(a), await connect(b)];
    const ratings = [];
    for (let i = 0; i < 5; i += 1) {
      const { over } = await rankedGame(wa, wb, 6, 'b');
      ratings.push([(await me(a)).rating, (await me(b)).rating]);
      if (i < 3) assert.equal(over.unrated, null, `la partida ${i + 1} puntúa`);
      else assert.equal(over.unrated, 'pair', `la partida ${i + 1} no puntúa`);
    }
    assert.notDeepEqual(ratings[0], [1000, 1000], 'las primeras mueven el Elo');
    assert.deepEqual(ratings[3], ratings[2], 'la 4.ª no cambia nada');
    assert.deepEqual(ratings[4], ratings[2], 'la 5.ª tampoco');
    const flagged = app.db.raw.prepare("SELECT DISTINCT user_id FROM game_flags WHERE kind = 'pair_farming'").all().map((r) => r.user_id);
    assert.ok(flagged.includes(a.user.id) && flagged.includes(b.user.id));
    assert.equal((await (await fetch(`${base}/api/leaderboard`)).json()).top.length >= 2, true);
    wa.close();
    wb.close();
  });

  test('con BLOCK_SAME_IP_RANKED no se emparejan dos cuentas de la misma IP (y sin él sí)', async () => {
    const [a, b] = [await guest('MismaIp1'), await guest('MismaIp2')];
    const [wa, wb] = [await connect(a), await connect(b)];
    process.env.BLOCK_SAME_IP_RANKED = '1';
    wa.send({ t: 'queue', tc: 'rapid10' });
    wb.send({ t: 'queue', tc: 'rapid10' });
    await pause(2000);
    assert.equal(wa.msgs.some((m) => m.t === 'matched'), false);
    delete process.env.BLOCK_SAME_IP_RANKED;
    await wa.waitFor((m) => m.t === 'matched', 3500);
    wa.close();
    wb.close();
  });
});
