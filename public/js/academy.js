// Academia: la ruta de aprendizaje de cero a experto (sustituye a la campaña). Pantalla de progreso y ejecución de lecciones.
// El contenido y las reglas de evaluación están en academy-data.js; aquí solo hay interfaz y progreso.
import { Chess } from '../vendor/chess.js';
import { LESSONS, ORDER, STAGES, TRIALS_STAGE, judge, normSan } from './academy-data.js';
import { CAMPAIGN, GLYPH, QUICK_LEVELS } from './data.js';
import { feedback } from './feedback.js';
import { sfx } from './fx.js';
import { setBanner, startSession } from './session.js';
import { addCoins, addXp, save, state } from './store.js';
import { $, app, celebrate, choice, esc, showScreen, toast, VS } from './ui.js';

const LEVELS = ['Principiante', ...STAGES.map((s) => s.level), TRIALS_STAGE.level];
const TEACHER = { name: 'Profesor Pip', title: 'Academia CHECKPOINT', glyph: 'p', color: '#34e3a0' };

// ---------- Progreso ----------
const acad = () => state.academy;
const lessonDone = (id) => !!acad().lessons[id];
const stageDone = (stage) => stage.lessons.every((l) => lessonDone(l.id));
const stageOpen = (i) => i === 0 || i < acad().unlocked || stageDone(STAGES[i - 1]);
const trialsOpen = () => acad().unlocked > STAGES.length || stageDone(STAGES.at(-1));
const clearedTrials = () => Math.min(state.campaign.cleared, CAMPAIGN.length);
const stars = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);

const totals = () => {
  const lessons = ORDER.length;
  const done = ORDER.filter(lessonDone).length;
  return { lessons, done, trials: CAMPAIGN.length, cleared: clearedTrials(), pct: Math.round(((done + clearedTrials()) / (lessons + CAMPAIGN.length)) * 100) };
};

function levelName() {
  if (clearedTrials() >= CAMPAIGN.length) return LEVELS.at(-1);
  return LEVELS[STAGES.filter(stageDone).length];
}

// Lo siguiente recomendado: primera lección sin hacer de las etapas abiertas, después las pruebas finales.
export function academyNext() {
  for (let i = 0; i < STAGES.length; i += 1) {
    if (!stageOpen(i)) break;
    const l = STAGES[i].lessons.find((x) => !lessonDone(x.id));
    if (l) {
      const started = ORDER.some(lessonDone);
      return { type: 'lesson', id: l.id, stage: `Etapa ${i + 1} · ${STAGES[i].name}`, title: l.title, sub: `${l.exercises.length} ejercicios · nivel ${STAGES[i].level}`, label: `${started ? 'Continuar' : 'Empezar'}: ${l.title}` };
    }
  }
  if (trialsOpen() && clearedTrials() < CAMPAIGN.length) {
    const i = clearedTrials();
    return { type: 'trial', index: i, stage: `Etapa 5 · ${TRIALS_STAGE.name}`, title: `Prueba ${i + 1}: ${CAMPAIGN[i].name}`, sub: CAMPAIGN[i].title, label: `Prueba final ${i + 1}: ${CAMPAIGN[i].name}` };
  }
  return { type: 'done', stage: 'Academia completada', title: 'Eres un Maestro de CHECKPOINT', sub: 'Repasa lo que quieras o sube de liga', label: 'Repasar la Academia' };
}

export const academyPips = () => {
  const next = academyNext();
  const marks = ORDER.map((id) => (lessonDone(id) ? 'on' : next.type === 'lesson' && next.id === id ? 'now' : ''));
  CAMPAIGN.forEach((_, i) => marks.push(i < clearedTrials() ? 'on' : next.type === 'trial' && next.index === i ? 'now' : ''));
  return marks;
};

export const academySummary = () => {
  const t = totals();
  return t.done + t.cleared === 0 ? 'De cero a experto, paso a paso' : `${t.done}/${t.lessons} lecciones · nivel ${levelName()}`;
};

export function academyContinue() {
  const n = academyNext();
  if (n.type === 'lesson') return runLesson(n.id);
  if (n.type === 'trial') return app.startTrial(n.index);
  return app.go('academy');
}

