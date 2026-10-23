// Repeticiones (Fase 3, flag `replays`; ampliadas en el PROMPT 08): historial de tus partidas y visor sobre la misma escena 3D.
// La partida sale siempre del servidor (jugadas y resultado guardados); aquí solo se mira. Lo que se calcula en el navegador
// (momentos, análisis, clips) es de solo lectura y no se envía de vuelta: no puede cambiar una repetición ni un resultado.
import { TIME_CONTROLS, leagueOf } from './data.js';
import { api } from './net.js';
import { reportReview } from './progress.js';
import { setBanner, startSession } from './session.js';
import { shareGame } from './share.js';
import { $, app, choice, confirmModal, copyText, esc, toast } from './ui.js';

export const tcName = (id) => {
  const t = TIME_CONTROLS.find((x) => x.id === id);
  return t ? (id === 'none' ? 'Sin reloj' : `${t.label} ${t.sub}`) : id;
};

const RESULT = { win: ['Victoria', 'ok'], loss: ['Derrota', 'bad'], draw: ['Tablas', ''] };
const SPEEDS = [1, 2, 0.5];
const STEP_MS = 1100;
const POS_KEY = 'gambito.replay.pos.v1';

// Lista de partidas recientes (la usa el lobby).
export function historyHtml(games) {
  return games
    .map((g) => {
      const [label, cls] = RESULT[g.result];
      return `<li><span class="pill ${cls === 'ok' ? 'ok' : cls === 'bad' ? 'bad' : ''}">${label}</span>
        <div class="vs"><b>vs ${esc(g.opponent)}</b><small>${g.rated ? 'Clasificatoria' : 'Con amigo'} · ${tcName(g.tc)} · ${Math.ceil(g.plies / 2)} jugadas · ${new Date(g.createdAt).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</small></div>
        <button class="btn" data-replay="${esc(g.id)}">Ver</button></li>`;
    })
    .join('');
}

let rp = null; // repetición abierta: { moves, i, timer, speed, game, data, plies, moments, summary, analysis, abort }
let bound = false;

