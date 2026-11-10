// Бизнес-логика: расписания, серии, проценты, воздержание, достижения.
import { getData, getLog, getStageLog, habitsActive, habitsAll, abstainAll, subscribe } from './store.js';
import { addDays, dkey, parseKey, startOfDay, startOfWeek, today, plural, DAY_FORMS, TIMES_FORMS, WEEKDAYS_SHORT } from './util.js';

const DAY = 86400000;

// ================= Полезные привычки =================

export const hasStages = (h) => Array.isArray(h.stages) && h.stages.length > 0;

/** Выполнен ли этап за день (для галочки — 1, для количества — минимум этапа). */
export function stageDone(h, day, s) {
  const need = h.type === 'count' ? Math.max(1, Number(s.min) || 1) : 1;
  return getStageLog(h.id, typeof day === 'string' ? day : dkey(day), s.id) >= need;
}

const keyOf = (day) => (typeof day === 'string' ? day : dkey(day));

/** Активен ли этап в этот день (этап, добавленный позже, не портит прошлую статистику). */
export const stageActive = (s, day) => !s.since || keyOf(day) >= s.since;
export const activeStages = (h, day) => (h.stages || []).filter((s) => (day ? stageActive(s, day) : true));

/** Цель в «единицах лога»: галочка — 1 (или число этапов), количество — target, таймер — секунды. */
export function goalOf(h, day) {
  if (h.type === 'check' && hasStages(h)) return Math.max(1, activeStages(h, day).length);
  if (h.type === 'count') return Math.max(1, Number(h.target) || 1);
  if (h.type === 'timer') return Math.max(1, Number(h.target) || 1) * 60;
  return 1;
}

export function valueOf(h, day) {
  // для привычки-галочки с этапами значение = число отмеченных активных этапов
  if (h.type === 'check' && hasStages(h)) return activeStages(h, day).filter((s) => stageDone(h, day, s)).length;
  return getLog(h.id, keyOf(day));
}
export const progressOf = (h, day) => Math.min(1, valueOf(h, day) / goalOf(h, day));
export const isDone = (h, day) => valueOf(h, day) >= goalOf(h, day);

// кэш первых дней — сбрасывается при любом изменении данных
const firstCache = new Map();
subscribe(() => firstCache.clear());

/** Первый день привычки: дата создания или самая ранняя отметка. */
export function firstDay(h) {
  if (!firstCache.has(h.id)) firstCache.set(h.id, computeFirstDay(h));
  return firstCache.get(h.id);
}

function computeFirstDay(h) {
  let first = startOfDay(new Date(h.createdAt || Date.now()));
  const logs = getData().logs[h.id] || {};
  for (const k of Object.keys(logs)) {
    if ((logs[k].v || 0) > 0) {
      const d = parseKey(k);
      if (d < first) first = d;
    }
  }
  return first;
}

export function doneInWeek(h, date, { before = false } = {}) {
  const ws = startOfWeek(date);
  const limit = before ? daysIntoWeek(date) : 7;
  let n = 0;
  for (let i = 0; i < limit; i++) if (isDone(h, addDays(ws, i))) n++;
  return n;
}
const daysIntoWeek = (d) => (d.getDay() + 6) % 7;

/** Запланирована ли привычка на этот день (для дней недели/ежедневных). */
export function isScheduled(h, date) {
  const s = h.schedule || { kind: 'daily' };
  if (s.kind === 'weekdays') return (s.days || []).includes(date.getDay());
  if (s.kind === 'perWeek') {
    // «N раз в неделю»: нужна, пока недельная норма не выполнена (или если уже сделана сегодня)
    return doneInWeek(h, date, { before: true }) < (s.times || 1) || isDone(h, date);
  }
  return true;
}

/** Учитывается ли привычка в итогах дня (для N-в-неделю — только если сделана). */
export function countsForDay(h, date) {
  const s = h.schedule || { kind: 'daily' };
  if (s.kind === 'perWeek') return isDone(h, date);
  return isScheduled(h, date);
}

export function scheduleText(h) {
  const s = h.schedule || { kind: 'daily' };
  if (s.kind === 'weekdays') {
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => (s.days || []).includes(d));
    if (days.length === 7) return 'Каждый день';
    if (days.length === 5 && !days.includes(0) && !days.includes(6)) return 'По будням';
    if (days.length === 2 && days.includes(0) && days.includes(6)) return 'По выходным';
    return days.map((d) => WEEKDAYS_SHORT[d]).join(', ');
  }
  if (s.kind === 'perWeek') return `${s.times} ${plural(s.times, TIMES_FORMS)} в неделю`;
  return 'Каждый день';
}

