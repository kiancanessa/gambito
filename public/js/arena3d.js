// Arena 3D del lobby: plataforma central con tu pieza-avatar, tableros flotantes, pilares, arco y partículas.
// Es decoración viva, no un mundo que explorar: la cámara apenas se mueve y no hay nada con lo que interactuar.
//
// Recursos (todo se carga bajo demanda desde lobby.js con import()):
//  - un solo renderizador, píxel ratio ≤ 1,5 (1 en calidad baja) y sin sombras;
//  - las geometrías de la pieza se comparten con el tablero y NO se liberan aquí; lo demás se libera en dispose();
//  - el bucle solo corre con el lobby visible y la pestaña activa; mide su propio rendimiento y, si va justo, baja la calidad
//    y, si sigue mal, se apaga y avisa con onFail() para quedarse con la arena 2D;
//  - con movimiento reducido se dibuja un único fotograma (y otro al redimensionar o cambiar de avatar).
import * as THREE from 'three';
import { createAvatarPiece } from './board3d.js';

const CYAN = 0x22e1ff;
const VIOLET = 0x8b5cf6;
const AVATAR_HEIGHT = 2.5;

export class Arena3D {
  /**
   * @param {HTMLElement} host           contenedor del canvas
   * @param {object} o
   * @param {{type:string,color:string}} o.avatar   pieza y color de liga
   * @param {boolean} o.animate          false = un solo fotograma
   * @param {() => void} o.onFail        el 3D no funciona (contexto perdido o equipo lento)
   */
  constructor(host, { avatar, animate = true, onFail = () => {} }) {
    this.host = host;
    this.animate = animate;
    this.onFail = onFail;
    this.disposables = [];
    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.t = 0;
    this.quality = 'high';
    this.frames = { n: 0, sum: 0 };
    this.pointer = { x: 0, y: 0, sx: 0, sy: 0 };
    this.size = { w: 0, h: 0 };
    this.disposed = false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'default' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'arena-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.append(this.canvas);
    this.setPixelRatio(1.5);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 90);
    this.buildLights();
    this.buildPlatform();
    this.buildFloating();
    this.buildArchitecture();
    this.buildParticles();
    this.setAvatar(avatar);