// ----- Posición guardada: reanudar donde lo dejaste -----
const loadPos = () => {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}');
  } catch {
    return {};
  }
};
function savePos(id, i, total) {
  try {
    const all = loadPos();
    if (i <= 0 || i >= total) delete all[id];
    else all[id] = i;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete all[k]; // solo las últimas 40
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch {
    /* sin almacenamiento: simplemente no se recuerda */
  }
}

const stopPlay = () => {
  if (!rp) return;
  clearTimeout(rp.timer);
  rp.timer = null;
  $('#rpPlay').textContent = '⏵';
};

const REASON_TEXT = {
  'jaque mate': 'jaque mate',
  'rey ahogado': 'rey ahogado',
  rendición: 'rendición',
  tiempo: 'se agotó el tiempo',
  desconexión: 'desconexión',
  abortada: 'partida abortada',
};

// Resultado en palabras, siempre con nombres públicos. Cubre victorias, derrotas, tablas y partidas interrumpidas.
export function outcomeText(d) {
  if (d.reason === 'abortada') return 'Partida abortada: no hubo jugadas suficientes y no cuenta para el rating.';
  const why = REASON_TEXT[d.reason] ?? d.reason;
  if (!d.winner) return `Tablas · ${why}`;
  const winner = d.winner === 'w' ? d.white : d.black;
  const ending = d.reason === 'desconexión' ? 'Partida interrumpida: ' : '';
  return `${ending}Gana ${winner.name} · ${why}`;
}

const INTEGRITY = {
  moves: ['ok', '✔ Verificada: el resultado se deduce de las jugadas guardadas.'],
  server: ['ok', '✔ Resultado registrado por el servidor (reloj, rendición o acuerdo).'],
  bad: ['bad', '⚠ No se pudo verificar esta partida. No se muestra como oficial.'],
};

function renderInfo() {
  const d = rp.data;
  const lw = leagueOf(d.white.rating ?? 1000);
  const lb = leagueOf(d.black.rating ?? 1000);
  const [cls, text] = d.integrity?.ok ? INTEGRITY[d.integrity.proof] : INTEGRITY.bad;
  const t = d.tournament;
  const ctx = d.historic
    ? `<span class="pill">Partida histórica · ${esc(d.historic.event)} · ${d.historic.year}</span>`
    : t ? `<span class="pill live">🏆 ${esc(t.name)}${t.roundLabel ? ` · ${esc(t.roundLabel)}` : ''}</span>${t.champion ? '<span class="pill ok">👑 Campeón</span>' : ''}` : `<span class="pill">${d.rated ? 'Clasificatoria' : 'Partida amistosa'}</span>`;
  $('#rpInfo').innerHTML = `
    <div class="rp-players"><span><b>${esc(d.white.name)}</b>${d.historic ? '' : ` <em>${d.white.rating ?? '—'}</em>`}<small>Blancas${d.historic ? '' : ` · liga ${esc(lw.name)}`}</small></span><span class="x">vs</span><span><b>${esc(d.black.name)}</b>${d.historic ? '' : ` <em>${d.black.rating ?? '—'}</em>`}<small>Negras${d.historic ? '' : ` · liga ${esc(lb.name)}`}</small></span></div>
    <p class="rp-result">${esc(outcomeText(d))}</p>
    <div class="rp-tags">${ctx}${d.historic ? '' : `<span class="pill">${esc(tcName(d.tc))}</span>`}<span class="pill">${Math.ceil(d.moves.length / 2)} jugadas</span><span class="pill ${cls}" title="${esc(text)}">${cls === 'ok' ? 'Verificada' : 'Sin verificar'}</span></div>
    <small class="muted">${esc(text)}</small>`;
}

// Lista completa de jugadas con la actual resaltada; cualquier jugada lleva a esa posición.
function renderMoves() {
  const sans = rp.plies.map((m) => m.san);
  let out = '';
  for (let k = 0; k < sans.length; k += 2) {
    const cell = (ply) => (sans[ply - 1] ? `<button type="button" class="san${rp.i === ply ? ' on' : ''}" data-ply="${ply}" ${rp.i === ply ? 'aria-current="true"' : ''}>${esc(sans[ply - 1])}</button>` : '');
    out += `<span class="mv"><i>${k / 2 + 1}.</i> ${cell(k + 1)} ${cell(k + 2)}</span>`;
  }
  const list = $('#moveList');
  list.classList.add('rp-moves');
  list.innerHTML = out || '<span class="muted">Sin jugadas</span>';
  list.querySelector('.san.on')?.scrollIntoView({ block: 'nearest' });
}

const bestHint = (m) => {
  if (!m.bestUci || !rp.plies[m.ply - 1]) return '';
  const san = rp.uciToSan(rp.plies[m.ply - 1].before, m.bestUci);
  return san ? ` Mejor era ${san}.` : '';
};

function renderMoments() {
  const box = $('#rpMoments');
  const list = rp.moments;
  const s = rp.summary;
  const acc = s ? `<p class="rp-summary">Precisión estimada: <b>${esc(rp.data.white.name)} ${s.w.accuracy ?? '—'}%</b> · <b>${esc(rp.data.black.name)} ${s.b.accuracy ?? '—'}%</b> <small class="muted">(errores graves ${s.w.blunders}/${s.b.blunders})</small></p>` : '';
  const items = list
    .filter((m) => m.kind !== 'inaccuracy' || rp.analysis)
    .map((m) => `<li><button type="button" class="rp-moment ${esc(m.tone)}" data-ply="${m.ply}"><b>${esc(m.title)}</b><small>${esc(m.detail)}${esc(bestHint(m))}</small><em>${m.source === 'engine' ? 'Motor' : 'Jugadas'}</em></button></li>`)
    .join('');
  const state = rp.analyzing
    ? `<button class="btn" data-rp="analyze">⏹ Analizando ${rp.progress}… (cancelar)</button>`
    : rp.analysis
      ? '<small class="muted">Análisis de Stockfish listo (se guarda en este navegador).</small>'
      : '<button class="btn" data-rp="analyze">🔍 Analizar con Stockfish</button>';
  box.innerHTML = `<div class="card-head"><p class="eyebrow">Momentos destacados</p>${state}</div>${acc}
    ${items ? `<ul class="rp-moment-list">${items}</ul>` : '<p class="muted">No hay momentos destacados claros en esta partida.</p>'}
    ${rp.analysis ? '' : '<small class="muted">Sin analizar solo se muestran hechos de las jugadas (mates, coronaciones, torneo, material cedido). Los errores y sacrificios exigen el motor.</small>'}`;
}

function paint() {
  const total = rp.moves.length;
  $('#rpSlider').max = String(total);
  $('#rpSlider').value = String(rp.i);
  $('#rpLabel').textContent = rp.i === 0 ? `Posición inicial · ${total} jugadas` : `Jugada ${Math.ceil(rp.i / 2)} · ${rp.i}/${total}`;
  $('#rpSpeed').textContent = `${rp.speed}×`;
  const d = rp.data;
  setBanner(`<span>🎬 Repetición · ${d.historic ? `${esc(d.historic.event)}, ${d.historic.year}` : `${d.tournament ? `🏆 ${esc(d.tournament.name)}` : d.rated ? 'Clasificatoria' : 'Partida con amigo'} · ${esc(tcName(d.tc))}`}</span>${rp.i === total ? `<span>🏁 ${esc(outcomeText(d))}</span>` : ''}`);
  renderMoves();
}

function seek(n, { animate = false } = {}) {
  const total = rp.moves.length;
  const target = Math.max(0, Math.min(total, n));
  if (animate && target === rp.i + 1) rp.game.applyRemote(rp.moves[rp.i]);
  else rp.game.loadMoves(rp.moves.slice(0, target));
  rp.i = target;
  paint();
  savePos(rp.data.id, target, total);
  // Llegar a la última jugada de una partida propia cuenta como revisarla (el servidor lo valida y lo da una sola vez).
  if (target === total && total > 0 && !rp.reported && !rp.publicGame) {
    rp.reported = true;
    reportReview(rp.data.id, total);
  }
}

function play() {
  if (!rp) return;
  if (rp.i >= rp.moves.length) seek(0);
  $('#rpPlay').textContent = '⏸';
  const tick = () => {
    if (!rp || app.game !== rp.game) return;
    seek(rp.i + 1, { animate: true });
    if (rp.i >= rp.moves.length) return stopPlay();
    rp.timer = setTimeout(tick, STEP_MS / rp.speed);
    return undefined;
  };
  rp.timer = setTimeout(tick, 500);
}

// ----- Enlaces: respetan la privacidad. Pública → /r/ID; privada → solo con un enlace que el jugador crea y puede revocar -----
const withPly = (path, ply) => (ply > 0 ? `${path}?m=${ply}` : path);

async function linkFor(ply) {
  const d = rp.data;
  if (rp.publicGame) return withPly(`/r/${d.id}`, ply); // ya la estás viendo por un enlace público o compartido
  if (d.share) return withPly(d.share.link, ply);
  if (d.public) return withPly(`/r/${d.id}`, ply);
  const ok = await confirmModal(
    'Esta partida es privada',
    'Solo la ves tú. Si creas un enlace, cualquiera que lo tenga podrá ver las jugadas, los nombres públicos y el resultado. Puedes revocarlo cuando quieras.',
    'Crear enlace',
    'Cancelar',
  );
  if (!ok) return null;
  const res = await api(`/api/games/${encodeURIComponent(d.id)}/share`, { method: 'POST', body: {} });
  if (!res.ok) {
    toast(res.json?.error ?? 'No se pudo crear el enlace');
    return null;
  }
  d.share = { token: res.json.token, link: res.json.link };
  return withPly(d.share.link, ply);
}

async function copyLink(ply) {
  const path = await linkFor(ply);
  if (!path) return;
  await copyText(`${location.origin}${path}`);
  toast(ply > 0 ? `🔗 Enlace copiado (empieza en la jugada ${Math.ceil(ply / 2)})` : '🔗 Enlace copiado');
}

async function revokeLink() {
  const d = rp.data;
  if (!d.share) return;
  if (!(await confirmModal('¿Dejar de compartir?', 'El enlace dejará de funcionar para todos.', 'Dejar de compartir', 'Cancelar'))) return;
  const res = await api(`/api/games/${encodeURIComponent(d.id)}/share`, { method: 'DELETE' });
  if (res.ok) {
    d.share = null;
    toast('Enlace revocado');
  } else toast(res.json?.error ?? 'No se pudo revocar');
}

async function openShareMenu() {
  const d = rp.data;
  const canRevoke = !rp.publicGame && d.share;
  if (d.historic) return openClipFor(); // partida histórica: no hay enlace propio, solo el clip
  const pick = await choice(`<h3>Compartir repetición</h3>
    <p>El enlace abre esta partida con los nombres públicos y el resultado. ${rp.publicGame || d.public ? 'Es una partida pública.' : d.share ? 'Tienes un enlace activo: quien lo tenga puede verla.' : 'Tu partida es privada hasta que crees un enlace.'}</p>
    <div class="share-options">
      <button class="btn primary" data-choice="link">🔗 Enlace a la partida</button>
      ${rp.i > 0 ? `<button class="btn" data-choice="linkat">📍 Enlace a la jugada ${Math.ceil(rp.i / 2)}</button>` : ''}
      <button class="btn" data-choice="clip">🎞 Clip 2D de un momento</button>
      <button class="btn" data-choice="card">🖼 Tarjeta o vídeo del final</button>
      ${canRevoke ? '<button class="btn danger" data-choice="revoke">🚫 Dejar de compartir</button>' : ''}
      <button class="btn" data-choice="back">Volver</button>
    </div>`);
  if (!rp) return;
  if (pick === 'link') return copyLink(0);
  if (pick === 'linkat') return copyLink(rp.i);
  if (pick === 'revoke') return revokeLink();
  if (pick === 'clip') return openClipFor();
  if (pick === 'card') {
    const mine = rp.game.chess.history({ verbose: true }).filter((m) => m.color === d.you);
    const me = d.you === 'w' ? d.white : d.black;
    const opp = d.you === 'w' ? d.black : d.white;
    return shareGame({
      game: rp.game,
      summary: { moves: mine.length, checks: mine.filter((m) => /[+#]/.test(m.san)).length },
      headline: `Repetición de ${me.name}`,
      sub: `vs ${opp.name}`,
    });
  }
  return undefined;
}

async function openClipFor() {
  const { openClip } = await import('./clip.js');
  const { topMoments } = await import('./moments.js');
  const picks = topMoments(rp.moments, 5);
  const data = rp.data;
  stopPlay();
  await openClip({
    data,
    moments: picks,
    onCopyLink: data.historic ? null : (ply) => copyLink(ply),
    onOpenAt: (ply) => seek(ply),
  });
}

async function runAnalysis() {
  if (rp.analyzing) {
    rp.abort?.abort();
    return;
  }
  const mod = await import('./analysis.js');
  const my = rp;
  rp.abort = new AbortController();
  rp.analyzing = true;
  rp.progress = '0%';
  renderMoments();
  const res = await mod.analyzeGame(my.data.id, my.moves, {
    signal: my.abort.signal,
    onProgress: (k, n) => {
      if (rp !== my) return;
      my.progress = `${Math.round(((k + 1) / (n + 1)) * 100)}%`;
      if (k % 3 === 0) renderMoments();
    },
  });
  if (rp !== my) return;
  my.analyzing = false;
  if (!res) {
    toast(my.abort.signal.aborted ? 'Análisis cancelado' : 'No se pudo cargar el motor para analizar');
    return renderMoments();
  }
  my.analysis = res;
  const built = mod.buildMoments(my.moves, momentCtx(my.data), res);
  my.moments = built.moments;
  my.summary = built.summary;
  renderMoments();
  return toast(res.cached ? '🔍 Análisis recuperado' : '🔍 Análisis listo');
}

const momentCtx = (d) => ({ winner: d.winner, tournament: d.tournament });

function bind() {
  if (bound) return;
  bound = true;
  const jump = (ply) => {
    if (!rp) return;
    stopPlay();
    seek(ply);
  };
  $('#replayBar').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-rp]')?.dataset.rp;
    if (!act || !rp) return;
    if (act === 'play') return rp.timer ? stopPlay() : play();
    if (act === 'speed') {
      rp.speed = SPEEDS[(SPEEDS.indexOf(rp.speed) + 1) % SPEEDS.length];
      return paint();
    }
    stopPlay();
    if (act === 'start') return seek(0);
    if (act === 'prev') return seek(rp.i - 1);
    if (act === 'next') return seek(rp.i + 1, { animate: true });
    if (act === 'end') return seek(rp.moves.length);
    if (act === 'share') return openShareMenu();
    return undefined;
  });
  $('#rpPanel').addEventListener('click', (e) => {
    const m = e.target.closest('[data-ply]');
    if (m) return jump(Number(m.dataset.ply));
    if (e.target.closest('[data-rp="analyze"]')) return runAnalysis();
    return undefined;
  });
  $('#moveList').addEventListener('click', (e) => {
    const m = rp && e.target.closest('[data-ply]');
    if (m) jump(Number(m.dataset.ply));
  });
  $('#rpSlider').addEventListener('input', (e) => jump(Number(e.target.value)));
  // Teclado: ← → jugada a jugada, Inicio/Fin, espacio reproduce o pausa.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range';
    if (!rp || app.game !== rp.game || typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const keys = { ArrowLeft: () => (stopPlay(), seek(rp.i - 1)), ArrowRight: () => (stopPlay(), seek(rp.i + 1, { animate: true })), Home: () => (stopPlay(), seek(0)), End: () => (stopPlay(), seek(rp.moves.length)) };
    if (e.key === ' ' && !e.target.closest?.('button')) keys[' '] = () => (rp.timer ? stopPlay() : play());
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  });
}