export function goalText(h) {
  if (h.type === 'count') return `${h.target} ${h.unit || ''}`.trim();
  if (h.type === 'timer') return `${h.target} мин`;
  return '';
}

const isPerWeek = (h) => h.schedule?.kind === 'perWeek';

/** Текущая серия. Для «N в неделю» — в неделях. */
export function currentStreak(h) {
  const t = today();
  const first = firstDay(h);
  let n = 0;
  if (isPerWeek(h)) {
    const times = h.schedule.times || 1;
    let ws = startOfWeek(t);
    if (doneInWeek(h, ws) < times) ws = addDays(ws, -7); // текущая неделя ещё идёт
    while (ws >= startOfWeek(first) && doneInWeek(h, ws) >= times) {
      n++;
      ws = addDays(ws, -7);
    }
    return { value: n, unit: 'weeks' };
  }
  for (let d = t, i = 0; d >= first && i < 3700; d = addDays(d, -1), i++) {
    if (!isScheduled(h, d)) continue;
    if (isDone(h, d)) n++;
    else if (+d === +t) continue; // сегодня ещё не вечер
    else break;
  }
  return { value: n, unit: 'days' };
}

export function bestStreak(h) {
  const t = today();
  const first = firstDay(h);
  let best = 0;
  let run = 0;
  if (isPerWeek(h)) {
    const times = h.schedule.times || 1;
    for (let ws = startOfWeek(first); ws <= t; ws = addDays(ws, 7)) {
      if (doneInWeek(h, ws) >= times) best = Math.max(best, ++run);
      else if (+ws !== +startOfWeek(t)) run = 0;
    }
    return { value: best, unit: 'weeks' };
  }
  for (let d = first, i = 0; d <= t && i < 3700; d = addDays(d, 1), i++) {
    if (!isScheduled(h, d)) continue;
    if (isDone(h, d)) best = Math.max(best, ++run);
    else if (+d !== +t) run = 0;
  }
  return { value: best, unit: 'days' };
}

export function streakText(s) {
  return s.unit === 'weeks' ? `${s.value} нед.` : `${s.value} ${plural(s.value, DAY_FORMS)}`;
}

/** Процент выполнения привычки за последние n дней. */
export function rateOf(h, days = 30) {
  const t = today();
  const first = firstDay(h);
  const from = addDays(t, -(days - 1)) > first ? addDays(t, -(days - 1)) : first;
  if (isPerWeek(h)) {
    const times = h.schedule.times || 1;
    let got = 0;
    let need = 0;
    for (let ws = startOfWeek(from); ws <= t; ws = addDays(ws, 7)) {
      const done = doneInWeek(h, ws);
      const current = +ws === +startOfWeek(t);
      if (current && done < times) continue;
      got += Math.min(done, times);
      need += times;
    }
    return need ? got / need : null;
  }
  let got = 0;
  let need = 0;
  for (let d = from; d <= t; d = addDays(d, 1)) {
    if (!isScheduled(h, d)) continue;
    const done = isDone(h, d);
    if (+d === +t && !done) continue;
    need++;
    if (done) got++;
  }
  return need ? got / need : null;
}

export function totalCompletions(h) {
  const logs = getData().logs[h.id] || {};
  return Object.keys(logs).filter((day) => isDone(h, day)).length;
}

/** Итог дня по всем активным привычкам: {done, total, ratio} */
export function dayStats(date, habits = habitsAll().filter((h) => !h.archived)) {
  const key = dkey(date);
  let done = 0;
  let total = 0;
  let sum = 0;
  for (const h of habits) {
    if (firstDay(h) > date) continue;
    if (!countsForDay(h, date)) continue;
    total++;
    const p = progressOf(h, key);
    sum += p;
    if (p >= 1) done++;
  }
  return { done, total, ratio: total ? sum / total : null };
}

export function rangeRate(days) {
  const t = today();
  let sum = 0;
  let n = 0;
  for (let i = 0; i < days; i++) {
    const d = addDays(t, -i);
    const s = dayStats(d);
    if (s.ratio === null) continue;
    if (i === 0 && s.ratio < 1) continue;
    sum += s.ratio;
    n++;
  }
  return n ? sum / n : null;
}

// ================= Воздержание =================

export const MILESTONES = [
  { days: 1, label: '1 день' },
  { days: 3, label: '3 дня' },
  { days: 7, label: '1 неделя' },
  { days: 14, label: '2 недели' },
  { days: 30, label: '1 месяц' },
  { days: 60, label: '2 месяца' },
  { days: 90, label: '3 месяца' },
  { days: 180, label: '6 месяцев' },
  { days: 365, label: '1 год' },
  { days: 730, label: '2 года' },
];