// ---------- Pantalla ----------
function lessonRow(l, i, open) {
  const s = acad().lessons[l.id] ?? 0;
  const next = academyNext();
  const isNext = next.type === 'lesson' && next.id === l.id;
  return `<li class="ac-lesson ${s ? 'done' : ''} ${isNext ? 'next' : ''} ${open ? '' : 'locked'}">
    <span class="ac-num" aria-hidden="true">${s ? '✓' : open ? i + 1 : '🔒'}</span>
    <span class="ac-info"><b>${esc(l.title)}</b><small>${l.exercises.length} ejercicios${s ? ` · <span class="ac-stars" aria-label="${s} de 3 estrellas">${stars(s)}</span>` : ''}</small></span>
    ${open ? `<button class="btn" data-ac-lesson="${l.id}">${s ? 'Repetir' : isNext ? 'Empezar' : 'Abrir'}</button>` : '<small class="muted">Bloqueada</small>'}</li>`;
}

function render() {
  const body = $('#academyBody');
  if (!body) return;
  const t = totals();
  const next = academyNext();
  const stages = STAGES.map((s, si) => {
    const open = stageOpen(si);
    const done = s.lessons.filter((l) => lessonDone(l.id)).length;
    return `<section class="lb-card ac-stage ${open ? '' : 'locked'}" style="--c:${s.color}">
      <div class="card-head"><p class="eyebrow">Etapa ${si + 1} · ${esc(s.level)}</p><span class="pill ${done === s.lessons.length ? 'ok' : ''}">${done}/${s.lessons.length}</span></div>
      <h3>${esc(s.name)}</h3><p class="muted">${esc(s.blurb)}</p>
      <ul class="ac-lessons">${s.lessons.map((l, i) => lessonRow(l, i, open)).join('')}</ul>
      ${open ? '' : '<p class="muted ac-lock">Termina la etapa anterior para abrirla, o salta de nivel si ya sabes jugar.</p>'}</section>`;
  }).join('');
  const tOpen = trialsOpen();
  const trials = `<section class="lb-card ac-stage ${tOpen ? '' : 'locked'}" style="--c:${TRIALS_STAGE.color}">
    <div class="card-head"><p class="eyebrow">Etapa 5 · ${TRIALS_STAGE.level}</p><span class="pill ${t.cleared === t.trials ? 'ok' : ''}">${t.cleared}/${t.trials}</span></div>
    <h3>${TRIALS_STAGE.name}</h3><p class="muted">${TRIALS_STAGE.blurb}</p>
    <ul class="ac-lessons">${CAMPAIGN.map((n, i) => {
      const open = tOpen && i <= clearedTrials();
      const s = state.campaign.stars[n.id] ?? 0;
      const isNext = next.type === 'trial' && next.index === i;
      return `<li class="ac-lesson ${i < clearedTrials() ? 'done' : ''} ${isNext ? 'next' : ''} ${open ? '' : 'locked'}"><span class="ac-num" aria-hidden="true">${i < clearedTrials() ? '✓' : open ? i + 1 : '🔒'}</span>
        <span class="ac-info"><b>${esc(n.name)}</b><small>${esc(n.title)}${s ? ` · <span class="ac-stars">${stars(s)}</span>` : ''}</small></span>
        ${open ? `<button class="btn ${isNext ? 'primary' : ''}" data-ac-trial="${i}">${i < clearedTrials() ? 'Repetir' : 'Jugar'}</button>` : '<small class="muted">Bloqueada</small>'}</li>`;
    }).join('')}</ul></section>`;
  body.innerHTML = `
    <section class="lb-card ac-hero">
      <div class="ac-hero-main"><p class="eyebrow">Tu nivel: ${esc(levelName())}</p><h3>De cero a experto</h3>
        <p class="muted">${next.type === 'done' ? '¡Has completado toda la ruta!' : `Siguiente: ${esc(next.title)}`}</p>
        <div class="meter"><div class="meter-head"><span>Progreso de la Academia</span><small>${t.pct} %</small></div>
          <div class="xpline" role="progressbar" aria-label="Progreso de la Academia" aria-valuenow="${t.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${t.pct}%"></i></div></div></div>
      <div class="ac-hero-cta"><button class="play-now sm" data-ac-continue><span class="pn-main">${next.type === 'done' ? 'Repasar' : t.done + t.cleared ? 'Continuar' : 'Empezar'}</span><small>${esc(next.label)}</small></button>
        <button class="link-btn" data-ac-skip>Ya sé jugar: saltar de nivel</button></div>
    </section>
    <div class="ac-path">${stages}${trials}</div>`;
}

export function enterAcademy() {
  showScreen('academy');
  render();
}

