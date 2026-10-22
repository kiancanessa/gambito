// Compartir: tarjeta de imagen con el tablero 2D, vídeo del final (WebM grabado de un canvas 2D) y texto.
import { $, choice, copyText, toast } from './ui.js';

const SITE = () => location.origin;

export async function shareBlob(blob, filename, text) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text, title: 'CHECKPOINT' });
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
      await navigator.share({ text, title: 'CHECKPOINT' });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  toast((await copyText(text)) ? '📋 Texto copiado' : text, 3500);
}

// Tarjeta vertical 1080x1350 con el tablero 2D del momento.
async function makeCard({ headline, sub, stats, fen = null, flip = false, mark = null }) {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#080a0e';
  g.fillRect(0, 0, W, H);

  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#f5f7fa';
  g.font = 'bold 64px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText('CHECKPOINT', W / 2, 120);
  g.fillStyle = '#929baa';
  g.font = '28px "Segoe UI", sans-serif';
  g.fillText('AJEDREZ COMPETITIVO', W / 2, 165);

  g.fillStyle = '#f5f7fa';
  g.font = 'bold 72px Bahnschrift, "Segoe UI", sans-serif';
  g.fillText(headline, W / 2, 290, W - 80);
  g.fillStyle = '#929baa';
  g.font = '38px "Segoe UI", sans-serif';
  g.fillText(sub, W / 2, 350, W - 80);

  if (fen) {
    const { boardCanvas } = await import('./clip.js');
    const size = 760;
    g.drawImage(boardCanvas(fen, { size, flip, mark }), (W - size) / 2, 410, size, size);
  }

  g.fillStyle = '#20ddf3';
  g.font = 'bold 40px "Segoe UI", sans-serif';
  g.fillText(stats, W / 2, 1240);
  g.fillStyle = '#636c7b';
  g.font = '32px "Segoe UI", sans-serif';
  g.fillText(SITE().replace(/^https?:\/\//, ''), W / 2, 1300);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// Graba un clip de las últimas jugadas de la partida con el dibujo 2D del clip (MediaRecorder sobre un canvas en memoria).
async function recordClip(game) {
  const plies = game.chess.history({ verbose: true });
  if (!plies.length) return null;
  const { recordClipVideo } = await import('./clip.js');
  const me = $('#meName')?.textContent || 'Tú';
  const opp = $('#oppName')?.textContent || 'Rival';
  const data = {
    fen: game.startFen,
    moves: plies.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`),
    white: { name: game.pc === 'w' ? me : opp },
    black: { name: game.pc === 'w' ? opp : me },
    you: game.pc,
    context: 'CHECKPOINT',
    resultText: game.chess.isCheckmate() ? 'Jaque mate' : game.chess.isDraw() ? 'Tablas' : `${Math.ceil(plies.length / 2)} jugadas`,
  };
  return recordClipVideo(data, { from: Math.max(0, plies.length - 4), to: plies.length, title: 'Final de la partida' });
}

export async function shareGame({ game, summary, headline, sub }) {
  const text = `${headline} en CHECKPOINT, ajedrez competitivo con ligas y torneos ♟ ${SITE()}`;
  const pick = await choice(`<h3>Compartir partida</h3>
    <p>Elige cómo quieres enseñar tu partida.</p>
    <div class="share-options">
      <button class="btn primary" data-choice="image">Tarjeta con el tablero</button>
      <button class="btn" data-choice="clip">Vídeo del final (WebM)</button>
      <button class="btn" data-choice="text">Solo texto</button>
      <button class="btn ghost" data-choice="back">Volver</button>
    </div>`);
  if (pick === 'text') return shareText(text);
  if (pick === 'image') {
    const last = game.chess.history({ verbose: true }).at(-1);
    const blob = await makeCard({ headline, sub, stats: `${summary.moves} jugadas · ${summary.checks} jaques`, fen: game.chess.fen(), flip: game.pc === 'b', mark: last ? { from: last.from, to: last.to } : null });
    return shareBlob(blob, 'checkpoint.png', text);
  }
  if (pick === 'clip') {
    $('#toast').hidden = true;
    toast('Grabando el vídeo…', 9000);
    const blob = await recordClip(game).catch(() => null);
    if (!blob) return toast('Tu navegador no puede grabar el vídeo. Prueba con la imagen.');
    toast('Vídeo listo');
    return shareBlob(blob, 'checkpoint-clip.webm', text);
  }
  return undefined;
}

// Exportadas también para pruebas manuales.
export { makeCard, recordClip };