export const abstainElapsed = (a, now = Date.now()) => Math.max(0, now - a.startedAt);

export function abstainBest(a, now = Date.now()) {
  let best = abstainElapsed(a, now);
  for (const at of a.attempts || []) best = Math.max(best, at.end - at.start);
  return best;
}

export function milestoneInfo(ms) {
  const days = ms / DAY;
  let prev = null;
  for (const m of MILESTONES) {
    if (days < m.days) {
      const fromDays = prev ? prev.days : 0;
      return { reached: prev, next: m, progress: (days - fromDays) / (m.days - fromDays) };
    }
    prev = m;
  }
  return { reached: prev, next: null, progress: 1 };
}

export const isCleanDay = (a, key) => (a.cleanDays || []).includes(key);

/** Дни срывов (для календаря). */
export function relapseDays(a) {
  return new Set((a.attempts || []).map((x) => dkey(new Date(x.end))));
}

// ================= Тепловая карта / графики =================

export function habitHeatValue(h) {
  const first = firstDay(h);
  const t = today();
  return (date) => {
    if (date > t || date < first) return null;
    if (!isScheduled(h, date) && !isDone(h, date)) return isPerWeek(h) ? 0 : null;
    return progressOf(h, dkey(date));
  };
}

export function overallHeatValue() {
  const t = today();
  const habits = habitsAll().filter((h) => !h.archived);
  return (date) => {
    if (date > t) return null;
    return dayStats(date, habits).ratio;
  };
}

// ================= Достижения =================

export function achievements() {
  const habits = habitsAll();
  const abst = abstainAll();
  const t = today();

  let bestDays = 0;
  let total = 0;
  for (const h of habits) {
    const b = bestStreak(h);
    bestDays = Math.max(bestDays, b.unit === 'weeks' ? b.value * 7 : b.value);
    total += totalCompletions(h);
  }

  // идеальные дни за последний год
  let perfect = 0;
  let run = 0;
  let bestRun = 0;
  if (habits.length) {
    for (let i = 365; i >= 0; i--) {
      const d = addDays(t, -i);
      const s = dayStats(d, habits.filter((h) => !h.archived));
      if (s.total > 0 && s.done === s.total) {
        perfect++;
        bestRun = Math.max(bestRun, ++run);
      } else if (i !== 0) run = 0;
    }
  }

  const abBest = abst.reduce((m, a) => Math.max(m, abstainBest(a)), 0) / DAY;
  const cleanTotal = abst.reduce((m, a) => m + (a.cleanDays || []).length, 0);

  const list = [
    { emoji: '🌱', title: 'Первый шаг', desc: 'Выполни любую привычку', ok: total >= 1 },
    { emoji: '✨', title: 'Идеальный день', desc: 'Все привычки дня выполнены', ok: perfect >= 1 },
    { emoji: '🔥', title: 'Неделя в ритме', desc: 'Серия 7 дней', ok: bestDays >= 7 },
    { emoji: '🏅', title: 'Месяц дисциплины', desc: 'Серия 30 дней', ok: bestDays >= 30 },
    { emoji: '💎', title: 'Сотня', desc: 'Серия 100 дней', ok: bestDays >= 100 },
    { emoji: '🗓️', title: 'Идеальная неделя', desc: '7 идеальных дней подряд', ok: bestRun >= 7 },
    { emoji: '💯', title: '100 отметок', desc: 'Выполни привычки 100 раз', ok: total >= 100 },
    { emoji: '🚀', title: '500 отметок', desc: 'Выполни привычки 500 раз', ok: total >= 500 },
    { emoji: '🛡️', title: 'Первые сутки', desc: 'Сутки без вредной привычки', ok: abBest >= 1 },
    { emoji: '💪', title: 'Неделя силы воли', desc: '7 дней без срыва', ok: abBest >= 7 },
    { emoji: '🧠', title: 'Новая норма', desc: '30 дней без срыва', ok: abBest >= 30 },
    { emoji: '🦁', title: 'Свобода', desc: '100 дней без срыва', ok: abBest >= 100 },
    { emoji: '👑', title: 'Год свободы', desc: '365 дней без срыва', ok: abBest >= 365 },
    { emoji: '🍃', title: '50 чистых дней', desc: 'Отметь 50 чистых дней', ok: cleanTotal >= 50 },
  ];
  return { list, total, perfect, bestDays, habitsCount: habitsActive().length };
}