// «Saltar de nivel»: abre etapas sin completar las anteriores (no da recompensas por las lecciones saltadas).
async function skipLevel() {
  const options = [...STAGES.slice(1), TRIALS_STAGE];
  const pick = await choice(`<h3>¿Desde dónde quieres empezar?</h3><p class="muted">Las etapas anteriores quedan abiertas para repasarlas cuando quieras. Las recompensas de las lecciones se ganan al completarlas.</p>
    <div class="share-options">${options.map((s, i) => `<button class="btn" data-choice="${i + 1}"><b>${esc(s.name)}</b> <small>${esc(s.level)}</small></button>`).join('')}<button class="btn" data-choice="no">Cancelar</button></div>`);
  if (pick === 'no') return;
  acad().unlocked = Math.max(acad().unlocked, Number(pick) + 1);
  save();
  render();
  toast('Etapas desbloqueadas');
}

// ---------- Ejecución de lecciones ----------
const run = { active: false, cancel: null };

// Cierra la partida de práctica que quede en pantalla sin pedir confirmación (el ejercicio ya terminó o se abandonó).
function closeSession() {
  if (!app.game) return;
  app.leaveHook = null;
  app.resignHandler = null;
  app.game.destroy();
  app.game = null;
}

const wrongText = (ex, move) => {
  const custom = ex.wrong?.[normSan(move.san)];
  if (custom) return custom;
  return {
    capture: 'Esa jugada no captura nada: busca una pieza que puedas comer.',
    captureOf: 'No es esa pieza. Lee la consigna y mira qué puedes capturar.',
    check: 'Esa jugada no da jaque. El rey rival debe quedar atacado.',
    mate: 'No es jaque mate: el rey rival todavía tiene salida. Piensa qué casillas controla cada pieza.',
    castle: 'Eso no es el enroque: se hace moviendo el rey dos casillas hacia la torre.',
    enpassant: 'No es la captura al paso: tu peón captura en diagonal la casilla que el peón rival acaba de cruzar.',
    promote: 'Lleva el peón hasta la última fila.',
    piece: 'Tienes que mover la pieza que indica la consigna.',
  }[ex.goal.type] ?? 'Esa no es la idea. Pulsa «Pista» si necesitas ayuda.';
};

function solutionMove(ex, chess, step) {
  for (const m of chess.moves({ verbose: true })) {
    const c = new Chess(chess.fen());
    const played = c.move(m);
    if (judge(ex, played, c, step).ok) return m;
  }
  return null;
}

const dots = (i, n) => Array.from({ length: n }, (_, k) => `<i class="${k < i ? 'on' : k === i ? 'now' : ''}"></i>`).join('');
const boardBanner = (ex, i, n, extra = '') =>
  `<span>🎓 <b>${esc(ex.prompt)}</b>${extra}</span><span class="dots">${dots(i, n)}</span>
   <span class="ac-actions"><button class="link-btn" data-ac="hint">💡 Pista</button><button class="link-btn" data-ac="skip">Saltar</button></span>`;

// Ejercicio sobre el tablero: resuelve con { mistakes, hints, skipped, exit }.
function runBoard(ex, i, n) {
  return new Promise((resolve) => {
    let step = 0;
    let mistakes = 0;
    let hints = 0;
    let finished = false;
    const done = (extra) => {
      if (finished) return;
      finished = true;
      run.cancel = null;
      resolve({ mistakes, hints, ...extra });
    };
    run.cancel = () => done({ exit: true });
    const color = ex.fen.split(' ')[1];
    startSession({
      opp: TEACHER,
      playerColor: color,
      fen: ex.fen,
      onEnd: () => {},
      onLeave: () => done({ exit: true }),
      scripted: (move, game) => {
        const r = judge(ex, move, game.chess, step);
        if (!r.ok) {
          mistakes += 1;
          sfx.error();
          toast(wrongText(ex, move), 4200);
          setTimeout(() => game.undoLast(), 650);
          return;
        }
        step += 1;
        game.hintMove = null;
        if (r.done) {
          sfx.coin();
          setBanner(`<span>✅ <b>${esc(ex.explain)}</b></span><button class="btn primary" data-ac="next">Continuar</button>`);
          const t = setTimeout(() => done({}), 3800);
          run.next = () => {
            clearTimeout(t);
            done({});
          };
          return;
        }
        toast('✓ ¡Bien! Sigue…', 1100);
        setTimeout(() => {
          if (finished || !r.reply) return;
          const m = new Chess(game.chess.fen()).move(r.reply);
          game.play({ from: m.from, to: m.to, promotion: m.promotion });
        }, 650);
      },
      ui: { banner: boardBanner(ex, i, n), hint: false, undo: false, resign: false, meSub: 'Academia', meName: 'Tú' },
    });
    run.hint = () => {
      const g = app.game;
      const m = g && solutionMove(ex, g.chess, step);
      hints += 1;
      if (m) {
        g.hintMove = { from: m.from, to: m.to };
        g.render();
      }
      toast(ex.hint ? `💡 ${ex.hint}` : 'Mira las casillas resaltadas', 4200);
    };
    run.skip = () => done({ skipped: true });
  });
}

