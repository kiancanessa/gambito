// Mapa interactivo de la campaña (SVG): camino, río con puente, bosque, nieblas y tu avance.
import { CAMPAIGN, GLYPH } from './data.js';

const VS = '︎';

// Coordenadas de los nodos (índices 0-4) y de la puerta al siguiente capítulo (índice 5).
const LAYOUTS = {
  wide: { w: 1100, h: 640, pts: [[130, 500], [335, 372], [555, 492], [785, 342], [945, 205], [1030, 80]] },
  tall: { w: 640, h: 1060, pts: [[160, 920], [450, 775], [185, 625], [455, 465], [200, 305], [420, 130]] },
};

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2);

function rng(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Segmento de Catmull-Rom → Bézier entre pts[i] y pts[i+1].
function segment(pts, i) {
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(pts.length - 1, i + 2)];
  const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
  const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
  return { p1, c1, c2, p2, d: `M${p1[0]},${p1[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}` };
}

function bezier(seg, t) {
  const u = 1 - t;
  const f = (k) => u ** 3 * seg.p1[k] + 3 * u * u * t * seg.c1[k] + 3 * u * t * t * seg.c2[k] + t ** 3 * seg.p2[k];
  return [f(0), f(1)];
}

function decor(layout, segs) {
  const R = rng(7);
  const road = [];
  segs.forEach((s) => {
    for (let t = 0; t <= 1; t += 0.06) road.push(bezier(s, t));
  });
  const near = (x, y, r) => road.some(([a, b]) => (a - x) ** 2 + (b - y) ** 2 < r * r);
  const icons = ['🌲', '🌲', '🌳', '🌲', '🌳', '🌲', '🌾', '🍄', '🌸', '🪨'];
  const out = [];
  for (let i = 0; i < 520 && out.length < 90; i += 1) {
    const x = 20 + R() * (layout.w - 40);
    const y = 40 + R() * (layout.h - 60);
    if (near(x, y, 78)) continue;
    // deja libre el cauce del río (franja alrededor del puente) para que no haya árboles en el agua
    out.push({ x, y, ch: icons[Math.floor(R() * icons.length)], size: 20 + R() * 16 });
  }
  return out.sort((a, b) => a.y - b.y);
}

function starsRow(n, size = 16) {
  return [1, 2, 3].map((i) => `<tspan fill="${i <= n ? '#ffd24a' : '#5b5380'}" font-size="${size}">★</tspan>`).join('');
}

