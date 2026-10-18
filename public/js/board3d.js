// Tablero y piezas en 3D (three.js): cámara en perspectiva, piezas torneadas, sombras y animaciones.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';

const FILES = 'abcdefgh';
const TILE_TOP = 0;

export const webglSupported = () => {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
};

const sqXZ = (sq) => ({ x: FILES.indexOf(sq[0]) - 3.5, z: 3.5 - (Number(sq[1]) - 1) });

// ---------- Easing ----------
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - ((-2 * p + 2) ** 3) / 2);
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeOutBack = (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- Skins de piezas (materiales) ----------
const SETS = {
  classic: {
    w: { color: '#f3ead6', roughness: 0.32, metalness: 0, clearcoat: 0.7 },
    b: { color: '#2a2631', roughness: 0.28, metalness: 0.05, clearcoat: 0.8 },
  },
  gold: {
    w: { color: '#f7c948', roughness: 0.2, metalness: 1 },
    b: { color: '#1d1433', roughness: 0.22, metalness: 0.75, emissive: '#3a1a8a', emissiveIntensity: 0.35 },
  },
  neon: {
    w: { color: '#06262b', roughness: 0.35, metalness: 0.2, emissive: '#00f5ff', emissiveIntensity: 1.15 },
    b: { color: '#2a0826', roughness: 0.35, metalness: 0.2, emissive: '#ff2bd6', emissiveIntensity: 1.15 },
  },
  candy: {
    w: { color: '#ff9ccb', roughness: 0.22, metalness: 0, clearcoat: 1 },
    b: { color: '#74efbd', roughness: 0.22, metalness: 0, clearcoat: 1 },
  },
  ice: {
    w: { color: '#d3f1ff', roughness: 0.06, metalness: 0.1, emissive: '#4aa8e0', emissiveIntensity: 0.25, opacity: 0.88, clearcoat: 1 },
    b: { color: '#ff7a1f', roughness: 0.4, metalness: 0.1, emissive: '#ff3a00', emissiveIntensity: 0.9 },
  },
  dragon: {
    w: { color: '#12b255', roughness: 0.3, metalness: 0.85, emissive: '#0a7a38', emissiveIntensity: 0.35 },
    b: { color: '#a30f1f', roughness: 0.3, metalness: 0.85, emissive: '#6a0510', emissiveIntensity: 0.4 },
  },
};

// ---------- Skins de tablero ----------
const BOARDS = {
  wood: { light: '#ead2a4', dark: '#9b6a3e', frame: '#5a3920', side: '#3a2412', glow: '#ffb347', label: '#f2d9b0', paint: 'wood' },
  forest: { light: '#e0ebc3', dark: '#5d8a46', frame: '#2f4a26', side: '#1e3018', glow: '#7fe08a', label: '#d5eab8', paint: 'speckle' },
  night: { light: '#4f4e92', dark: '#171446', frame: '#0c0a2a', side: '#07061a', glow: '#6a5cff', label: '#b8b3ff', paint: 'stars', emissive: true },
  sakura: { light: '#fff1f6', dark: '#e58aac', frame: '#8a3a5c', side: '#5a2038', glow: '#ff8fb8', label: '#ffd2e2', paint: 'petals' },
  neon: { light: '#0e1030', dark: '#070817', frame: '#0b0b1c', side: '#05050f', glow: '#00f5ff', label: '#00f5ff', paint: 'grid', emissive: true },
  lava: { light: '#5c3022', dark: '#160a08', frame: '#2a120c', side: '#160805', glow: '#ff5a1f', label: '#ffb36b', paint: 'cracks', emissive: true },
};

function rnd(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const PAINT = {
  wood(g, s, R, dark) {
    for (let i = 0; i < 52; i += 1) {
      const y = R() * s;
      g.strokeStyle = R() < 0.5 ? `rgba(50,24,6,${0.05 + R() * 0.13})` : `rgba(255,235,200,${0.03 + R() * 0.07})`;
      g.lineWidth = 1 + R() * 2.4;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(s * 0.3, y + (R() - 0.5) * 16, s * 0.65, y + (R() - 0.5) * 16, s, y + (R() - 0.5) * 12);
      g.stroke();
    }
  },
  speckle(g, s, R, dark) {
    for (let i = 0; i < 520; i += 1) {
      g.fillStyle = R() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)';
      g.beginPath();
      g.arc(R() * s, R() * s, 0.6 + R() * 2.4, 0, 7);
      g.fill();
    }
  },
  petals(g, s, R, dark) {
    for (let i = 0; i < 34; i += 1) {
      g.save();
      g.translate(R() * s, R() * s);
      g.rotate(R() * 6.28);
      g.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(230,140,175,0.25)';
      g.beginPath();
      g.ellipse(0, 0, 5 + R() * 4, 2.4 + R() * 2, 0, 0, 7);
      g.fill();
      g.restore();
    }
  },
  stars(g, s, R, dark, glow) {
    for (let i = 0; i < 30; i += 1) {
      const x = R() * s;
      const y = R() * s;
      const r = 0.8 + R() * 2;
      g.fillStyle = glow ? '#ffffff' : 'rgba(255,255,255,0.9)';
      g.shadowColor = '#bcd0ff';
      g.shadowBlur = glow ? 8 : 0;
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
    g.shadowBlur = 0;
  },
  grid(g, s, R, dark, glow) {
    const col = dark ? '#ff2bd6' : '#00f5ff';
    g.strokeStyle = col;
    g.shadowColor = col;
    g.shadowBlur = glow ? 14 : 0;
    g.lineWidth = glow ? 9 : 5;
    g.globalAlpha = glow ? 0.9 : 0.55;
    g.strokeRect(5, 5, s - 10, s - 10);
    g.globalAlpha = glow ? 0.28 : 0.15;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(s / 2, 12);
    g.lineTo(s / 2, s - 12);
    g.moveTo(12, s / 2);
    g.lineTo(s - 12, s / 2);
    g.stroke();
    g.globalAlpha = 1;
    g.shadowBlur = 0;
  },
  cracks(g, s, R, dark, glow) {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let k = 0; k < 4; k += 1) {
      let x = R() < 0.5 ? 0 : s;
      let y = R() * s;
      g.beginPath();
      g.moveTo(x, y);
      for (let i = 0; i < 6; i += 1) {
        x += (s / 2 - x) * 0.18 + (R() - 0.5) * 70;
        y += (R() - 0.5) * 70;
        g.lineTo(x, y);
      }
      g.strokeStyle = glow ? '#ff8a2a' : 'rgba(0,0,0,0.65)';
      g.shadowColor = '#ff5a1f';
      g.shadowBlur = glow ? 14 : 0;
      g.lineWidth = glow ? 2.5 + R() * 3 : 4;
      g.stroke();
    }
    g.shadowBlur = 0;
  },
};

function tileMaterial(skin, dark, seed) {
  const base = dark ? skin.dark : skin.light;
  const paint = PAINT[skin.paint];
  const map = canvasTex(256, (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    paint?.(g, s, rnd(seed), dark, false);
    g.strokeStyle = 'rgba(0,0,0,0.16)';
    g.lineWidth = 6;
    g.strokeRect(0, 0, s, s);
  });
  const mat = new THREE.MeshStandardMaterial({ map, roughness: skin.emissive ? 0.35 : 0.55, metalness: skin.emissive ? 0.25 : 0.02 });
  if (skin.emissive) {
    mat.emissive = new THREE.Color('#ffffff');
    mat.emissiveMap = canvasTex(256, (g, s) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, s, s);
      paint?.(g, s, rnd(seed), dark, true);
    });
    mat.emissiveIntensity = 1;
  }
  return mat;
}

