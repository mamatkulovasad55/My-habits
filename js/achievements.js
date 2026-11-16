// Личные достижения: каталог (конфиг) и расчёт из уже существующих данных.
// Значок выдаётся задним числом с фактической датой и хранится в data.achievements — однажды полученное не пропадает.
// Модуль только для приложения (бот его не импортирует, о достижениях не пишет).
import { getData, habitsAll, habitsActive, abstainAll, getEvents, QADA_LOG } from './store.js';
import { isDone, firstDay, isScheduled, currentStreak, abstainElapsed } from './logic.js';
import { isNamazHabit, stagesForDay, stageStatus, stageMark, prayerKeyOf } from './schedule.js';
import { dkey, today, addDays, startOfWeek, DAY_FORMS } from './util.js';

const DAY = 864e5;

/** Группы экрана достижений. private — скрывается, пока раздел защищён и заблокирован. */
export const ACH_GROUPS = [
  { id: 'namaz', title: 'Намаз' },
  { id: 'qada', title: 'Каза' },
  { id: 'habits', title: 'Привычки' },
  { id: 'abstain', title: 'Воздержание', private: true },
];

/**
 * Каталог. Чтобы добавить достижение — новая строка с существующей метрикой (или новая метрика в METRICS).
 * Каждый уровень — отдельный значок с id `${id}-${level}`.
 */
export const ACH_CATALOG = [
  { id: 'fard-ontime', group: 'namaz', icon: '🕌', title: 'Пять фардов вовремя', hint: 'дней подряд все 5 фардов вовремя', levels: [7, 30, 100], unitForms: DAY_FORMS, metric: 'fardOntimeRun' },
  { id: 'juma', group: 'namaz', icon: '🤲', title: 'Джума', hint: 'пятниц подряд на Джума', levels: [4, 12, 52], unitForms: ['пятница', 'пятницы', 'пятниц'], metric: 'jumaRun' },
  { id: 'qada-total', group: 'qada', icon: '⏳', title: 'Восполнение', hint: 'намазов каза восполнено всего', levels: [10, 50, 100], unitForms: ['намаз', 'намаза', 'намазов'], metric: 'qadaTotal' },
  { id: 'habit-streak', group: 'habits', icon: '🔥', title: 'Серия', hint: 'дней подряд по любой привычке', levels: [7, 30, 100], unitForms: DAY_FORMS, metric: 'habitStreak' },
  { id: 'abstain-days', group: 'abstain', icon: '🛡️', title: 'Без срыва', hint: 'дней подряд без срыва', levels: [7, 30, 90], unitForms: DAY_FORMS, metric: 'abstainDays' },
];

/** Все значки (по уровням). */
export const ACH_BADGES = ACH_CATALOG.flatMap((c) => c.levels.map((level) => ({ ...c, badgeId: `${c.id}-${level}`, level })));
export const badgeById = (id) => ACH_BADGES.find((b) => b.badgeId === id) || null;
export const groupOf = (badge) => ACH_GROUPS.find((g) => g.id === badge?.group);

// ---------- Серии с датами ----------

/**
 * Пройти последовательность «периодов» и записать дату, когда серия впервые дошла до каждого уровня.
 * steps — [{ ok: true|false|null, key, weight }]: null — пропуск (не по расписанию / сегодня ещё идёт).
 */
function runReach(steps, levels) {
  const reached = {};
  let run = 0;
  let best = 0;
  for (const s of steps) {
    if (s.ok === null) continue;
    if (!s.ok) {
      run = 0;
      continue;
    }
    run += s.weight || 1;
    best = Math.max(best, run);
    for (const L of levels) if (run >= L && !reached[L]) reached[L] = s.key;
  }
  return { reached, best, run };
}

/** Серия привычки по дням (как bestStreak / currentStreak в logic.js), с датами. */
export function habitRunSteps(h, t = today()) {
  const first = firstDay(h);
  const steps = [];
  if (h.schedule?.kind === 'perWeek') {
    // неделя = 7 дней; дата — день, когда выполнена норма недели
    const times = h.schedule.times || 1;
    for (let ws = startOfWeek(first); ws <= t; ws = addDays(ws, 7)) {
      const current = +ws === +startOfWeek(t);
      let cnt = 0;
      let doneDay = null;
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i);
        if (d > t) break;
        if (isDone(h, d) && ++cnt >= times) {
          doneDay = dkey(d); // норма недели выполнена в этот день
          break;
        }
      }
      steps.push({ ok: doneDay ? true : current ? null : false, key: doneDay || dkey(ws), weight: 7 });
    }
    return steps;
  }
  for (let d = first, i = 0; d <= t && i < 3700; d = addDays(d, 1), i++) {
    if (!isScheduled(h, d)) continue;
    const done = isDone(h, d);
    steps.push({ ok: done ? true : +d === +t ? null : false, key: dkey(d) });
  }
  return steps;
}

// ---------- Метрики ----------

const FARD = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const ONTIME = new Set(['ontime', 'late']); // «позже» = прочитан вовремя, отмечен позже

function namazHabits() {
  return habitsAll().filter(isNamazHabit);
}

