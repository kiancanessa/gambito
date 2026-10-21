// Tutorial interactivo de 1 minuto: cada paso es una mini posición con un objetivo.
import { sfx } from './fx.js';
import { startSession, setBanner } from './session.js';
import { addCoins, save, state } from './store.js';
import { $, app, celebrate, choice, toast } from './ui.js';

const STEPS = [
  { fen: 'k7/8/8/8/8/8/4P3/4K3 w - - 0 1', title: 'El peón', text: 'Los peones avanzan hacia delante: una casilla, o dos desde su fila inicial. Mueve el peón blanco.', goal: (m) => m.piece === 'p' },
  { fen: '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', title: 'Capturas del peón', text: 'Los peones capturan en diagonal. Come el peón negro.', goal: (m) => !!m.captured },
  { fen: '4k3/8/8/8/8/2p5/8/1N2K3 w - - 0 1', title: 'El caballo', text: 'El caballo salta en forma de L y puede saltar sobre otras piezas. Captura el peón.', goal: (m) => !!m.captured },
  { fen: '7k/8/8/6p1/8/8/8/2B1K3 w - - 0 1', title: 'El alfil', text: 'El alfil se mueve en diagonal, tan lejos como pueda. Captura el peón.', goal: (m) => !!m.captured },
  { fen: 'k7/8/8/8/p7/8/8/R3K3 w - - 0 1', title: 'La torre', text: 'La torre recorre filas y columnas. Captura el peón del fondo.', goal: (m) => !!m.captured },
  { fen: '7k/8/8/8/3p4/8/8/3QK3 w - - 0 1', title: 'La reina', text: 'La reina combina torre y alfil: la pieza más poderosa. Captura el peón.', goal: (m) => !!m.captured },
  { fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', title: 'El rey', text: 'El rey se mueve una casilla en cualquier dirección. Si lo pierdes, pierdes la partida: protégelo.', goal: (m) => m.piece === 'k' },
  { fen: '7k/4P3/8/8/8/8/8/K7 w - - 0 1', title: 'La coronación', text: 'Si un peón llega al final del tablero se convierte en otra pieza. ¡Corónalo!', goal: (m) => !!m.promotion },
  { fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', title: 'Jaque', text: 'Cuando atacas al rey rival das jaque, y debe escapar. Da jaque con la torre.', goal: (m) => m.san.includes('+') },
  { fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', title: 'Jaque mate', text: 'Si el rey está en jaque y no puede escapar, ¡jaque mate y ganas! Su propio peón le tapa la salida. Remátalo.', goal: (m) => m.san.endsWith('#') },
];

let idx = 0;
let active = false;

const bannerHtml = (i) =>
  `<span>🎓 <b>${STEPS[i].title}</b> · ${STEPS[i].text}</span>
   <span class="dots">${STEPS.map((_, k) => `<i class="${k < i ? 'on' : k === i ? 'now' : ''}"></i>`).join('')}</span>
   <button class="link-btn" data-skip-tutorial>Saltar</button>`;

async function finish(completed) {
  active = false;
  if (completed && !state.tutorialDone) {
    state.tutorialDone = true;
    addCoins(100, { source: 'tutorial', key: 'tutorial' });
    save();
    sfx.win();
    celebrate();
    const pick = await choice(`<div class="result win"><p class="eyebrow">Tutorial</p><h2>¡Ya sabes jugar!</h2>
      <p>Has completado el tutorial y ganas <b>+100 🪙</b>. Ahora demuestra lo que sabes.</p>
      <div class="modal-actions"><button class="btn primary" data-choice="academy">🎓 A la Academia</button><button class="btn" data-choice="online">🌐 Jugar online</button><button class="btn" data-choice="home">Inicio</button></div></div>`, 'result-card');
    await app.go(pick);
  } else {
    toast(completed ? '¡Tutorial repetido!' : 'Tutorial omitido: puedes repetirlo desde el inicio');
    await app.go('home');
  }
}

export function startTutorial() {
  idx = 0;
  active = true;
  startSession({
    opp: { name: 'Pip el Granjero', title: 'Tu guía', glyph: 'p', color: '#8bc34a' },
    playerColor: 'w',
    fen: STEPS[0].fen,
    onEnd: () => {},
    scripted: (move, game) => {
      if (STEPS[idx].goal(move)) {
        sfx.coin();
        toast('✓ ¡Muy bien!', 1200);
        idx += 1;
        if (idx >= STEPS.length) {
          setTimeout(() => finish(true), 1300);
          return;
        }
        setTimeout(() => {
          game.loadFen(STEPS[idx].fen);
          setBanner(bannerHtml(idx));
        }, 1000);
      } else {
        toast('Casi... ¡prueba otra jugada!', 1500);
        setTimeout(() => game.undoLast(), 600);
      }
    },
    ui: { banner: bannerHtml(0), hint: false, undo: false, resign: false, meSub: 'Tutorial' },
  });
}

export function initTutorial() {
  document.addEventListener('click', (e) => {
    if (active && e.target.closest('[data-skip-tutorial]')) finish(false);
  });
  $('#tutorialBtn').addEventListener('click', startTutorial);
}