// `publicGame`: repetición de una partida pública o compartida que no es tuya; se ve desde las blancas.
// `ply`: jugada desde la que empezar (enlaces `?m=N`); si no, se retoma donde lo dejaste o se reproduce desde el principio.
export async function openReplay(id, { publicGame = false, ply = null } = {}) {
  const res = await api(`/api/${publicGame ? 'public/' : ''}games/${encodeURIComponent(id)}`, { auth: !publicGame });
  if (!res.ok) return toast(res.status === 404 ? 'Esta repetición no existe o ya no se comparte' : 'No se pudo cargar la repetición');
  return openReplayData(res.json.game, { publicGame, ply });
}

// Abre el visor con una partida ya cargada: la del servidor o una histórica de los highlights (`d.historic`), que no tiene enlace.
export async function openReplayData(d, { publicGame = true, ply = null } = {}) {
  bind();
  const analysis = await import('./analysis.js');
  const moments = await import('./moments.js');
  let plies;
  try {
    plies = analysis.verbosePlies(d.moves);
  } catch {
    return toast('Las jugadas de esta partida no son válidas');
  }
  const opp = d.you === 'w' ? d.black : d.white;
  const me = d.you === 'w' ? d.white : d.black;
  const lg = leagueOf(opp.rating ?? 1000);
  const game = startSession({
    opp: { name: opp.name, title: `Liga ${lg.name} · ${opp.rating ?? '—'}`, glyph: lg.glyph, color: lg.color },
    playerColor: d.you,
    spectator: true,
    remote: { send() {} }, // sin motor ni envío: es solo un visor
    onEnd() {},
    onLeave: () => {
      stopPlay();
      rp?.abort?.abort();
      $('#replayBar').hidden = true;
      $('#rpPanel').hidden = true;
      $('#moveList').classList.remove('rp-moves');
      rp = null;
    },
    ui: { hint: false, undo: false, resign: false, meName: me.name, meSub: `${d.you === 'w' ? 'Blancas' : 'Negras'} · ${me.rating ?? '—'} pts` },
  });
  game.over = true; // no hay nada que jugar ni que confirmar al salir
  const cached = (() => {
    try {
      return JSON.parse(localStorage.getItem(`gambito.analysis.v1.${d.id}`) ?? 'null');
    } catch {
      return null;
    }
  })();
  rp = { moves: d.moves, i: 0, timer: null, speed: 1, game, data: d, publicGame, plies, analysis: null, analyzing: false, progress: '', uciToSan: analysis.uciToSan, moments: [], summary: null };
  const ctx = momentCtx(d);
  if (cached && cached.v === 1 && cached.evals?.length === d.moves.length + 1) {
    rp.analysis = { evals: cached.evals, best: cached.best ?? [], cached: true };
    const built = analysis.buildMoments(d.moves, ctx, rp.analysis);
    rp.moments = built.moments;
    rp.summary = built.summary;
  } else rp.moments = moments.mergeMoments(moments.structuralMoments(plies, ctx));
  $('#replayBar').hidden = false;
  $('#rpPanel').hidden = false;
  renderInfo();
  renderMoments();
  paint();
  const total = d.moves.length;
  const asked = Number.isInteger(ply) && ply > 0 ? Math.min(ply, total) : null;
  const saved = !asked && !publicGame ? Number(loadPos()[d.id]) : 0;
  if (asked || (saved > 0 && saved < total)) {
    seek(asked ?? saved);
    toast(asked ? `📍 Empieza en la jugada ${Math.ceil(asked / 2)}` : `▶ Retomada en la jugada ${Math.ceil(saved / 2)}. Pulsa ⏮ para empezar de nuevo.`, 3500);
  } else play();
  return undefined;
}