async function runQuiz(ex) {
  let mistakes = 0;
  const wrongSet = new Set();
  for (;;) {
    const pick = await choice(`<p class="eyebrow">Pregunta</p><h3>${esc(ex.prompt)}</h3>
      <div class="share-options">${ex.options.map((o, k) => `<button class="btn ${wrongSet.has(k) ? 'danger' : ''}" data-choice="${k}" ${wrongSet.has(k) ? 'disabled' : ''}>${esc(o)}</button>`).join('')}<button class="link-btn" data-choice="exit">Salir de la lección</button></div>`);
    if (pick === 'exit') return { exit: true, mistakes, hints: 0 };
    if (Number(pick) === ex.answer) {
      sfx.coin();
      await choice(`<div class="result win"><p class="eyebrow">¡Correcto!</p><h3>${esc(ex.options[ex.answer])}</h3><p>${esc(ex.explain)}</p><div class="modal-actions"><button class="btn primary" data-choice="ok">Continuar</button></div></div>`, 'result-card');
      return { mistakes, hints: 0 };
    }
    mistakes += 1;
    wrongSet.add(Number(pick));
    sfx.error();
    toast('No es esa. Prueba otra opción.', 1600);
  }
}

// Práctica contra la IA (finales): se gana dando mate dentro del límite de jugadas.
function runPlay(ex, i, n) {
  return new Promise((resolve) => {
    const lvl = QUICK_LEVELS.find((l) => l.id === ex.ai);
    let finished = false;
    const done = (extra) => {
      if (finished) return;
      finished = true;
      run.cancel = null;
      resolve(extra);
    };
    run.cancel = () => done({ exit: true, mistakes: 0, hints: 0 });
    startSession({
      opp: { name: 'Rival de práctica', title: `Nivel ${lvl.name}`, glyph: 'p', color: '#8bc34a', check: '¡Cuidado!' },
      playerColor: ex.fen.split(' ')[1],
      fen: ex.fen,
      ai: { skill: lvl.skill, depth: lvl.depth, movetime: lvl.movetime, blunder: lvl.blunder },
      limitMoves: ex.limitMoves,
      onLeave: () => done({ exit: true, mistakes: 0, hints: 0 }),
      onEnd: async (s) => {
        if (s.result === 'win') {
          await choice(`<div class="result win"><p class="eyebrow">¡Mate!</p><h2>Lo has conseguido</h2><p>${esc(ex.explain)}</p><div class="modal-actions"><button class="btn primary" data-choice="ok">Continuar</button></div></div>`, 'result-card');
          done({ mistakes: 0, hints: 0 });
          return;
        }
        const again = await choice(`<div class="result loss"><p class="eyebrow">${esc(s.reason)}</p><h2>Casi…</h2><p>${s.result === 'draw' ? 'Ha terminado en tablas (¿ahogado?).' : 'El objetivo es dar mate dentro del límite de jugadas.'} Inténtalo otra vez: ${esc(ex.explain)}</p><div class="modal-actions"><button class="btn primary" data-choice="retry">Reintentar</button><button class="btn" data-choice="exit">Salir</button></div></div>`, 'result-card');
        if (again === 'retry') {
          finished = true;
          resolve(await runPlay(ex, i, n));
        } else done({ exit: true, mistakes: 1, hints: 0 });
      },
      ui: { banner: `<span>🎓 <b>${esc(ex.prompt)}</b></span><span class="muted">${ex.limitMoves} jugadas como máximo</span>`, hint: true, undo: true, resign: true, meSub: 'Academia' },
    });
  });
}

