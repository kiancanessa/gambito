// Genera los iconos PNG de la app (peón blanco/cian sobre obsidiana) sin dependencias: SDF + zlib.
// Uso: node scripts/make-icons.js   → public/icons/icon-192.png, icon-512.png, icon-maskable-512.png, og.png
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// --- PNG mínimo (RGBA 8 bits) ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// --- Geometría (SDF) del peón en coordenadas -0.5..0.5 ---
const length = (x, y) => Math.hypot(x, y);
const sdCircle = (x, y, cx, cy, r) => length(x - cx, y - cy) - r;
const sdEllipse = (x, y, cx, cy, rx, ry) => (length((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
function sdRoundCone(x, y, y1, r1, y2, r2) {
  // aproximación: radio interpolado a lo largo del eje vertical
  const t = Math.min(1, Math.max(0, (y - y1) / (y2 - y1)));
  const r = r1 + (r2 - r1) * t;
  return length(x, y - (y1 + (y2 - y1) * t)) - r;
}
const sdRoundBox = (x, y, cx, cy, hx, hy, r) => {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  return length(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const pawn = (x, y) =>
  Math.min(
    sdCircle(x, y, 0, -0.19, 0.115),
    sdEllipse(x, y, 0, -0.065, 0.125, 0.03),
    sdRoundCone(x, y, -0.07, 0.07, 0.2, 0.15),
    sdRoundBox(x, y, 0, 0.255, 0.21, 0.05, 0.045),
  );

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Dibuja el icono en un lienzo w×h; `scale` = tamaño del peón respecto al lado menor; `round` = esquinas redondeadas.
function render(w, h, { scale, round, cx = 0.5, cy = 0.5 }) {
  const buf = Buffer.alloc(w * h * 4);
  const SS = 3;
  const top = hex('#161b27');
  const bottom = hex('#05060a');
  const gold1 = hex('#ffffff');
  const gold2 = hex('#22e1ff');
  const edge = hex('#03343f');
  const m = Math.min(w, h);
  for (let py = 0; py < h; py += 1) {
    for (let px = 0; px < w; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (px + (sx + 0.5) / SS) / w;
          const v = (py + (sy + 0.5) / SS) / h;
          // fondo con degradado y resplandor
          let col = mix(top, bottom, v);
          const gd = length((u - cx) * (w / m), (v - cy) * (h / m));
          col = mix(col, [34, 225, 255], Math.max(0, 0.5 - gd) * 0.35);
          let alpha = 1;
          if (round) {
            const dd = sdRoundBox(u * (w / m), v * (h / m), (w / m) / 2, (h / m) / 2, (w / m) / 2, (h / m) / 2, 0.22);
            alpha = dd < 0 ? 1 : 0;
          }
          // peón
          const x = ((u - cx) * (w / m)) / scale;
          const y = ((v - cy) * (h / m)) / scale;
          const d = pawn(x, y);
          if (d < 0.012 && alpha) {
            const t = Math.min(1, Math.max(0, (y + 0.3) / 0.65));
            let c = mix(gold1, gold2, t);
            const hl = Math.max(0, 1 - length(x + 0.05, y + 0.22) / 0.16);
            c = mix(c, [255, 255, 255], hl * 0.65);
            col = d > -0.012 ? mix(edge, c, 0.2) : c;
            if (d > -0.012 && d < 0.012) col = edge;
          }
          r += col[0];
          g += col[1];
          b += col[2];
          a += alpha * 255;
        }
      }
      const n = SS * SS;
      const o = (py * w + px) * 4;
      buf[o] = r / n;
      buf[o + 1] = g / n;
      buf[o + 2] = b / n;
      buf[o + 3] = a / n;
    }
  }
  return png(w, h, buf);
}

writeFileSync(path.join(OUT, 'icon-192.png'), render(192, 192, { scale: 1.35, round: true }));
writeFileSync(path.join(OUT, 'icon-512.png'), render(512, 512, { scale: 1.35, round: true }));
writeFileSync(path.join(OUT, 'icon-maskable-512.png'), render(512, 512, { scale: 0.95, round: false }));
writeFileSync(path.join(OUT, 'og.png'), render(1200, 630, { scale: 1.1, round: false, cx: 0.5, cy: 0.52 }));
console.log('Iconos generados en public/icons');