function glowTexture(color) {
  return canvasTex(256, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.45, `${color}55`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

function labelSprite(text, color) {
  const tex = canvasTex(64, (g, s) => {
    g.fillStyle = color;
    g.font = 'bold 40px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, s / 2, s / 2 + 2);
  });
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(0.34, 0.34, 1);
  return spr;
}

// ---------- Geometrías de las piezas ----------
// Perfiles torneados suavizados con Catmull-Rom (aspecto de pieza de madera tallada).
function smoothLathe(pts, samples = 7) {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, 'centripetal');
  const sampled = curve.getPoints(pts.length * samples).map((v) => new THREE.Vector2(Math.max(0, v.x), v.y));
  sampled[sampled.length - 1].x = 0;
  return new THREE.LatheGeometry(sampled, 64);
}

// Peana común: disco con borde redondeado.
const PLINTH = [[0, 0], [0.38, 0], [0.425, 0.012], [0.44, 0.04], [0.425, 0.075], [0.39, 0.095], [0.34, 0.105]];

const PROFILES = {
  p: [...PLINTH, [0.27, 0.14], [0.21, 0.19], [0.165, 0.26], [0.14, 0.34], [0.135, 0.41], [0.16, 0.455], [0.215, 0.475], [0.235, 0.5], [0.215, 0.525], [0.15, 0.545], [0.11, 0.58], [0.1, 0.62], [0, 0.62]],
  r: [...PLINTH, [0.3, 0.14], [0.255, 0.2], [0.225, 0.3], [0.21, 0.5], [0.22, 0.62], [0.25, 0.68], [0.3, 0.72], [0.34, 0.77], [0.345, 0.85], [0.32, 0.89], [0, 0.89]],
  b: [...PLINTH, [0.28, 0.14], [0.22, 0.19], [0.17, 0.27], [0.14, 0.4], [0.14, 0.5], [0.2, 0.535], [0.22, 0.565], [0.19, 0.595], [0.13, 0.62], [0.17, 0.67], [0.225, 0.76], [0.235, 0.88], [0.2, 1.0], [0.14, 1.1], [0.07, 1.18], [0, 1.22]],
  q: [...PLINTH, [0.3, 0.14], [0.235, 0.2], [0.18, 0.3], [0.15, 0.45], [0.16, 0.58], [0.225, 0.62], [0.245, 0.66], [0.21, 0.705], [0.15, 0.73], [0.17, 0.83], [0.225, 0.95], [0.28, 1.06], [0.315, 1.12], [0.33, 1.17], [0.29, 1.2], [0, 1.2]],
  k: [...PLINTH, [0.3, 0.14], [0.235, 0.2], [0.185, 0.3], [0.155, 0.46], [0.165, 0.62], [0.23, 0.66], [0.25, 0.7], [0.215, 0.745], [0.155, 0.77], [0.175, 0.88], [0.23, 1.0], [0.285, 1.1], [0.32, 1.16], [0.335, 1.21], [0.29, 1.24], [0, 1.24]],
  nbase: [...PLINTH, [0.31, 0.14], [0.27, 0.2], [0.27, 0.235], [0.3, 0.255], [0.28, 0.275], [0, 0.275]],
};

export const PIECE_HEIGHT = { p: 0.9, n: 1.2, b: 1.32, r: 1.02, q: 1.5, k: 1.78 };

function horseShape(points, offsetX = 0) {
  const v = points.map(([x, y]) => new THREE.Vector2(x + offsetX, y));
  const s = new THREE.Shape();
  s.moveTo(v[0].x, v[0].y);
  s.splineThru(v.slice(1));
  s.closePath();
  return s;
}

// Caballo estilo Staunton: cabeza, hocico, orejas, cuello arqueado y crin.
function horseGeometry() {
  const outline = [
    [-0.25, 0.26], [-0.27, 0.4], [-0.29, 0.56], [-0.25, 0.72], [-0.18, 0.86], [-0.11, 0.98], [-0.08, 1.1], [-0.02, 1.16], [0.03, 1.02],
    [0.1, 0.97], [0.19, 0.9], [0.28, 0.8], [0.37, 0.68], [0.43, 0.6], [0.44, 0.54], [0.4, 0.5], [0.32, 0.5], [0.23, 0.53], [0.17, 0.56],
    [0.2, 0.45], [0.25, 0.35], [0.24, 0.26],
  ];
  const geo = new THREE.ExtrudeGeometry(horseShape(outline, -0.05), {
    depth: 0.24, bevelEnabled: true, bevelThickness: 0.055, bevelSize: 0.05, bevelSegments: 6, curveSegments: 28,
  });
  geo.translate(0, 0, -0.12);
  geo.computeVertexNormals();
  return geo;
}

function maneGeometry() {
  const crest = [
    [-0.24, 0.3], [-0.31, 0.46], [-0.34, 0.62], [-0.3, 0.78], [-0.22, 0.92], [-0.14, 1.04], [-0.1, 1.12],
    [-0.08, 0.98], [-0.14, 0.84], [-0.2, 0.7], [-0.22, 0.54], [-0.2, 0.4],
  ];
  const geo = new THREE.ExtrudeGeometry(horseShape(crest, -0.05), {
    depth: 0.1, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 4, curveSegments: 24,
  });
  geo.translate(0, 0, -0.05);
  geo.computeVertexNormals();
  return geo;
}

const GEO = {};
const geo = (key, make) => (GEO[key] ??= make());
const lathe = (type) => geo(`lathe-${type}`, () => smoothLathe(PROFILES[type]));

// `mat` = material principal; `accent` = material de detalles (ojos, crin, hendidura).
function buildPiece(type, mat, accent, color) {
  const g = new THREE.Group();
  const add = (geometry, { x = 0, y = 0, z = 0, accented = false } = {}) => {
    const m = new THREE.Mesh(geometry, accented ? accent : mat);
    m.userData.accent = accented;
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const ring = (radius, tube, y, accented = false) => {
    const m = add(geo(`ring-${radius}-${tube}`, () => new THREE.TorusGeometry(radius, tube, 14, 56)), { y, accented });
    m.rotation.x = Math.PI / 2;
    return m;
  };
  const sphere = (r, y, x = 0, z = 0, accented = false) =>
    add(geo(`sph-${r}`, () => new THREE.SphereGeometry(r, 24, 16)), { x, y, z, accented });

  if (type === 'n') {
    add(lathe('nbase'));
    ring(0.285, 0.02, 0.265);
    const head = new THREE.Group();
    const addTo = (geometry, o = {}) => {
      const m = new THREE.Mesh(geometry, o.accented ? accent : mat);
      m.userData.accent = !!o.accented;
      m.position.set(o.x || 0, o.y || 0, o.z || 0);
      m.castShadow = true;
      head.add(m);
      return m;
    };
    addTo(geo('horse', horseGeometry));
    addTo(geo('mane', maneGeometry), { accented: true });
    const eye = geo('eye', () => new THREE.SphereGeometry(0.036, 14, 10));
    const nostril = geo('nostril', () => new THREE.SphereGeometry(0.026, 12, 8));
    for (const s of [-1, 1]) {
      addTo(eye, { x: 0.15, y: 0.84, z: s * 0.172, accented: true });
      addTo(nostril, { x: 0.385, y: 0.585, z: s * 0.16, accented: true });
    }
    head.rotation.y = color === 'w' ? Math.PI / 2 - 0.6 : -Math.PI / 2 + 0.6; // 3/4 hacia la cámara
    g.add(head);
    return g;
  }

  add(lathe(type));
  ring(0.285, 0.018, 0.135); // moldura sobre la peana

  if (type === 'p') {
    ring(0.2, 0.02, 0.5);
    sphere(0.185, 0.72);
  }
  if (type === 'r') {
    ring(0.235, 0.02, 0.69);
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const m = add(geo('merlon', () => new THREE.BoxGeometry(0.17, 0.16, 0.1)), { x: Math.cos(a) * 0.285, y: 0.97, z: Math.sin(a) * 0.285 });
      m.rotation.y = Math.PI / 2 - a;
    }
    add(geo('r-core', () => new THREE.CylinderGeometry(0.255, 0.255, 0.1, 40)), { y: 0.92, accented: true });
  }
  if (type === 'b') {
    ring(0.19, 0.022, 0.51);
    sphere(0.065, 1.255);
    const slit = add(geo('slit', () => new THREE.BoxGeometry(0.62, 0.032, 0.5)), { y: 0.93, accented: true });
    slit.rotation.z = -0.7;
    slit.castShadow = false;
  }
  if (type === 'q') {
    ring(0.22, 0.022, 0.6);
    const n = 9;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      const cone = add(geo('q-spike', () => new THREE.ConeGeometry(0.052, 0.2, 14)), { x: Math.cos(a) * 0.255, y: 1.28, z: Math.sin(a) * 0.255 });
      cone.rotation.set(Math.sin(a) * 0.18, 0, -Math.cos(a) * 0.18);
      sphere(0.045, 1.42, Math.cos(a) * 0.285, Math.sin(a) * 0.285);
    }
    add(geo('q-crown', () => new THREE.CylinderGeometry(0.27, 0.3, 0.07, 40)), { y: 1.215, accented: true });
    sphere(0.1, 1.3);
    sphere(0.055, 1.42);
  }
  if (type === 'k') {
    ring(0.225, 0.024, 0.65);
    add(geo('k-crown', () => new THREE.CylinderGeometry(0.28, 0.32, 0.07, 40)), { y: 1.26, accented: true });
    for (const rot of [0, Math.PI / 2]) {
      const arch = add(geo('k-arch', () => new THREE.TorusGeometry(0.26, 0.032, 12, 40, Math.PI)), { y: 1.28 });
      arch.rotation.y = rot;
    }
    sphere(0.08, 1.56);
    add(geo('k-v', () => new THREE.BoxGeometry(0.085, 0.3, 0.085)), { y: 1.7 });
    add(geo('k-h', () => new THREE.BoxGeometry(0.24, 0.08, 0.085)), { y: 1.74 });
  }
  return g;
}