function build(layoutKey, { cleared, stars }) {
  const L = LAYOUTS[layoutKey];
  const pts = L.pts;
  const segs = pts.slice(0, -1).map((_, i) => segment(pts, i));
  const done = cleared >= CAMPAIGN.length;

  // Río perpendicular al camino en el puente (nodo 2).
  const P = pts[2];
  const tx = pts[3][0] - pts[1][0];
  const ty = pts[3][1] - pts[1][1];
  const len = Math.hypot(tx, ty);
  const t = [tx / len, ty / len];
  const n = [-t[1], t[0]];
  const at = (a, b) => `${(P[0] + n[0] * a + t[0] * b).toFixed(1)},${(P[1] + n[1] * a + t[1] * b).toFixed(1)}`;
  const river = `M${at(-900, 0)} C${at(-600, 150)} ${at(-230, -130)} ${at(0, 0)} C${at(230, 130)} ${at(600, -150)} ${at(900, 0)}`;
  const angle = (Math.atan2(t[1], t[0]) * 180) / Math.PI;

  const trees = decor(L, segs)
    .filter((tr) => {
      // quita lo que caiga sobre el río
      const d = Math.abs((tr.x - P[0]) * n[0] * 0 + ((tr.x - P[0]) * t[0] + (tr.y - P[1]) * t[1]));
      return d > 50 || Math.hypot(tr.x - P[0], tr.y - P[1]) > 300;
    })
    .map((tr) => `<text class="deco" x="${tr.x.toFixed(0)}" y="${tr.y.toFixed(0)}" font-size="${tr.size.toFixed(0)}">${tr.ch}</text>`)
    .join('');

  const pathLayers = segs
    .map((s, i) => {
      const gate = i === segs.length - 1;
      const state = i < cleared ? 'done' : i === cleared ? 'next' : 'far';
      return `<g class="seg ${state} ${gate ? 'gate-seg' : ''}">
        <path class="road-edge" d="${s.d}"/><path class="road" d="${s.d}"/>
        <path class="road-glow" d="${s.d}"/><path id="seg-${i}" class="road-trail" d="${s.d}"/>
      </g>`;
    })
    .join('');

  const landmarks = [
    ['🏡', pts[0][0] - 82, pts[0][1] - 44, 46],
    ['🌾', pts[0][0] + 78, pts[0][1] + 38, 34],
    ['⛺', pts[1][0] + 84, pts[1][1] - 44, 42],
    ['🏰', pts[3][0] - 96, pts[3][1] - 62, 62],
    ['🏚️', pts[4][0] + (layoutKey === 'wide' ? -88 : 92), pts[4][1] - 40, 46],
  ]
    .map(([ch, x, y, s]) => `<text class="landmark" x="${x}" y="${y}" font-size="${s}">${ch}</text>`)
    .join('');

  const nodes = CAMPAIGN.map((c, i) => {
    const [x, y] = pts[i];
    const status = i < cleared ? 'cleared' : i === cleared ? 'current' : 'locked';
    const fogOp = status === 'locked' ? (i === cleared + 1 ? 0.42 : 0.72) : 0;
    const sub =
      status === 'cleared'
        ? `<text class="sub stars" x="0" y="82" text-anchor="middle">${starsRow(stars[c.id] || 1)}</text>`
        : `<text class="sub" x="0" y="82" text-anchor="middle">🪙 ${c.reward}</text>`;
    return `<g class="mnode ${status}" data-idx="${i}" transform="translate(${x},${y})" tabindex="0" role="button" aria-label="${c.name}, ${status === 'locked' ? 'bloqueado' : status === 'cleared' ? 'superado' : 'siguiente rival'}">
      <circle class="halo" r="54"/>
      <circle class="sel-ring" r="50"/>
      <g class="node-body">
        <circle class="ring" r="39"/>
        <circle class="disc" r="32" style="--c:${c.color}"/>
        <circle class="shine" cx="-9" cy="-11" r="14"/>
        <text class="glyph" y="13" text-anchor="middle">${GLYPH[c.glyph]}${VS}</text>
        <circle class="num-bg" cx="-30" cy="-30" r="12"/><text class="num" x="-30" y="-25" text-anchor="middle">${i + 1}</text>
        ${status === 'cleared' ? '<circle class="chk-bg" cx="30" cy="-30" r="12"/><text class="chk" x="30" y="-24" text-anchor="middle">✓</text>' : ''}
        ${status === 'locked' ? '<text class="lock" x="29" y="-22" text-anchor="middle">🔒</text>' : ''}
      </g>
      <text class="name" x="0" y="64" text-anchor="middle">${c.name}</text>
      ${sub}
      ${fogOp ? `<circle class="fog-blob" r="74" fill="url(#fogG)" opacity="${fogOp}"/>` : ''}
    </g>`;
  }).join('');

  const [gx, gy] = pts[5];
  const gate = `<g class="mnode gate ${done ? 'open' : 'locked'}" data-idx="5" transform="translate(${gx},${gy})" tabindex="0" role="button" aria-label="Capítulo 2, Bosque de Alfiles">
    <circle class="halo" r="60"/><circle class="sel-ring" r="52"/>
    <g class="node-body"><circle class="ring" r="40"/><circle class="disc gate-disc" r="33"/>
    <text class="glyph" y="13" text-anchor="middle" style="font-size:34px">🌲</text>
    <text class="lock" x="30" y="-22" text-anchor="middle">${done ? '✨' : '🔒'}</text></g>
    <text class="name" x="0" y="66" text-anchor="middle">Bosque de Alfiles</text>
    <text class="sub" x="0" y="84" text-anchor="middle">${done ? 'Próximamente' : 'Capítulo 2'}</text>
    <circle class="fog-blob" r="150" fill="url(#fogG)" opacity="${done ? 0.35 : 0.9}"/>
  </g>`;

  const bridge = `<g transform="translate(${P[0]},${P[1]}) rotate(${angle})"><rect class="bridge" x="-78" y="-26" width="156" height="52" rx="8"/>
    ${[-54, -27, 0, 27, 54].map((px) => `<line class="plank" x1="${px}" y1="-26" x2="${px}" y2="26"/>`).join('')}
    <rect class="rail" x="-78" y="-30" width="156" height="6" rx="3"/><rect class="rail" x="-78" y="24" width="156" height="6" rx="3"/></g>`;

  const clouds = [0, 1, 2]
    .map((i) => `<ellipse class="cloud" cx="${-200 + i * 380}" cy="${90 + i * 170}" rx="${130 + i * 20}" ry="${26 + i * 4}" style="animation-duration:${70 + i * 25}s;animation-delay:${-i * 22}s"/>`)
    .join('');

  const idx = Math.min(cleared, 5);
  const [tx0, ty0] = pts[idx];

  return `<svg class="map-svg" viewBox="0 0 ${L.w} ${L.h}" role="group" aria-label="Mapa del Valle de Peones" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="grass" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#4aa35a"/><stop offset="0.55" stop-color="#2f7a4a"/><stop offset="1" stop-color="#1e4a47"/></linearGradient>
      <radialGradient id="fogG"><stop offset="0" stop-color="#241a4a" stop-opacity="0.96"/><stop offset="0.6" stop-color="#2d2358" stop-opacity="0.7"/><stop offset="1" stop-color="#2d2358" stop-opacity="0"/></radialGradient>
      <radialGradient id="gateFog" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#1a1238" stop-opacity="${done ? 0.4 : 0.92}"/><stop offset="1" stop-color="#1a1238" stop-opacity="0"/></radialGradient>
      <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#0c0820" stop-opacity="0.55"/></radialGradient>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect width="${L.w}" height="${L.h}" fill="url(#grass)"/>
    <ellipse cx="${L.w * 0.25}" cy="${L.h * 0.8}" rx="${L.w * 0.3}" ry="${L.h * 0.22}" fill="#6dc07a" opacity="0.28"/>
    <ellipse cx="${L.w * 0.55}" cy="${L.h * 0.45}" rx="${L.w * 0.22}" ry="${L.h * 0.14}" fill="#5aae6a" opacity="0.22"/>
    <path class="river-edge" d="${river}"/><path class="river" d="${river}"/><path class="river-flow" d="${river}"/>
    <g class="deco-layer">${trees}</g>
    ${clouds}
    ${pathLayers}
    ${bridge}
    ${landmarks}
    <text class="mount" x="${L.w - 120}" y="70" font-size="70">⛰️</text><text class="mount" x="${L.w - 40}" y="110" font-size="52">🏔️</text>
    <circle cx="${pts[5][0]}" cy="${pts[5][1]}" r="${layoutKey === 'wide' ? 250 : 300}" fill="url(#gateFog)"/>
    ${nodes}
    ${gate}
    <g id="token" class="token" transform="translate(${tx0},${ty0 - 62})">
      <g class="token-body"><ellipse class="tshadow" cx="0" cy="40" rx="14" ry="5"/><circle class="tdisc" r="19"/><text class="tglyph" y="9" text-anchor="middle">♙${VS}</text></g>
    </g>
    <rect width="${L.w}" height="${L.h}" fill="url(#vig)" pointer-events="none"/>
  </svg>`;
}