/** Дни, когда все 5 фардов вовремя: true / false / null (сегодня, ещё не всё отмечено). */
function fardSteps(t = today()) {
  const hs = namazHabits();
  if (!hs.length) return [];
  const start = hs.map(firstDay).reduce((a, b) => (a < b ? a : b));
  const steps = [];
  for (let d = start, i = 0; d <= t && i < 3700; d = addDays(d, 1), i++) {
    const st = {};
    for (const h of hs) {
      if (!isScheduled(h, d)) continue;
      for (const s of stagesForDay(h, d)) {
        const p = prayerKeyOf(s);
        if (!FARD.includes(p)) continue;
        const status = stageStatus(h, d, s);
        // несколько привычек с одним намазом: засчитан, если вовремя хотя бы в одной
        if (!st[p] || ONTIME.has(status)) st[p] = status;
      }
    }
    const all = FARD.every((p) => ONTIME.has(st[p]));
    const isToday = +d === +t;
    steps.push({ ok: all ? true : isToday ? null : false, key: dkey(d) });
  }
  return steps;
}

/** Пятницы: Джума отмечена? (сегодняшняя пятница без отметки — пропуск). */
function jumaSteps(t = today()) {
  const hs = namazHabits();
  if (!hs.length) return [];
  let d = hs.map(firstDay).reduce((a, b) => (a < b ? a : b));
  while (d.getDay() !== 5) d = addDays(d, 1);
  const steps = [];
  for (let i = 0; d <= t && i < 600; d = addDays(d, 7), i++) {
    let juma = false;
    let slot = false;
    for (const h of hs) {
      if (!isScheduled(h, d)) continue;
      for (const s of stagesForDay(h, d)) {
        if (prayerKeyOf(s) !== 'dhuhr') continue;
        slot = true;
        if (stageMark(h, d, s)?.k === 'juma') juma = true;
      }
    }
    if (!slot) continue;
    steps.push({ ok: juma ? true : +d === +t ? null : false, key: dkey(d) });
  }
  return steps;
}

/** Лента восполнений каза: [{ ts, d }] по времени. */
function qadaTimeline() {
  const out = [];
  for (const h of namazHabits()) {
    for (const day of Object.keys(getData().logs[h.id] || {})) {
      const date = new Date(`${day}T12:00:00`);
      for (const s of stagesForDay(h, date)) {
        if (!prayerKeyOf(s) || stageStatus(h, date, s) !== 'qada') continue; // отменённые отметки не считаются
        out.push({ ts: stageMark(h, day, s)?.ts || date.getTime(), d: 1 });
      }
    }
  }
  for (const [day, e] of Object.entries(getData().logs[QADA_LOG] || {})) {
    void e;
    for (const ev of getEvents(QADA_LOG, day)) if (ev.d) out.push({ ts: ev.ts || new Date(`${day}T12:00:00`).getTime(), d: Number(ev.d) || 0 });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export const METRICS = {
  fardOntimeRun: (levels) => {
    const r = runReach(fardSteps(), levels);
    return { current: r.run, reached: r.reached };
  },
  jumaRun: (levels) => {
    const r = runReach(jumaSteps(), levels);
    return { current: r.run, reached: r.reached };
  },
  qadaTotal: (levels) => {
    const reached = {};
    let sum = 0;
    for (const ev of qadaTimeline()) {
      sum += ev.d;
      for (const L of levels) if (sum >= L && !reached[L]) reached[L] = dkey(new Date(ev.ts));
    }
    return { current: Math.max(0, sum), reached };
  },
  habitStreak: (levels) => {
    // получение — по всем привычкам, включая архивные (история остаётся); дата — самая ранняя
    const reached = {};
    for (const h of habitsAll()) {
      const r = runReach(habitRunSteps(h), levels);
      for (const [L, k] of Object.entries(r.reached)) if (!reached[L] || k < reached[L]) reached[L] = k;
    }
    // прогресс — как «Серия сейчас» в «Статистике»
    let current = 0;
    for (const h of habitsActive()) {
      const c = currentStreak(h);
      current = Math.max(current, c.unit === 'weeks' ? c.value * 7 : c.value);
    }
    return { current, reached };
  },
  abstainDays: (levels, now = Date.now()) => {
    const reached = {};
    let current = 0;
    for (const a of abstainAll()) {
      const tries = [...(a.attempts || []).map((x) => ({ start: x.start, end: x.end })), { start: a.startedAt, end: now }];
      for (const t of tries) {
        for (const L of levels) {
          const at = t.start + L * DAY;
          if (at <= t.end && at <= now) {
            const k = dkey(new Date(at));
            if (!reached[L] || k < reached[L]) reached[L] = k;
          }
        }
      }
      current = Math.max(current, Math.floor(abstainElapsed(a, now) / DAY));
    }
    return { current, reached };
  },
};

/** Прогресс и даты по всему каталогу: { [catalogId]: { current, reached } }. */
export function computeAchievements() {
  const out = {};
  for (const c of ACH_CATALOG) {
    try {
      out[c.id] = METRICS[c.metric](c.levels);
    } catch (e) {
      console.error('achievement metric', c.id, e);
      out[c.id] = { current: 0, reached: {} };
    }
  }
  return out;
}

/** Значки, которые уже заработаны по данным: [{ id, earnedAt }]. */
export function earnedFromData(progress = computeAchievements()) {
  const out = [];
  for (const b of ACH_BADGES) {
    const k = progress[b.id]?.reached?.[b.level];
    if (k) out.push({ id: b.badgeId, earnedAt: k });
  }
  return out;
}