// Asigna material principal / de detalle a todos los meshes de una pieza.
function skinPiece(group, mat, accent) {
  group.traverse((o) => {
    if (o.isMesh) o.material = o.userData.accent ? accent : mat;
  });
}

function accentSpec(spec) {
  const c = new THREE.Color(spec.color);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const accent = lum > 0.28 ? c.clone().multiplyScalar(0.2) : c.clone().multiplyScalar(2.6).lerp(new THREE.Color('#ffffff'), 0.25);
  return {
    color: `#${accent.getHexString()}`,
    roughness: 0.5,
    metalness: Math.min(spec.metalness ?? 0, 0.35),
    emissive: spec.emissive,
    emissiveIntensity: (spec.emissiveIntensity ?? 0) * 0.6,
  };
}

function pieceMaterial(spec) {
  return new THREE.MeshPhysicalMaterial({
    color: spec.color,
    roughness: spec.roughness ?? 0.4,
    metalness: spec.metalness ?? 0,
    emissive: spec.emissive ?? '#000000',
    emissiveIntensity: spec.emissiveIntensity ?? 0,
    clearcoat: spec.clearcoat ?? 0,
    clearcoatRoughness: 0.15,
    transparent: spec.opacity != null,
    opacity: spec.opacity ?? 1,
  });
}