function moveToken(svg, from, to) {
  const token = svg.querySelector('#token');
  const segs = [...Array(Math.abs(to - from))].map((_, k) => svg.querySelector(`#seg-${Math.min(from, to) + k}`));
  return new Promise((resolve) => {
    if (!segs.length || segs.some((s) => !s)) return resolve();
    const order = to > from ? segs : segs.reverse();
    let i = 0;
    const run = () => {
      const el = order[i];
      const L = el.getTotalLength();
      const t0 = performance.now();
      const dur = 1100;
      const tick = (now) => {
        const p = ease(Math.min(1, (now - t0) / dur));
        const pt = el.getPointAtLength(to > from ? L * p : L * (1 - p));
        token.setAttribute('transform', `translate(${pt.x},${pt.y - 62})`);
        if (now - t0 < dur) requestAnimationFrame(tick);
        else if (++i < order.length) run();
        else resolve();
      };
      requestAnimationFrame(tick);
    };
    run();
  });
}

/**
 * Dibuja el mapa en `host`. Devuelve { select(i), destroy() }.
 * @param {object} o { cleared, stars, selected, animateFrom, onSelect(i) }
 */
export function renderMap(host, o) {
  let key = host.clientWidth && host.clientWidth < 700 ? 'tall' : 'wide';
  let selected = o.selected;
  let animateFrom = o.animateFrom;

  const draw = () => {
    host.innerHTML = build(key, o);
    const svg = host.querySelector('svg');
    const mark = () => svg.querySelectorAll('.mnode').forEach((n) => n.classList.toggle('selected', Number(n.dataset.idx) === selected));
    mark();
    const pick = (el) => {
      const node = el.closest('.mnode');
      if (!node) return;
      selected = Number(node.dataset.idx);
      mark();
      o.onSelect?.(selected);
    };
    svg.addEventListener('click', (e) => pick(e.target));
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(e.target);
      }
    });
    svg.addEventListener('dblclick', (e) => {
      const node = e.target.closest('.mnode');
      if (node) o.onPlay?.(Number(node.dataset.idx));
    });
    if (animateFrom != null && animateFrom !== o.cleared) {
      const from = animateFrom;
      animateFrom = null;
      const token = svg.querySelector('#token');
      const p = svg.querySelector('#seg-0');
      // Coloca el token en el nodo de origen y lo desplaza al nuevo.
      const start = LAYOUTS[key].pts[Math.min(from, 5)];
      token.setAttribute('transform', `translate(${start[0]},${start[1] - 62})`);
      setTimeout(() => moveToken(svg, from, Math.min(o.cleared, 5)).then(() => o.onArrive?.()), 500);
      void p;
    }
  };

  draw();
  const ro = new ResizeObserver(() => {
    const next = host.clientWidth && host.clientWidth < 700 ? 'tall' : 'wide';
    if (next !== key) {
      key = next;
      draw();
    }
  });
  ro.observe(host);

  return {
    select(i) {
      selected = i;
      host.querySelectorAll('.mnode').forEach((n) => n.classList.toggle('selected', Number(n.dataset.idx) === i));
    },
    destroy() {
      ro.disconnect();
      host.innerHTML = '';
    },
  };
}
