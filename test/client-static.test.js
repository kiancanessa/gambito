// Comprobaciones estáticas del cliente (PROMPT 10): nada importa un módulo que no existe y todo `$('#id')` apunta a un elemento real.
// No sustituyen a una prueba de navegador, pero cazan a coste cero los fallos que solo se verían al abrir una pantalla concreta.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const JS = path.join(PUBLIC, 'js');
const files = readdirSync(JS).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(JS, f), 'utf8')]));
const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

test('todo import estático o dinámico relativo apunta a un archivo que existe', () => {
  const missing = [];
  for (const [file, code] of Object.entries(src)) {
    for (const m of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      if (!existsSync(path.resolve(JS, m[1]))) missing.push(`${file} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

const cache = new Map();
function exportsOf(file) {
  if (!cache.has(file)) {
    const code = src[file] ?? '';
    const names = new Set([...code.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/g)].map((m) => m[1]));
    for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
    cache.set(file, names);
  }
  return cache.get(file);
}

test('los nombres que se importan de otro módulo local existen como export', () => {
  const bad = [];
  for (const [file, code] of Object.entries(src)) {
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)) {
      const target = path.basename(m[2]);
      const other = src[target];
      if (!other) continue;
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        if (!exportsOf(target).has(name)) bad.push(`${file} importa «${name}» de ${target}, que no lo exporta`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('los elementos fijos que busca el cliente con $("#id") existen en index.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  // Los que crea el propio JS al pintar (plantillas) se reconocen porque aparecen como id="..." dentro de algún módulo.
  const dynamic = new Set(Object.values(src).flatMap((c) => [...c.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1])));
  const missing = [];
  for (const [file, code] of Object.entries(src)) {
    for (const m of code.matchAll(/\$\(\s*['"]#([\w-]+)['"]\s*\)/g)) {
      if (!ids.has(m[1]) && !dynamic.has(m[1])) missing.push(`${file} → #${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('index.html no carga scripts ni estilos externos y cada script local existe', () => {
  for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(?:https?:)?\/\//.test(url)) assert.fail(`recurso externo en index.html: ${url}`);
    if (url.startsWith('/') && !url.startsWith('/?')) assert.ok(existsSync(path.join(PUBLIC, url.split('?')[0])), `no existe ${url}`);
  }
});

test('el cliente no contiene secretos, cadenas de conexión ni tokens fijos', () => {
  const all = Object.values(src).join('\n');
  assert.doesNotMatch(all, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(all, /ADMIN_TOKEN|METRICS_TOKEN|DATABASE_URL/);
  assert.doesNotMatch(all, /Bearer\s+[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(all, /['"][0-9a-f]{48}['"]/, 'ningún token de sesión de 48 hex escrito en el código');
});

test('el cliente no usa eval ni new Function, ni escribe HTML con document.write', () => {
  for (const [file, code] of Object.entries(src)) {
    assert.doesNotMatch(code, /\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(/, file);
  }
});

test('la app declara su tema oscuro (meta y CSS) para que el modo oscuro forzado del navegador no invierta tablero y piezas', () => {
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(readFileSync(path.join(PUBLIC, 'css', 'minimal.css'), 'utf8'), /:root\s*\{\s*color-scheme:\s*dark;\s*\}/);
});

test('el botón de preferencias de la partida no está sobre el tablero (tapaba la casilla a8)', () => {
  const frame = html.slice(html.indexOf('id="boardFrame"'), html.indexOf('<div class="quip"'));
  assert.doesNotMatch(frame, /gamePrefsBtn/);
  assert.match(html, /game-actions">\s*<button class="btn game-prefs-btn" id="gamePrefsBtn"/);
});