// ---------- Vistas de cámara ----------
const PRESETS = {
  '3d': { el: 50, dist: 12.6, label: 'Vista 3D' },
  high: { el: 68, dist: 12.2, label: 'Vista alta' },
  top: { el: 87, dist: 11.4, label: 'Vista cenital' },
};
export const PRESET_ORDER = ['3d', 'high', 'top'];

export class Board3D {
  constructor({ thumb = false } = {}) {
    this.thumb = thumb;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: thumb, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, thumb ? 1.5 : 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'stage-canvas';

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
    this.cam = { az: 0, el: 50, dist: 12.6 };
    this.camGoal = { ...this.cam };
    this.preset = '3d';
    this.flipped = false;
    this.mode = 'play';
    this.orbit = 0;
    this.pointer = { x: 0, y: 0 };
    this.shakeAmt = 0;
    this.time = 0;
    this.tweens = [];
    this.pieces = new Map();
    this.placement = null;
    this.hover = null;
    this.selectedObj = null;
    this.interactive = true;
    this.onPick = null;
    this.pulses = [];
    this.hooks = new Set();
    this.skins = { set: 'classic', board: 'wood' };
    this.mat = {};
    this.tileMats = [];
    this.tiles = [];

    this.buildLights();
    this.buildBoard();
    this.buildHighlightKit();
    this.setSkins(this.skins);
    this.bindEvents();

    this.last = performance.now();
    if (!thumb) this.loop();
  }

