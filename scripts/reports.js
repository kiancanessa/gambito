// Revisión de reportes de jugadores (Fase 5). Solo lee; no cambia nada.
//
//   Base local:        node scripts/reports.js [ruta/a/gambito.db]        (por defecto data/gambito.db)
//   Copia en Neon:     DATABASE_URL="postgresql://..." node scripts/reports.js     (lee la última copia, de hace <3 min)
//
// Muestra, por jugador reportado, cuántas personas distintas lo reportaron, los motivos y sus últimas partidas.
// No hay sanciones automáticas: decides tú (p. ej. cambiar su nombre o avisar). Un solo reporte no prueba nada.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../server/config.js';
import { PgStore } from '../server/persist.js';

const DAY = 24 * 3600 * 1000;
let file = process.argv[2] ?? DB_FILE;
let tmp = null;
let store = null;

try {
  if (process.env.DATABASE_URL && !process.argv[2]) {
    store = new PgStore(process.env.DATABASE_URL);
    await store.init();
    const data = await store.load();
    if (!data) throw new Error('No hay ninguna copia en Neon todavía.');
    tmp = mkdtempSync(path.join(tmpdir(), 'gambito-reports-'));
    file = path.join(tmp, 'snapshot.db');
    writeFileSync(file, data);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT r.target_id AS id, COALESCE(u.name, '(cuenta borrada)') AS name,
              COUNT(DISTINCT r.reporter_id) AS people, COUNT(*) AS total,
              GROUP_CONCAT(DISTINCT r.reason) AS reasons, MAX(r.created_at) AS last,
              SUM(CASE WHEN r.created_at > ? THEN 1 ELSE 0 END) AS week
       FROM reports r LEFT JOIN users u ON u.id = r.target_id
       GROUP BY r.target_id ORDER BY people DESC, last DESC LIMIT 50`,
    )
    .all(Date.now() - 7 * DAY);
  if (!rows.length) console.log('Sin reportes.');
  for (const r of rows) {
    console.log(`${String(r.people).padStart(2)} persona(s) · ${r.total} reporte(s) (${r.week} esta semana) · ${r.name} [${r.id}] · motivos: ${r.reasons} · último: ${new Date(r.last).toLocaleString('es')}`);
  }
  db.close();
} catch (err) {
  console.error(`No se pudo leer: ${err.message}`);
  process.exitCode = 1;
} finally {
  await store?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
