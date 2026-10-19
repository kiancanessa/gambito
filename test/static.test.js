// Regresión: el hash de la CSP del importmap debe ser el mismo con finales de línea LF o CRLF
// (el navegador normaliza CRLF a LF antes de calcular el hash; en Windows los archivos suelen ser CRLF).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startServer } from '../server/index.js';

const SCRIPT_LF = '\n    { "imports": { "three": "/vendor/three/three.module.js" } }\n  ';

test('la CSP usa el hash del importmap normalizado, también con CRLF', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gambito-static-'));
  mkdirSync(path.join(dir, 'js'));
  const html = `<!doctype html><html><head><script type="importmap">${SCRIPT_LF}</script></head><body>Gambito</body></html>`;
  writeFileSync(path.join(dir, 'index.html'), html.replace(/\n/g, '\r\n')); // CRLF en disco
  const app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:', publicDir: dir, puzzles: [{ id: 1, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', mateIn: 1, solution: ['a1a8'] }] });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    const expected = `'sha256-${crypto.createHash('sha256').update(SCRIPT_LF).digest('base64')}'`;
    assert.ok((res.headers.get('content-security-policy') ?? '').includes(expected), 'falta el hash del importmap normalizado');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
