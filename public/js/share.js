// Compartir: tarjeta de imagen, clip del final (WebM grabado del canvas 3D) y texto.
import { Chess } from '../vendor/chess.js';
import { sfx } from './fx.js';
import { $, app, choice, copyText, toast, wait } from './ui.js';

const SITE = () => location.origin;

export async function shareBlob(blob, filename, text) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text, title: 'Gambito' });
      return true;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return false; // el usuario canceló
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast('📥 Archivo descargado');
  return true;
}

export async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text, title: 'Gambito' });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  toast((await copyText(text)) ? '📋 Texto copiado' : text, 3500);
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

// Tarjeta vertical 1080x1350 con el tablero 3D del momento.
async function makeCard({ headline, sub, stats }) {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2a1f5c');
  bg.addColorStop(1, '#0c0919');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W / 2, 760, 50, W / 2, 760, 700);
  glow.addColorStop(0, 'rgba(150,120,255,0.45)');
  glow.addColorStop(1, 'rgba(150,120,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  g.textAlign = 'center';
  g.fillStyle = '#ffcf5a';
  g.font = 'bold 96px Georgia, serif';
  g.fillText('GAMBITO', W / 2, 140);
  g.fillStyle = '#a99fcb';
  g.font = '32px "Segoe UI", sans-serif';
  g.fillText('CRÓNICAS DEL TABLERO', W / 2, 190);

  g.fillStyle = '#ffffff';
  g.font = 'bold 84px Georgia, serif';
  g.fillText(headline, W / 2, 330);
  g.fillStyle = '#cfc8ea';
  g.font = '40px "Segoe UI", sans-serif';
  g.fillText(sub, W / 2, 392);

  const shot = app.stage?.captureImage?.();
  if (shot) {
    const raw = await loadImage(shot);
    // Difumina los bordes del fotograma para que se funda con el fondo de la tarjeta.
    const t = document.createElement('canvas');
    t.width = raw.width;
    t.height = raw.height;
    const tg = t.getContext('2d');
    tg.drawImage(raw, 0, 0);
    tg.globalCompositeOperation = 'destination-in';
    const rg = tg.createRadialGradient(t.width / 2, t.height / 2, Math.min(t.width, t.height) * 0.3, t.width / 2, t.height / 2, Math.max(t.width, t.height) * 0.6);
    rg.addColorStop(0, '#000');
    rg.addColorStop(0.65, '#000');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    tg.fillStyle = rg;
    tg.fillRect(0, 0, t.width, t.height);
    const img = t;
    const maxW = 1000;
    const maxH = 760;
    const k = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * k;
    const h = img.height * k;
    g.drawImage(img, (W - w) / 2, 440 + (maxH - h) / 2, w, h);
  }

  g.fillStyle = '#ffe08a';
  g.font = 'bold 44px "Segoe UI", sans-serif';
  g.fillText(stats, W / 2, 1270 - 40);
  g.fillStyle = '#8f86b3';
  g.font = '34px "Segoe UI", sans-serif';
  g.fillText(SITE().replace(/^https?:\/\//, ''), W / 2, 1310);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// Graba un clip de las últimas jugadas reproduciéndolas en el tablero 3D.
async function recordClip(game) {
  const stage = app.stage;
  if (!stage || !window.MediaRecorder || !stage.canvas.captureStream) return null;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) return null;
  const plies = game.chess.history({ verbose: true });
  if (!plies.length) return null;
  const k = Math.min(4, plies.length);
  const c = new Chess(game.startFen);
  plies.slice(0, -k).forEach((m) => c.move(m.san));

  const rec = new MediaRecorder(stage.canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));

  stage.setPosition(c);
  stage.highlight({});
  rec.start();
  await wait(700);
  for (const m of plies.slice(-k)) {
    const mv = c.move(m.san);
    stage.update({ chess: c, move: mv, lastMove: { from: mv.from, to: mv.to }, interactive: false });
    sfx.move();
    await wait(1100);
  }
  if (c.isCheckmate()) {
    const king = c.board().flat().find((p) => p && p.type === 'k' && p.color === c.turn());
    stage.checkmate(king.square);
  }
  await wait(1900);
  rec.stop();
  await stopped;
  game.render(); // restaura la posición final en el tablero
  return new Blob(chunks, { type: mime.split(';')[0] });
}

export async function shareGame({ game, summary, headline, sub }) {
  const text = `${headline} en Gambito, el ajedrez con historia y skins ♟ ${SITE()}`;
  const pick = await choice(`<h3>Compartir partida</h3>
    <p>Elige cómo quieres enseñar tu partida.</p>
    <div class="share-options">
      <button class="btn primary" data-choice="image">🖼 Tarjeta con el tablero</button>
      <button class="btn" data-choice="clip">🎬 Clip del final (6 s)</button>
      <button class="btn" data-choice="text">🔗 Solo texto</button>
      <button class="btn" data-choice="back">Volver</button>
    </div>`);
  if (pick === 'text') return shareText(text);
  if (pick === 'image') {
    const blob = await makeCard({ headline, sub, stats: `${summary.moves} jugadas · ${summary.checks} jaques` });
    return shareBlob(blob, 'gambito.png', text);
  }
  if (pick === 'clip') {
    $('#toast').hidden = true;
    toast('🎬 Grabando el clip...', 9000);
    const blob = await recordClip(game).catch(() => null);
    if (!blob) return toast('Tu navegador no puede grabar el clip. Prueba con la imagen.');
    toast('✅ Clip listo');
    return shareBlob(blob, 'gambito-clip.webm', text);
  }
  return undefined;
}

// Exportadas también para pruebas manuales.
export { makeCard, recordClip };