    this.onLost = (e) => {
      e.preventDefault();
      this.fail();
    };
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    this.onMove = (e) => {
      const r = this.host.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
    };
    if (animate) window.addEventListener('pointermove', this.onMove, { passive: true });
    this.onVisibility = () => (document.hidden ? this.pause() : this.start());
    document.addEventListener('visibilitychange', this.onVisibility);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  // ----- Construcción -----
  track(obj) {
    this.disposables.push(obj);
    return obj;
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x0b0d14, 0.55));
    const key = new THREE.DirectionalLight(CYAN, 1.5);
    key.position.set(-5, 8, 5);
    const rim = new THREE.DirectionalLight(VIOLET, 1.3);
    rim.position.set(6, 4, -4);
    const front = new THREE.DirectionalLight(0xffffff, 1.1); // luz de frente: que el avatar se lea bien
    front.position.set(0, 4, 12);
    this.scene.add(front);
    const under = new THREE.PointLight(CYAN, 18, 12, 2);
    under.position.set(0, -0.6, 0);
    this.under = under;
    this.scene.add(key, rim, under);
  }

  buildPlatform() {
    const g = new THREE.Group();
    this.platform = g;
    this.scene.add(g);

    const baseGeo = this.track(new THREE.CylinderGeometry(4.35, 4.6, 0.5, 72));
    const baseMat = this.track(new THREE.MeshStandardMaterial({ color: 0x10131a, metalness: 0.75, roughness: 0.34 }));
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = -0.28;
    g.add(base);

    // Tablero 8×8 en una sola malla instanciada
    const sq = 0.74;
    const tileGeo = this.track(new THREE.BoxGeometry(sq - 0.03, 0.1, sq - 0.03));
    const tileMat = this.track(new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.4, roughness: 0.45 }));
    const tiles = new THREE.InstancedMesh(tileGeo, tileMat, 64);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < 64; i += 1) {
      const x = (i % 8) - 3.5;
      const z = Math.floor(i / 8) - 3.5;
      m.setPosition(x * sq, 0, z * sq);
      tiles.setMatrixAt(i, m);
      tiles.setColorAt(i, c.set((x + z) % 2 === 0 ? 0x2b3140 : 0x151922));
    }
    tiles.instanceMatrix.needsUpdate = true;
    tiles.position.y = 0.02;
    g.add(tiles);

    // Anillos de energía
    const ringMat = this.track(new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.9 }));
    const ring = new THREE.Mesh(this.track(new THREE.TorusGeometry(4.4, 0.035, 10, 120)), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.02;
    this.ring = ring;
    const ring2Mat = this.track(new THREE.MeshBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.55 }));
    const ring2 = new THREE.Mesh(this.track(new THREE.TorusGeometry(5.05, 0.02, 8, 120)), ring2Mat);
    ring2.rotation.x = Math.PI / 2;
    ring2.position.y = -0.3;
    g.add(ring, ring2);

    // Anillo de segmentos que gira despacio
    const seg = new THREE.Group();
    const segGeo = this.track(new THREE.BoxGeometry(0.5, 0.05, 0.12));
    const segMat = this.track(new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.7 }));
    for (let i = 0; i < 40; i += 1) {
      const a = (i / 40) * Math.PI * 2;
      const b = new THREE.Mesh(segGeo, segMat);
      b.position.set(Math.cos(a) * 5.6, -0.4, Math.sin(a) * 5.6);
      b.rotation.y = -a;
      seg.add(b);
    }
    this.segments = seg;
    g.add(seg);

    // Suelo con degradado radial (ancla visualmente la plataforma)
    const floorTex = this.track(this.radialTexture('rgba(34,225,255,0.22)', 'rgba(34,225,255,0)'));
    const floor = new THREE.Mesh(this.track(new THREE.PlaneGeometry(22, 22)), this.track(new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.62;
    this.scene.add(floor);
  }

  radialTexture(inner, outer) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, outer);
    x.fillStyle = gr;
    x.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  checkerTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const x = c.getContext('2d');
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        x.fillStyle = (i + j) % 2 ? '#10131a' : '#2f3647';
        x.fillRect(i * 16, j * 16, 16, 16);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    return t;
  }

  buildFloating() {
    const tex = this.track(this.checkerTexture());
    const side = this.track(new THREE.MeshStandardMaterial({ color: 0x151922, metalness: 0.7, roughness: 0.4 }));
    const top = this.track(new THREE.MeshStandardMaterial({ map: tex, metalness: 0.35, roughness: 0.5 }));
    const geo = this.track(new THREE.BoxGeometry(1.5, 0.09, 1.5));
    const edgeGeo = this.track(new THREE.EdgesGeometry(geo));
    const cyanEdge = this.track(new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.8 }));
    const violetEdge = this.track(new THREE.LineBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.8 }));
    this.floating = [];
    const defs = [
      // Ángulos en el semicírculo trasero (z < 0): los tableros flotan detrás de la plataforma y nunca tapan al avatar.
      { r: 7.6, a: Math.PI * 1.1, y: 2.6, s: 0.9, sp: 0.05, piece: ['n', '#e8edf5'] },
      { r: 6.8, a: Math.PI * 1.3, y: 4.3, s: 1.15, sp: -0.04, piece: null },
      { r: 8.4, a: Math.PI * 1.5, y: 1.8, s: 0.8, sp: 0.06, piece: ['r', '#6b7488'] },
      { r: 7.4, a: Math.PI * 1.65, y: 3.9, s: 1.0, sp: -0.05, piece: null },
      { r: 8.0, a: Math.PI * 1.85, y: 2.5, s: 0.85, sp: 0.045, piece: ['p', '#e8edf5'] },
      { r: 9.2, a: Math.PI * 1.2, y: 1.2, s: 1.0, sp: -0.035, piece: null },
    ];
    defs.forEach((d, i) => {
      const grp = new THREE.Group();
      const slab = new THREE.Mesh(geo, [side, side, top, side, side, side]);
      grp.add(slab, new THREE.LineSegments(edgeGeo, i % 2 ? violetEdge : cyanEdge));
      if (d.piece) {
        const p = createAvatarPiece(d.piece[0], d.piece[1]);
        const k = 0.95 / p.userData.height;
        p.scale.setScalar(k);
        p.position.y = 0.05;
        grp.add(p);
        this.disposables.push({ dispose: () => p.userData.dispose() });
      }
      grp.scale.setScalar(d.s);
      grp.userData = { ...d, phase: i * 1.3 };
      this.scene.add(grp);
      this.floating.push(grp);
    });
  }

  buildArchitecture() {
    const pillarGeo = this.track(new THREE.BoxGeometry(0.55, 8, 0.55));
    const pillarMat = this.track(new THREE.MeshStandardMaterial({ color: 0x0d1016, metalness: 0.8, roughness: 0.35 }));
    const stripGeo = this.track(new THREE.BoxGeometry(0.08, 7.4, 0.08));
    const stripCyan = this.track(new THREE.MeshBasicMaterial({ color: CYAN }));
    const stripViolet = this.track(new THREE.MeshBasicMaterial({ color: VIOLET }));
    for (let i = 0; i < 7; i += 1) {
      const a = Math.PI * (1.12 + (i / 6) * 0.76); // arco detrás de la plataforma
      const r = 12;
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set(Math.cos(a) * r, 3.2, Math.sin(a) * r);
      const strip = new THREE.Mesh(stripGeo, i % 2 ? stripViolet : stripCyan);
      strip.position.set(0, 0, 0.29);
      strip.rotation.y = 0;
      p.rotation.y = -a + Math.PI / 2;
      p.add(strip);
      this.scene.add(p);
    }
    const archMat = this.track(new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.55 }));
    this.arch = new THREE.Mesh(this.track(new THREE.TorusGeometry(8.4, 0.05, 8, 160)), archMat);
    this.arch.position.set(0, 4.2, -9.5);
    const arch2Mat = this.track(new THREE.MeshBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.4 }));
    this.arch2 = new THREE.Mesh(this.track(new THREE.TorusGeometry(6.8, 0.035, 8, 140)), arch2Mat);
    this.arch2.position.set(0, 4.2, -9.4);
    this.scene.add(this.arch, this.arch2);
  }

  buildParticles() {
    const n = 140;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    this.speeds = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 10;
      pos.set([Math.cos(a) * r, Math.random() * 8 - 0.5, Math.sin(a) * r], i * 3);
      c.set(Math.random() > 0.5 ? CYAN : VIOLET);
      col.set([c.r, c.g, c.b], i * 3);
      this.speeds[i] = 0.12 + Math.random() * 0.3;
    }
    const geo = this.track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = this.track(new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
  }

  // ----- Avatar -----
  setAvatar({ type, color }) {
    if (this.avatar) {
      this.platform.remove(this.avatar);
      this.avatar.userData.dispose?.();
    }
    if (this.halo) {
      this.platform.remove(this.halo);
      this.halo.material.map.dispose();
      this.halo.material.dispose();
      this.halo.geometry.dispose();
    }
    const piece = createAvatarPiece(type, color);
    piece.scale.setScalar(AVATAR_HEIGHT / piece.userData.height);
    piece.position.y = 0.07;
    this.avatar = piece;
    this.platform.add(piece);
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(2.2, 48),
      new THREE.MeshBasicMaterial({ map: this.radialTexture(`${color}cc`, `${color}00`), transparent: true, depthWrite: false }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.09;
    this.halo = halo;
    this.platform.add(halo);
    this.under.color.set(color);
    if (!this.running) this.renderFrame();
  }

  // ----- Tamaño y calidad -----
  setPixelRatio(max) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, max));
  }

  resize() {
    if (this.disposed) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // En pantallas estrechas se aleja la cámara para que quepa toda la plataforma.
    this.camDist = THREE.MathUtils.clamp(14.5 / Math.min(1.25, this.camera.aspect), 13, 26);
    this.camera.updateProjectionMatrix();
    this.placeCamera(0);
    if (!this.running) this.renderFrame();
  }

  placeCamera(dt) {
    const k = dt ? 1 - Math.exp(-dt * 3) : 1;
    this.pointer.sx += (this.pointer.x - this.pointer.sx) * k;
    this.pointer.sy += (this.pointer.y - this.pointer.sy) * k;
    const d = this.camDist ?? 15;
    this.camera.position.set(this.pointer.sx * 1.1, 4.6 + d * 0.12 - this.pointer.sy * 0.5, d);
    this.camera.lookAt(0, 0.25, 0); // apunta algo por debajo del avatar: la escena queda en la mitad alta, sobre el dock
  }

  // ----- Bucle -----
  start() {
    if (this.disposed || this.running) return;
    if (!this.animate) {
      this.renderFrame();
      return;
    }
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  tick(now) {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.watchPerformance(dt);
    if (!this.running) return;
    this.update(dt);
    this.renderFrame();
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  // Si tras ~2 s el fotograma medio es lento, baja la calidad; si sigue lento, se apaga.
  watchPerformance(dt) {
    this.frames.n += 1;
    this.frames.sum += dt;
    if (this.frames.n < 90) return;
    const avg = this.frames.sum / this.frames.n;
    this.frames = { n: 0, sum: 0 };
    if (avg > 0.075) return this.fail();
    if (avg > 0.036 && this.quality === 'high') {
      this.quality = 'low';
      this.setPixelRatio(1);
      this.particles.visible = false;
      this.renderer.setSize(this.size.w, this.size.h, false);
    }
    return undefined;
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    this.avatar.rotation.y = Math.sin(t * 0.5) * 0.5;
    this.avatar.position.y = 0.07 + Math.sin(t * 1.4) * 0.04;
    this.halo.material.opacity = 0.75 + Math.sin(t * 2) * 0.2;
    this.ring.material.opacity = 0.65 + Math.sin(t * 1.8) * 0.3;
    this.under.intensity = 16 + Math.sin(t * 1.8) * 5;
    this.segments.rotation.y += dt * 0.12;
    this.arch.rotation.z += dt * 0.03;
    this.arch2.rotation.z -= dt * 0.045;
    for (const f of this.floating) {
      const d = f.userData;
      const a = d.a + Math.sin(t * d.sp * 4 + d.phase) * 0.28; // vaivén suave sobre su arco
      f.position.set(Math.cos(a) * d.r, d.y + Math.sin(t * 0.8 + d.phase) * 0.22, Math.sin(a) * d.r);
      f.rotation.y = a * 0.6;
      f.rotation.z = Math.sin(t * 0.5 + d.phase) * 0.08;
    }
    if (this.particles.visible) {
      const p = this.particles.geometry.attributes.position;
      for (let i = 0; i < p.count; i += 1) {
        let y = p.getY(i) + this.speeds[i] * dt;
        if (y > 8) y = -0.5;
        p.setY(i, y);
      }
      p.needsUpdate = true;
    }
    this.placeCamera(dt);
  }

  renderFrame() {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  fail() {
    if (this.disposed) return;
    this.pause();
    this.onFail();
  }

  // Cifras para comprobar que no se acumulan recursos.
  stats() {
    const i = this.renderer.info;
    return { geometries: i.memory.geometries, textures: i.memory.textures, calls: i.render.calls, quality: this.quality, running: this.running, animate: this.animate };
  }

  dispose() {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    window.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.ro.disconnect();
    this.avatar.userData.dispose?.();
    this.halo.material.map.dispose();
    this.halo.material.dispose();
    this.halo.geometry.dispose();
    for (const d of this.disposables) d.dispose?.();
    this.scene.environment?.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