  // ----- Escena -----
  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x30204a, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(-5.5, 11, 7);
    sun.castShadow = true;
    const size = window.innerWidth < 700 ? 1024 : 2048;
    sun.shadow.mapSize.set(size, size);
    Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
    this.scene.add(sun);
    this.rim = new THREE.PointLight(0xffb347, 40, 24, 1.6);
    this.rim.position.set(5, 3.2, -7);
    this.scene.add(this.rim);
  }

  buildBoard() {
    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);

    this.tileGroup = new THREE.Group();
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    for (let f = 0; f < 8; f += 1) {
      for (let r = 0; r < 8; r += 1) {
        const m = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial());
        m.rotation.x = -Math.PI / 2;
        m.position.set(f - 3.5, TILE_TOP, 3.5 - r);
        m.receiveShadow = true;
        m.userData.sq = `${FILES[f]}${r + 1}`;
        m.userData.dark = (f + r) % 2 === 0;
        m.userData.variant = (f * 7 + r * 3) % 3;
        this.tiles.push(m);
        this.tileGroup.add(m);
      }
    }
    this.boardGroup.add(this.tileGroup);

    this.slabMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    this.frameMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(8, 0.14, 8), this.slabMat);
    slab.position.y = -0.075;
    this.boardGroup.add(slab);
    const base = new THREE.Mesh(new THREE.BoxGeometry(9.7, 0.4, 9.7), this.frameMat);
    base.position.y = -0.34;
    base.castShadow = true;
    base.receiveShadow = true;
    this.boardGroup.add(base);
    const rimDefs = [
      [9.0, 0.2, 0.5, 0, 4.25],
      [9.0, 0.2, 0.5, 0, -4.25],
      [0.5, 0.2, 8.0, 4.25, 0],
      [0.5, 0.2, 8.0, -4.25, 0],
    ];
    for (const [w, h, d, x, z] of rimDefs) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.frameMat);
      m.position.set(x, -0.04, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.boardGroup.add(m);
    }

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.ShadowMaterial({ opacity: 0.38 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.55;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.glowMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(22, 22), this.glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.54;
    this.scene.add(glow);

    this.labels = [];
    for (let i = 0; i < 8; i += 1) {
      this.labels.push({ kind: 'f', i, spr: null }, { kind: 'r', i, spr: null });
    }
    this.piecesGroup = new THREE.Group();
    this.scene.add(this.piecesGroup);
  }

  buildHighlightKit() {
    this.hlGroup = new THREE.Group();
    this.scene.add(this.hlGroup);
    const mk = (color, opacity) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.hlMats = {
      selected: mk('#4cd6ff', 0.5),
      last: mk('#ffd84a', 0.34),
      check: mk('#ff2a45', 0.55),
      hint: mk('#4dffa8', 0.55),
      hover: mk('#ffffff', 0.18),
      dot: mk('#ffffff', 0.62),
      ring: mk('#ff4d6a', 0.85),
    };
    this.hlGeo = {
      plane: new THREE.PlaneGeometry(0.98, 0.98),
      dot: new THREE.CircleGeometry(0.17, 28),
      ring: new THREE.RingGeometry(0.34, 0.44, 40),
    };
  }

  // ----- Skins -----
  setSkins({ set, board }) {
    if (set) this.skins.set = set;
    if (board) this.skins.board = board;
    const spec = SETS[this.skins.set] || SETS.classic;
    this.accent = this.accent || {};
    for (const c of ['w', 'b']) {
      this.mat[c]?.dispose();
      this.accent[c]?.dispose();
      this.mat[c] = pieceMaterial(spec[c]);
      this.accent[c] = pieceMaterial(accentSpec(spec[c]));
    }
    this.piecesGroup.children.forEach((grp) => skinPiece(grp, this.mat[grp.userData.color], this.accent[grp.userData.color]));

    const skin = BOARDS[this.skins.board] || BOARDS.wood;
    for (const m of this.tileMats) {
      m.map?.dispose();
      m.emissiveMap?.dispose();
      m.dispose();
    }
    this.tileMats = { light: [], dark: [] };
    for (let v = 0; v < 3; v += 1) {
      this.tileMats.light.push(tileMaterial(skin, false, 101 + v * 17));
      this.tileMats.dark.push(tileMaterial(skin, true, 211 + v * 29));
    }
    for (const t of this.tiles) t.material = (t.userData.dark ? this.tileMats.dark : this.tileMats.light)[t.userData.variant];
    this.tileMats = [...this.tileMats.light, ...this.tileMats.dark];

    this.frameMat.color.set(skin.frame);
    this.slabMat.color.set(skin.side);
    this.glowMat.map?.dispose();
    this.glowMat.map = glowTexture(skin.glow);
    this.glowMat.needsUpdate = true;
    this.rim.color.set(skin.glow);
    this.labelColor = skin.label;
    this.rebuildLabels();
  }

  rebuildLabels() {
    for (const l of this.labels) {
      if (l.spr) {
        this.boardGroup.remove(l.spr);
        l.spr.material.map.dispose();
        l.spr.material.dispose();
      }
      l.spr = labelSprite(l.kind === 'f' ? FILES[l.i] : String(l.i + 1), this.labelColor);
      this.boardGroup.add(l.spr);
    }
    this.placeLabels();
  }

  placeLabels() {
    for (const l of this.labels) {
      if (l.kind === 'f') l.spr.position.set(l.i - 3.5, 0.1, this.flipped ? -4.28 : 4.28);
      else l.spr.position.set(this.flipped ? 4.28 : -4.28, 0.1, 3.5 - l.i);
    }
  }

  // ----- Piezas -----
  clearPieces() {
    for (const p of this.pieces.values()) this.piecesGroup.remove(p.group);
    this.pieces.clear();
    this.selectedObj = null;
  }

  spawn(type, color, sq) {
    const group = buildPiece(type, this.mat[color], this.accent[color], color);
    group.userData.color = color;
    const { x, z } = sqXZ(sq);
    group.position.set(x, TILE_TOP, z);
    const obj = { group, type, color, sq, busy: 0, targetY: TILE_TOP };
    group.userData.ref = obj;
    this.piecesGroup.add(group);
    this.pieces.set(sq, obj);
    return obj;
  }

  setPosition(chess) {
    this.clearPieces();
    for (const row of chess.board()) {
      for (const p of row) if (p) this.spawn(p.type, p.color, p.square);
    }
    this.placement = chess.fen().split(' ')[0];
  }

  tween(dur, fn, ease = easeInOut) {
    return new Promise((resolve) => {
      this.tweens.push({ t: 0, dur, fn, ease, resolve });
    });
  }

  async hopTo(obj, to, { jump = false, delay = 0, onProgress } = {}) {
    const from = { x: obj.group.position.x, z: obj.group.position.z };
    const dest = sqXZ(to);
    const dist = Math.hypot(dest.x - from.x, dest.z - from.z);
    const dur = 0.3 + Math.min(dist, 6) * 0.045 + (jump ? 0.12 : 0);
    const lift = jump ? 1.15 : 0.42;
    obj.busy += 1;
    if (delay) await this.tween(delay, () => {}, (p) => p);
    await this.tween(dur, (p) => {
      obj.group.position.x = lerp(from.x, dest.x, p);
      obj.group.position.z = lerp(from.z, dest.z, p);
      obj.group.position.y = TILE_TOP + Math.sin(Math.PI * p) * lift;
      obj.group.rotation.z = Math.sin(Math.PI * p) * 0.1 * Math.sign(dest.x - from.x || 1) * (jump ? 1.6 : 0.6);
      onProgress?.(p);
    });
    obj.group.rotation.z = 0;
    obj.group.position.set(dest.x, TILE_TOP, dest.z);
    // pequeño rebote al aterrizar
    await this.tween(0.16, (p) => {
      const squash = Math.sin(Math.PI * p) * 0.08;
      obj.group.scale.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6);
    });
    obj.group.scale.set(1, 1, 1);
    obj.busy -= 1;
  }

  knockOut(obj) {
    const g = obj.group;
    const start = g.position.clone();
    const spin = (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 2);
    const dir = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(1.4);
    this.tween(0.55, (p) => {
      g.position.set(start.x + dir.x * p, TILE_TOP + Math.sin(Math.PI * Math.min(1, p * 1.2)) * 1.3, start.z + dir.z * p);
      g.rotation.set(spin * p * 0.6, spin * p, spin * p * 0.5);
      const s = 1 - easeOut(Math.max(0, p - 0.35) / 0.65);
      g.scale.setScalar(Math.max(0.001, s));
    }, (p) => p).then(() => this.piecesGroup.remove(g));
  }

  ringFlash(sq, color = '#ffd24a') {
    const { x, z } = sqXZ(sq);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 48), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.03, z);
    this.scene.add(ring);
    this.tween(0.7, (p) => {
      ring.scale.setScalar(1 + p * 4.2);
      mat.opacity = 0.9 * (1 - p);
    }, easeOut).then(() => {
      this.scene.remove(ring);
      ring.geometry.dispose();
      mat.dispose();
    });
  }

  async applyMove(move, chess) {
    const obj = this.pieces.get(move.from);
    if (!obj) {
      this.setPosition(chess);
      return;
    }
    const epSq = move.flags.includes('e') ? move.to[0] + move.from[1] : move.to;
    const victim = move.captured ? this.pieces.get(epSq) : null;
    if (victim) this.pieces.delete(epSq);
    this.pieces.delete(move.from);
    this.pieces.set(move.to, obj);
    obj.sq = move.to;
    if (this.selectedObj === obj) this.selectedObj = null;
    obj.targetY = TILE_TOP;

    const jobs = [];
    let victimGone = false;
    jobs.push(
      this.hopTo(obj, move.to, {
        jump: obj.type === 'n',
        onProgress: (p) => {
          if (victim && !victimGone && p > 0.78) {
            victimGone = true;
            this.knockOut(victim);
            this.shakeAmt = Math.max(this.shakeAmt, move.captured === 'p' ? 0.1 : 0.2);
          }
        },
      }),
    );
    if (move.flags.includes('k') || move.flags.includes('q')) {
      const rank = move.color === 'w' ? '1' : '8';
      const [rf, rt] = move.flags.includes('k') ? [`h${rank}`, `f${rank}`] : [`a${rank}`, `d${rank}`];
      const rook = this.pieces.get(rf);
      if (rook) {
        this.pieces.delete(rf);
        this.pieces.set(rt, rook);
        rook.sq = rt;
        jobs.push(this.hopTo(rook, rt, { jump: false, delay: 0.08 }));
      }
    }
    await Promise.all(jobs);

    if (move.promotion) {
      this.piecesGroup.remove(obj.group);
      this.pieces.delete(move.to);
      const np = this.spawn(move.promotion, move.color, move.to);
      np.group.scale.setScalar(0.01);
      this.ringFlash(move.to);
      np.busy += 1;
      await this.tween(0.55, (p) => np.group.scale.setScalar(Math.max(0.01, p)), easeOutBack);
      np.group.scale.setScalar(1);
      np.busy -= 1;
    }
  }

  // ----- Eventos de partida (tipo "juice") -----
  kingAt(sq) {
    return this.pieces.get(sq);
  }

  checkShake(sq) {
    const k = this.kingAt(sq);
    if (!k) return;
    k.busy += 1;
    this.tween(0.6, (p) => {
      k.group.rotation.z = Math.sin(p * 38) * 0.16 * (1 - p);
    }, (p) => p).then(() => {
      k.group.rotation.z = 0;
      k.busy -= 1;
    });
    this.ringFlash(sq, '#ff3355');
  }

  checkmate(sq) {
    const k = this.kingAt(sq);
    if (!k) return;
    k.busy += 1;
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.shakeAmt = 0.35;
    this.ringFlash(sq, '#ff3355');
    this.tween(0.9, (p) => {
      k.group.rotation.z = -dir * (Math.PI / 2) * easeOutBack(Math.min(1, p * 1.05)) * 0.98;
      k.group.position.y = TILE_TOP + Math.sin(Math.PI * Math.min(1, p * 2)) * 0.1;
    }, (p) => p);
  }

  // La pieza "habla": pequeños saltitos y un destello en su casilla.
  talk(obj) {
    if (!obj || !obj.group.parent) return;
    obj.busy += 1;
    this.ringFlash(obj.sq, '#ffe08a');
    this.tween(0.75, (p) => {
      const k = Math.abs(Math.sin(p * Math.PI * 3)) * (1 - p);
      obj.group.position.y = TILE_TOP + k * 0.24;
      obj.group.rotation.z = Math.sin(p * Math.PI * 6) * 0.06 * (1 - p);
    }, (p) => p).then(() => {
      obj.group.position.y = TILE_TOP;
      obj.group.rotation.z = 0;
      obj.busy -= 1;
    });
  }

  addHook(fn) {
    this.hooks.add(fn);
  }

  removeHook(fn) {
    this.hooks.delete(fn);
  }

  // Posición en píxeles de la coronilla de una pieza (para globos de diálogo).
  projectObj(obj) {
    const v = obj.group.position.clone();
    v.y += PIECE_HEIGHT[obj.type] + 0.1;
    v.project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * this.canvas.clientHeight };
  }

  impact(amount = 0.15) {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  // ----- Resaltados -----
  highlight({ selected, targets = [], lastMove, checkSq, hintMove, interactive }) {
    this.interactive = interactive ?? true;
    while (this.hlGroup.children.length) this.hlGroup.remove(this.hlGroup.children[0]);
    this.pulses = [];
    const put = (geometry, mat, sq, y) => {
      const m = new THREE.Mesh(geometry, mat);
      const { x, z } = sqXZ(sq);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      m.renderOrder = 2;
      this.hlGroup.add(m);
      return m;
    };
    if (lastMove) {
      put(this.hlGeo.plane, this.hlMats.last, lastMove.from, 0.008);
      put(this.hlGeo.plane, this.hlMats.last, lastMove.to, 0.008);
    }
    if (hintMove) {
      put(this.hlGeo.plane, this.hlMats.hint, hintMove.from, 0.012);
      put(this.hlGeo.plane, this.hlMats.hint, hintMove.to, 0.012);
    }
    if (checkSq) put(this.hlGeo.plane, this.hlMats.check, checkSq, 0.014);
    if (selected) put(this.hlGeo.plane, this.hlMats.selected, selected, 0.016);
    for (const m of targets) {
      if (m.captured) put(this.hlGeo.ring, this.hlMats.ring, m.to, 0.02);
      else put(this.hlGeo.dot, this.hlMats.dot, m.to, 0.02);
    }
    if (this.hover && this.interactive) put(this.hlGeo.plane, this.hlMats.hover, this.hover, 0.006);
    this.hlState = { selected, targets, lastMove, checkSq, hintMove };

    const next = selected ? this.pieces.get(selected) : null;
    if (this.selectedObj && this.selectedObj !== next) this.selectedObj.targetY = TILE_TOP;
    this.selectedObj = next || null;
    if (next) next.targetY = 0.2;
  }

  // Punto de entrada único desde Game.
  update({ chess, selected, targets, lastMove, hintMove, checkSq, move, interactive }) {
    const placement = chess.fen().split(' ')[0];
    if (move) {
      this.placement = placement;
      this.applyMove(move, chess);
    } else if (placement !== this.placement) {
      this.setPosition(chess);
    }
    this.highlight({ selected, targets, lastMove, checkSq, hintMove, interactive });
  }

  // ----- Cámara -----
  setFlipped(flipped) {
    this.flipped = flipped;
    this.camGoal.az = flipped ? 180 : 0;
    this.placeLabels();
  }

  setPreset(name) {
    this.preset = name;
    this.camGoal.el = PRESETS[name].el;
    this.camGoal.dist = PRESETS[name].dist;
    this.fit();
    return PRESETS[name].label;
  }

  cyclePreset() {
    const next = PRESET_ORDER[(PRESET_ORDER.indexOf(this.preset) + 1) % PRESET_ORDER.length];
    return this.setPreset(next);
  }

  setMode(mode) {
    this.mode = mode;
    this.orbit = mode === 'showcase' ? 1 : 0;
    if (mode === 'showcase') {
      this.camGoal.el = 36;
      this.camGoal.dist = 15;
      this.interactive = false;
    } else {
      this.cam.az = ((this.cam.az % 360) + 360) % 360;
      this.camGoal.az = this.flipped ? 180 : 0;
      this.setPreset(this.preset);
    }
  }

  fit() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    const aspect = w / h;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const el = THREE.MathUtils.degToRad(this.camGoal.el);
    const needW = 10.6 / 2 / Math.tan(hfov / 2);
    const needH = (9.8 * Math.sin(el) + 2.4 * Math.cos(el) + 1.2) / 2 / Math.tan(vfov / 2);
    const base = this.mode === 'showcase' ? 15 : PRESETS[this.preset].dist;
    this.camGoal.dist = Math.max(base, needW * 1.04, needH * 1.0);
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fit();
  }

  mount(container) {
    if (this.canvas.parentElement !== container) container.prepend(this.canvas);
    this.resize();
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
  }

  // Posición en píxeles (relativa al canvas) de una casilla, para partículas DOM.
  project(sq, y = 0.4) {
    const { x, z } = sqXZ(sq);
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * this.canvas.clientHeight };
  }

  // ----- Entrada -----
  bindEvents() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const sqAt = (e) => {
      const r = this.canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hits = ray.intersectObjects([this.piecesGroup, this.tileGroup], true);
      for (const h of hits) {
        let o = h.object;
        while (o) {
          if (o.userData.sq) return o.userData.sq;
          if (o.userData.ref) return o.userData.ref.sq;
          o = o.parent;
        }
      }
      return null;
    };
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || !this.interactive || this.mode !== 'play') return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 10) return;
      const sq = sqAt(e);
      if (sq) this.onPick?.(sq);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
      if (e.pointerType !== 'mouse' || this.mode !== 'play') return;
      const sq = sqAt(e);
      if (sq !== this.hover) {
        this.hover = sq;
        this.canvas.style.cursor = sq && this.interactive ? 'pointer' : 'default';
        if (this.hlState) this.highlight({ ...this.hlState, interactive: this.interactive });
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pointer.x = 0;
      this.pointer.y = 0;
      if (this.hover) {
        this.hover = null;
        if (this.hlState) this.highlight({ ...this.hlState, interactive: this.interactive });
      }
    });
  }

  // ----- Bucle -----
  frame(dt) {
    this.time += dt;
    // tweens
    for (let i = this.tweens.length - 1; i >= 0; i -= 1) {
      const tw = this.tweens[i];
      tw.t += dt;
      const p = Math.min(1, tw.t / tw.dur);
      tw.fn(tw.ease(p));
      if (p >= 1) {
        this.tweens.splice(i, 1);
        tw.resolve();
      }
    }
    // piezas: levantar la seleccionada y asentar el resto
    for (const obj of this.pieces.values()) {
      if (obj.busy > 0) continue;
      const bob = obj === this.selectedObj ? Math.sin(this.time * 4.5) * 0.035 : 0;
      obj.group.position.y += (obj.targetY + bob - obj.group.position.y) * Math.min(1, dt * 14);
    }
    // pulsos
    this.hlMats.check.opacity = 0.35 + 0.25 * Math.sin(this.time * 6);
    this.hlMats.hint.opacity = 0.35 + 0.25 * Math.sin(this.time * 5);
    this.hlMats.selected.opacity = 0.42 + 0.1 * Math.sin(this.time * 4);

    // cámara
    const c = this.cam;
    const g = this.camGoal;
    if (this.orbit) g.az += dt * 9;
    const k = Math.min(1, dt * 4.2);
    let daz = ((g.az - c.az + 540) % 360) - 180;
    c.az += daz * k;
    c.el += (g.el - c.el) * k;
    c.dist += (g.dist - c.dist) * k;
    this.shakeAmt *= Math.pow(0.02, dt);
    const az = THREE.MathUtils.degToRad(c.az + this.pointer.x * 3.5);
    const el = THREE.MathUtils.degToRad(c.el - this.pointer.y * 1.5);
    const sx = (Math.random() - 0.5) * this.shakeAmt;
    const sy = (Math.random() - 0.5) * this.shakeAmt;
    const cosEl = Math.cos(el);
    this.camera.position.set(Math.sin(az) * cosEl * c.dist + sx, Math.sin(el) * c.dist + sy, Math.cos(az) * cosEl * c.dist);
    this.camera.lookAt(0, 0.15, 0);
    this.camera.updateMatrixWorld();
    for (const hook of this.hooks) hook();
    this.renderer.render(this.scene, this.camera);
  }

  loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (document.hidden || !this.canvas.isConnected || !this.canvas.clientWidth) return;
      this.frame(dt);
    };
    tick();
  }

  // Captura del fotograma actual (render inmediato para poder leer el canvas sin preserveDrawingBuffer).
  captureImage() {
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  // Imagen estática (miniaturas de la tienda).
  snapshot(w, h, { preset = '3d' } = {}) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    Object.assign(this.cam, { az: 0, el: PRESETS[preset].el, dist: 12.6 });
    this.camGoal = { ...this.cam };
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.pointer = { x: 0, y: 0 };
    this.shakeAmt = 0;
    const az = 0;
    const el = THREE.MathUtils.degToRad(this.cam.el);
    this.camera.position.set(0, Math.sin(el) * 13, Math.cos(el) * 13 + 0.3);
    this.camera.lookAt(0, 0.2, 0.3);
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
}