async function completeLesson(lesson, ctx) {
  const stage = STAGES.find((s) => s.id === lesson.stage);
  const first = !lessonDone(lesson.id);
  const earned = ctx.mistakes === 0 && ctx.hints === 0 ? 3 : ctx.mistakes <= 2 ? 2 : 1;
  const wasDone = stageDone(stage);
  acad().lessons[lesson.id] = Math.max(acad().lessons[lesson.id] ?? 0, earned);
  const coins = first ? 15 + earned * 10 : 0;
  if (coins) {
    addCoins(coins, { source: 'game' });
    addXp(30, { source: 'game' });
  }
  let bonus = 0;
  if (!wasDone && stageDone(stage)) {
    bonus = 60;
    addCoins(bonus, { source: 'game' });
  }
  save();
  celebrate();
  sfx.win();
  const nxt = academyNext();
  if (bonus) feedback('advance', { title: `Etapa completada: ${stage.name}`, text: `Tu nivel ahora es ${levelName()}` });
  const pick = await choice(`<div class="result win"><p class="eyebrow">Lección completada</p><h2>${esc(lesson.title)}</h2>
    <p class="stars-earned">${stars(earned).replace(/★/g, '<span class="on">★</span>').replace(/☆/g, '<span>★</span>')}</p>
    <ul class="rewards">${first ? `<li><span>Primera vez</span><b>+${coins} 🪙</b></li>` : '<li><span>Repetición</span><b>sin recompensa</b></li>'}${bonus ? `<li class="total"><span>Etapa completada</span><b>+${bonus} 🪙</b></li>` : ''}</ul>
    <p class="muted">${ctx.mistakes ? `${ctx.mistakes} fallo${ctx.mistakes > 1 ? 's' : ''}` : 'Sin fallos'}${ctx.hints ? ` · ${ctx.hints} pista${ctx.hints > 1 ? 's' : ''}` : ''}${ctx.skipped ? ` · ${ctx.skipped} saltado${ctx.skipped > 1 ? 's' : ''}` : ''}</p>
    <div class="modal-actions"><button class="btn primary" data-choice="next">${nxt.type === 'lesson' ? `Siguiente: ${esc(nxt.title)}` : nxt.type === 'trial' ? 'A las pruebas finales' : 'Volver'}</button><button class="btn" data-choice="back">Academia</button></div></div>`, 'result-card');
  if (pick === 'next' && nxt.type === 'lesson') return runLesson(nxt.id);
  if (pick === 'next' && nxt.type === 'trial') return app.startTrial(nxt.index);
  closeSession();
  return app.go('academy');
}

export async function runLesson(id) {
  const lesson = LESSONS[id];
  if (!lesson || run.active) return;
  const start = await choice(`<p class="eyebrow">${esc(STAGES.find((s) => s.id === lesson.stage).name)}</p><h3>${esc(lesson.title)}</h3><p>${esc(lesson.intro)}</p>
    <p class="muted">${lesson.exercises.length} ejercicios · puedes usar pistas o saltar uno.</p>
    <div class="modal-actions"><button class="btn primary" data-choice="go">Empezar</button><button class="btn" data-choice="no">Ahora no</button></div>`, 'result-card');
  if (start !== 'go') return;
  run.active = true;
  const ctx = { mistakes: 0, hints: 0, skipped: 0 };
  try {
    for (let i = 0; i < lesson.exercises.length; i += 1) {
      const ex = lesson.exercises[i];
      const n = lesson.exercises.length;
      const r = ex.kind === 'quiz' ? await runQuiz(ex) : ex.kind === 'play' ? await runPlay(ex, i, n) : await runBoard(ex, i, n);
      ctx.mistakes += r.mistakes ?? 0;
      ctx.hints += r.hints ?? 0;
      if (r.exit) {
        run.active = false;
        closeSession();
        enterAcademy();
        return;
      }
      if (r.skipped) ctx.skipped += 1;
      else acad().ex[ex.id] = true;
    }
  } finally {
    run.active = false;
    run.cancel = null;
  }
  await completeLesson(lesson, ctx);
}

export function initAcademy() {
  $('#screen-academy').addEventListener('click', (e) => {
    const l = e.target.closest('[data-ac-lesson]');
    if (l) return runLesson(l.dataset.acLesson);
    const t = e.target.closest('[data-ac-trial]');
    if (t) return app.startTrial(Number(t.dataset.acTrial));
    if (e.target.closest('[data-ac-continue]')) return academyContinue();
    if (e.target.closest('[data-ac-skip]')) return skipLevel();
    return undefined;
  });
  // Botones del banner de la lección (pista, saltar, continuar).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ac]');
    if (!b || !run.active) return;
    if (b.dataset.ac === 'hint') run.hint?.();
    if (b.dataset.ac === 'skip') run.skip?.();
    if (b.dataset.ac === 'next') run.next?.();
  });
  void GLYPH;
  void VS;
}
