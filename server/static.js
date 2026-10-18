// Servidor de archivos estáticos con ETag, gzip en memoria y cabeceras de seguridad (CSP con hashes).
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.wasm', '.svg', '.txt']);

// Hashes de los <script> en línea de index.html (el importmap) para no necesitar 'unsafe-inline'.
function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    out.push(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  }
  return out;
}

export function createStatic(publicDir) {
  const root = path.resolve(publicDir);
  const gz = new Map(); // ruta+mtime -> Buffer
  let csp = null;

  function buildCsp() {
    let hashes = [];
    try {
      hashes = inlineScriptHashes(readFileSync(path.join(root, 'index.html'), 'utf8'));
    } catch {
      /* sin index.html: CSP sin hashes */
    }
    return [
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
  }

  return async function handle(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    // Enlaces a partidas (/g/CODIGO) y raíz sirven la app.
    if (pathname === '/' || /^\/g\/[A-Za-z0-9]{4,12}$/.test(pathname)) pathname = '/index.html';
    if (pathname.split('/').some((seg) => seg.startsWith('.'))) {
      res.writeHead(404).end('Not found');
      return;
    }
    const file = path.resolve(path.join(root, path.normalize(pathname)));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('no file');
      const ext = path.extname(file).toLowerCase();
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Cache-Control': pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
      };
      if (ext === '.html') {
        csp ??= buildCsp();
        headers['Content-Security-Policy'] = csp;
      }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
      let body = await readFile(file);
      if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024) {
        const key = `${file}:${info.mtimeMs}`;
        if (!gz.has(key)) gz.set(key, await gzipAsync(body, { level: 9 }));
        body = gz.get(key);
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
      }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  };
}
