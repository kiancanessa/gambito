// Eventos de comunidad: torneos organizados por creadores (base extensible, PROMPT 07 · fase 3).
//
// Un torneo de creador reutiliza el motor del Royale Circuit (inscripción con plazo, cuadro, partidas arbitradas por el servidor,
// espectadores con retraso), pero NO da premios, XP ni logros: así no hay incentivo para montar torneos con cuentas propias.
// Para evitar el spam: hace falta cierta actividad verificada (nivel de cuenta), pocos eventos activos y pocos al día; las cuentas
// en revisión o restringidas no pueden organizar. La tabla `community_events.kind` deja sitio a otros tipos de evento.
export const EVENT_RULES = {
  minLevel: 3, // actividad mínima (el nivel solo sube con XP verificada por el servidor)
  maxActive: 2, // eventos vivos por organizador
  perDay: 3, // creaciones por organizador en 24 h
  sizes: [4, 8, 16],
  timeControls: ['blitz3_2', 'blitz5', 'rapid10'],
  minLeadMs: 10 * 60_000, // empieza dentro de 10 min como pronto
  maxLeadMs: 14 * 24 * 3600_000, // y dentro de 14 días como tarde
  titleLen: [4, 40],
  descLen: 200,
};

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
// Texto de organizador: sin caracteres de control, sin enlaces y sin marcado (además, todo se escapa al mostrarlo).
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const hasLink = (s) => /https?:|www\.|\.(com|net|org|gg|io)\b/i.test(s);

export function createCommunity({ db, circuit, wallets, now = Date.now }) {
  function create(userId, input = {}) {
    const t = now();
    const user = db.userById(userId);
    if (!user) throw fail(404, 'Cuenta no encontrada', 'unknown');
    if (db.community.moderation(userId).status !== 'ok') throw fail(403, 'Tu cuenta no puede organizar eventos ahora mismo', 'restricted');
    if (wallets.ensure(userId).level < EVENT_RULES.minLevel) throw fail(403, `Necesitas el nivel ${EVENT_RULES.minLevel} de cuenta para organizar un evento`, 'level');
    const title = clean(input.title, EVENT_RULES.titleLen[1]);
    const description = clean(input.description, EVENT_RULES.descLen);
    if (title.length < EVENT_RULES.titleLen[0]) throw fail(400, 'El título debe tener entre 4 y 40 caracteres', 'title');
    if (hasLink(title) || hasLink(description)) throw fail(400, 'Los eventos no pueden incluir enlaces', 'link');
    const size = Number(input.size);
    if (!EVENT_RULES.sizes.includes(size)) throw fail(400, 'Tamaño no válido (4, 8 o 16 jugadores)', 'size');
    if (!EVENT_RULES.timeControls.includes(input.tc)) throw fail(400, 'Control de tiempo no válido', 'tc');
    const startsAt = Number(input.startsAt);
    if (!Number.isFinite(startsAt) || startsAt < t + EVENT_RULES.minLeadMs || startsAt > t + EVENT_RULES.maxLeadMs) throw fail(400, 'La hora de inicio debe estar entre 10 minutos y 14 días desde ahora', 'time');
    if (db.community.activeEventsOf(userId) >= EVENT_RULES.maxActive) throw fail(429, `Ya tienes ${EVENT_RULES.maxActive} eventos activos`, 'active');
    if (db.community.eventsCreatedSince(userId, t - 24 * 3600_000) >= EVENT_RULES.perDay) throw fail(429, 'Has creado demasiados eventos hoy', 'daily');
    return circuit.scheduleCommunity({ creatorId: userId, creatorName: user.name, title, description, size, tc: input.tc, startsAt }, t);
  }

  function cancel(userId, tournamentId) {
    const r = circuit.cancelByOrganizer(typeof tournamentId === 'string' ? tournamentId.slice(0, 64) : '', userId);
    if (!r.ok) throw fail(r.reason === 'started' ? 409 : 404, r.reason === 'started' ? 'El evento ya ha empezado' : 'Evento no encontrado', r.reason);
    return r;
  }

  return { create, cancel, rules: EVENT_RULES };
}
