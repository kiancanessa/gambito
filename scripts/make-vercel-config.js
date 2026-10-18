// Genera vercel.json para publicar SOLO el cliente (carpeta public/) como sitio estático en Vercel.
// Calcula el hash de los <script> en línea de index.html para la CSP. Vuelve a ejecutarlo si editas ese script:
//   node scripts/make-vercel-config.js
// Ojo: Vercel no puede ejecutar el servidor (WebSockets + SQLite). Sin backend, el modo online, el desafío
// diario y la nube no están disponibles; la campaña, el tutorial y las partidas contra la IA sí funcionan.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`,
);

const csp = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  framework: null,
  buildCommand: null,
  installCommand: null,
  outputDirectory: 'public',
  rewrites: [{ source: '/g/:code', destination: '/index.html' }],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
    { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/vendor/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }] },
  ],
};

writeFileSync(path.join(ROOT, 'vercel.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log('vercel.json generado con', hashes.length, 'hash(es) de script en línea');
