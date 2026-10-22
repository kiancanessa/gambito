// Moderación de la comunidad (PROMPT 07). Habla con la API del servidor, que debe tener ADMIN_TOKEN definido.
//
//   ADMIN_TOKEN=... node scripts/moderate.js <url-del-servidor> list
//   ADMIN_TOKEN=... node scripts/moderate.js <url-del-servidor> restrict <id-de-cuenta> [nota]
//   ADMIN_TOKEN=... node scripts/moderate.js <url-del-servidor> review|clear <id-de-cuenta>
//
// «list» muestra los reportes agrupados por jugador (personas distintas, motivos, estado). Un solo reporte no prueba nada y no
// hay sanciones automáticas: con 3 personas distintas en 7 días la cuenta pasa a «review» (solo informa); «restrict» la oculta de la
// búsqueda y le impide organizar eventos, y solo lo decide una persona con este token.
const [base, cmd, id, ...note] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!base || !cmd || !token) {
  console.error('Uso: ADMIN_TOKEN=... node scripts/moderate.js <url> list | restrict <id> [nota] | review <id> | clear <id>');
  process.exit(1);
}
const call = async (path, init = {}) => {
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error ?? ''}`);
  return json;
};
if (cmd === 'list') {
  const { reports } = await call('/api/admin/reports');
  if (!reports.length) console.log('Sin reportes.');
  for (const r of reports) console.log(`${r.status.padEnd(10)} ${String(r.people).padStart(2)} persona(s) · ${r.total} reporte(s) · ${r.reasons} · ${r.name} (${r.id}) · último ${new Date(r.last).toLocaleString('es')}`);
} else if (['restrict', 'review', 'clear'].includes(cmd) && id) {
  const status = { restrict: 'restricted', review: 'review', clear: 'ok' }[cmd];
  console.log(await call('/api/admin/moderate', { method: 'POST', body: JSON.stringify({ userId: id, status, note: note.join(' ') || null }) }));
} else {
  console.error('Comando no válido.');
  process.exit(1);
}
