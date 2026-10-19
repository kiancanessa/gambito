// Métricas internas (Fase 6): contadores, medidores y latencias, sin dependencias ni servicios de pago.
// Se exponen en GET /api/metrics (solo con METRICS_TOKEN) en JSON o formato Prometheus, y como una línea de log periódica
// (`[metrics] ...`) que se lee gratis en los logs de Render.
import { monitorEventLoopDelay } from 'node:perf_hooks';

const BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500];
const keyOf = (name, labels) => {
  const l = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return l.length ? `${name}{${l.map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(',')}}` : name;
};

// Sustituto sin efecto para quien no recibe métricas (pruebas unitarias).
export const nullMetrics = { inc() {}, gauge() {}, observeHttp() {}, stop() {} };

export function createMetrics() {
  const counters = new Map();
  const gauges = new Map();
  const hist = { counts: BUCKETS_MS.map(() => 0), over: 0, sum: 0, n: 0 };
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const startedAt = Date.now();

  const inc = (name, labels, n = 1) => {
    const k = keyOf(name, labels);
    counters.set(k, (counters.get(k) ?? 0) + n);
  };
  const gauge = (name, fn) => gauges.set(name, fn);
  const observeHttp = (ms) => {
    hist.n += 1;
    hist.sum += ms;
    const i = BUCKETS_MS.findIndex((b) => ms <= b);
    if (i < 0) hist.over += 1;
    else hist.counts[i] += 1;
  };

  function snapshot({ resetLoop = false } = {}) {
    const g = {};
    for (const [name, fn] of gauges) {
      try {
        g[name] = fn();
      } catch {
        g[name] = null;
      }
    }
    const mem = process.memoryUsage();
    const out = {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      gauges: {
        ...g,
        memory_rss_mb: Math.round(mem.rss / 1048576),
        memory_heap_mb: Math.round(mem.heapUsed / 1048576),
        event_loop_delay_ms_p50: +(loop.percentile(50) / 1e6).toFixed(2),
        event_loop_delay_ms_p99: +(loop.percentile(99) / 1e6).toFixed(2),
        event_loop_delay_ms_max: +(loop.max / 1e6).toFixed(2),
      },
      counters: Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b))),
      http_latency_ms: {
        count: hist.n,
        mean: hist.n ? +(hist.sum / hist.n).toFixed(2) : 0,
        buckets: Object.fromEntries([...BUCKETS_MS.map((b, i) => [`le_${b}`, hist.counts[i]]), ['over', hist.over]]),
      },
    };
    if (resetLoop) loop.reset();
    return out;
  }

  // Formato de texto de Prometheus (para Grafana Cloud gratis, etc.).
  function prometheus() {
    const s = snapshot();
    const lines = [`gambito_uptime_seconds ${s.uptimeSeconds}`];
    for (const [k, v] of Object.entries(s.gauges)) if (v !== null && typeof v === 'number') lines.push(`gambito_${k} ${v}`);
    for (const [k, v] of Object.entries(s.counters)) lines.push(`gambito_${k} ${v}`);
    let acc = 0;
    BUCKETS_MS.forEach((b, i) => {
      acc += hist.counts[i];
      lines.push(`gambito_http_latency_ms_bucket{le="${b}"} ${acc}`);
    });
    lines.push(`gambito_http_latency_ms_bucket{le="+Inf"} ${hist.n}`, `gambito_http_latency_ms_sum ${hist.sum.toFixed(2)}`, `gambito_http_latency_ms_count ${hist.n}`);
    return `${lines.join('\n')}\n`;
  }

  // Resumen de una línea para los logs.
  function line() {
    const s = snapshot({ resetLoop: true });
    const sum = (prefix) => Object.entries(s.counters).filter(([k]) => k === prefix || k.startsWith(`${prefix}{`)).reduce((n, [, v]) => n + v, 0);
    const g = s.gauges;
    return `[metrics] up=${s.uptimeSeconds}s ws=${g.ws_connections ?? '-'} rooms=${g.rooms_total ?? '-'} playing=${g.rooms_playing ?? '-'} queue=${g.queue_size ?? '-'} `
      + `rss=${g.memory_rss_mb}MB loop_p99=${g.event_loop_delay_ms_p99}ms http=${s.http_latency_ms.count} mean=${s.http_latency_ms.mean}ms `
      + `games=${sum('games_total')} moves=${sum('moves_total')} flags=${sum('fairplay_flags_total')}`;
  }

  return { inc, gauge, observeHttp, snapshot, prometheus, line, stop: () => loop.disable() };
}
