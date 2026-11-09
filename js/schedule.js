// Расписание этапов и напоминаний. Чистая логика: используется и в приложении, и в Cloudflare Worker.
import { prayerTimes, tzOffsetHours, PRAYER_NAME, fmtMin } from './prayer.js';
import { getData, habitsActive, abstainAll, getEvents } from './store.js';
import { isScheduled, isDone, valueOf, hasStages, stageDone, firstDay } from './logic.js';
import { dkey, plural, addDays, today } from './util.js';

export const parseHM = (s) => {
  const [h, m] = String(s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

/** Контекст дня: режим (подъём/сон) и время намазов. date — «наивная» местная дата. */
export function dayContext(date, settings = getData().settings) {
  const we = isWeekend(date);
  const wake = parseHM(we ? settings.wakeWe : settings.wakeWd);
  let sleep = parseHM(we ? settings.sleepWe : settings.sleepWd);
  if (sleep <= wake) sleep += 1440;
  const noon = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  const offset = tzOffsetHours(settings.tz, noon);
  const prayers = prayerTimes(date.getFullYear(), date.getMonth() + 1, date.getDate(), settings.prayer, offset);
  return { wake, sleep, prayers, settings };
}

/** Время (минуты от полуночи) по описанию: точное / после подъёма / до сна / намаз. */
export function resolveTime(time, ctx) {
  if (!time) return null;
  const n = Number(time.minutes) || 0;
  switch (time.mode) {
    case 'afterWake': return ctx.wake + n;
    case 'beforeSleep': return ctx.sleep - n;
    case 'prayer': return ctx.prayers[time.prayer] != null ? ctx.prayers[time.prayer] + n : null;
    default: return parseHM(time.at);
  }
}

export function timeLabel(time) {
  if (!time) return '';
  const n = Number(time.minutes) || 0;
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}` : `${m} мин`);
  switch (time.mode) {
    case 'afterWake': return n ? `через ${dur(n)} после подъёма` : 'сразу после подъёма';
    case 'beforeSleep': return n ? `за ${dur(n)} до сна` : 'перед сном';
    case 'prayer': return `${PRAYER_NAME[time.prayer] || ''}${n ? (n > 0 ? ` +${n} мин` : ` ${n} мин`) : ''}`;
    default: return time.at || '';
  }
}

const PRAYER_NEXT = { fajr: 'sunrise', dhuhr: 'asr', asr: 'maghrib', maghrib: 'isha', isha: null };

/** Этапы привычки на день с окнами времени [start, end). */
export function stagesForDay(h, date, ctx = dayContext(date)) {
  if (!hasStages(h)) return [];
  const list = h.stages.map((s) => ({ ...s, start: resolveTime(s.time, ctx) }));
  const sorted = [...list].filter((s) => s.start != null).sort((a, b) => a.start - b.start);
  for (const s of list) {
    if (s.start == null) continue;
    if (s.time?.mode === 'prayer') {
      const nx = PRAYER_NEXT[s.time.prayer];
      s.end = nx ? ctx.prayers[nx] : ctx.prayers.fajr + 1440;
    } else {
      const next = sorted.find((x) => x.start > s.start);
      s.end = next ? next.start : Math.max(s.start + 60, ctx.sleep);
    }
  }
  return list;
}

/** Текущий этап: последний начавшийся невыполненный, иначе ближайший невыполненный. */
export function currentStage(h, date, nowMin, ctx) {
  const key = dkey(date);
  const st = stagesForDay(h, date, ctx);
  const undone = st.filter((s) => !stageDone(h, key, s));
  if (!undone.length) return null;
  const started = undone.filter((s) => s.start != null && s.start <= nowMin);
  if (started.length) return started.sort((a, b) => b.start - a.start)[0];
  return undone.sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999))[0];
}

function inQuiet(min, settings) {
  const q = settings.quiet;
  if (!q?.enabled) return false;
  const a = parseHM(q.from);
  const b = parseHM(q.to);
  const m = ((min % 1440) + 1440) % 1440;
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

/**
 * Какие напоминания должны сработать в окне минут (fromMin, toMin] дня date.
 * Возвращает [{ key, title, body, url }]; key уникален для дня — для защиты от повторов.
 */
export function dueReminders(date, fromMin, toMin) {
  const data = getData();
  const settings = data.settings;
  const ctx = dayContext(date, settings);
  const key = dkey(date);
  const out = [];
  const inWindow = (m) => m != null && m > fromMin && m <= toMin;
  const repeat = Number(settings.repeatMin) || 0;

  for (const h of habitsActive()) {
    if (!isScheduled(h, date)) continue;
    if (hasStages(h)) {
      for (const s of stagesForDay(h, date, ctx)) {
        if (s.remind === false || s.start == null || stageDone(h, key, s)) continue;
        const isPrayer = s.time?.mode === 'prayer';
        if (!isPrayer && inQuiet(s.start, settings)) continue;
        const amount = h.type === 'count' ? ` · ${s.min === s.max || !s.max ? s.min : `${s.min}–${s.max}`} ${h.unit || ''}`.trimEnd() : '';
        if (inWindow(s.start)) {
          out.push({
            key: `${key}:${h.id}:${s.id}:1`,
            title: `${h.emoji} ${isPrayer ? `${s.name} · ${fmtMin(s.start)}` : `${h.name} · ${s.name}`}`,
            body: isPrayer ? `Время намаза ${s.name}. Не забудь отметить в трекере.` : `Пора${amount ? `: ${amount.replace(' · ', '')}` : ''} — отметь, когда сделаешь.`,
            url: './#today',
          });
        }
        if (repeat) {
          let r = s.start + repeat;
          if (isPrayer && s.end - 25 > s.start + 10) r = s.end - 25;
          if (inWindow(r) && (isPrayer || !inQuiet(r, settings))) {
            out.push({
              key: `${key}:${h.id}:${s.id}:2`,
              title: `${h.emoji} ${isPrayer ? `${s.name} ещё не отмечен` : `${h.name} · ${s.name}`}`,
              body: isPrayer ? `До конца времени осталось около 25 минут (до ${fmtMin(s.end)}).` : 'Ещё не отмечено — напоминаю.',
              url: './#today',
            });
          }
        }
      }
    } else if (!isDone(h, key)) {
      for (const [i, r] of (h.reminders || []).entries()) {
        const t = resolveTime(r, ctx);
        if (t == null) continue;
        const progress = h.type === 'check' ? '' : ` (${Math.round(valueOf(h, key) * 10) / 10}/${h.type === 'timer' ? `${h.target} мин` : `${h.target} ${h.unit || ''}`.trim()})`;
        if (inWindow(t) && !inQuiet(t, settings)) {
          out.push({ key: `${key}:${h.id}:r${i}:1`, title: `${h.emoji} ${h.name}`, body: `Пора выполнить привычку${progress}.`, url: './#today' });
        }
        if (repeat && inWindow(t + repeat) && !inQuiet(t + repeat, settings)) {
          out.push({ key: `${key}:${h.id}:r${i}:2`, title: `${h.emoji} ${h.name}`, body: `Ещё не отмечено${progress}.`, url: './#today' });
        }
      }
    }
  }

  // вечерний чек-ин
  if (settings.checkin?.enabled && inWindow(parseHM(settings.checkin.time))) {
    const left = habitsActive().filter((h) => isScheduled(h, date) && !isDone(h, key));
    const abst = abstainAll().filter((a) => !(a.cleanDays || []).includes(key));
    if (left.length || abst.length) {
      const parts = [];
      if (left.length) parts.push(`осталось ${left.length} ${plural(left.length, ['привычка', 'привычки', 'привычек'])}: ${left.slice(0, 3).map((h) => h.name).join(', ')}${left.length > 3 ? '…' : ''}`);
      if (abst.length) parts.push(`отметь чистый день: ${abst.map((a) => a.name).join(', ')}`);
      out.push({ key: `${key}:checkin`, title: '🌙 Вечерний чек-ин', body: parts.join('; ').replace(/^./, (c) => c.toUpperCase()), url: './#checkin' });
    }
  }
  return out;
}


// ================= Статистика по времени нажатий =================

const minOfDay = (ts) => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
};

const median = (arr) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

/**
 * Статистика по времени отметок за последние n дней.
 * { hours: [24], total, median, stages: [{ id, name, median, onTime, late, count }] }
 */
export function timeStats(h, days = 60) {
  const t = today();
  const first = firstDay(h);
  const hours = new Array(24).fill(0);
  const all = [];
  const stages = hasStages(h) ? h.stages.map((s) => ({ id: s.id, name: s.name, times: [], onTime: 0, late: 0 })) : [];
  for (let i = 0; i < days; i++) {
    const date = addDays(t, -i);
    if (date < first) break;
    const key = dkey(date);
    const ev = getEvents(h.id, key).filter((e) => e.d > 0 && e.ts > 0 && !String(e.id).startsWith('L'));
    if (!ev.length) continue;
    for (const e of ev) hours[new Date(e.ts).getHours()]++;
    if (stages.length) {
      const win = stagesForDay(h, date);
      for (const st of stages) {
        const e = ev.find((x) => x.s === st.id);
        if (!e || dkey(new Date(e.ts)) !== key) continue;
        const m = minOfDay(e.ts);
        st.times.push(m);
        const w = win.find((x) => x.id === st.id);
        if (w && w.start != null) {
          if (m >= w.start - 30 && m <= (w.end ?? w.start + 120)) st.onTime++;
          else st.late++;
        }
      }
    } else {
      const firstEv = ev[0];
      if (dkey(new Date(firstEv.ts)) === key) all.push(minOfDay(firstEv.ts));
    }
  }
  return {
    hours,
    total: hours.reduce((a, b) => a + b, 0),
    median: median(all),
    stages: stages.map((s) => ({ id: s.id, name: s.name, median: median(s.times), onTime: s.onTime, late: s.late, count: s.times.length })),
  };
}

/** Общее распределение отметок по часам за n дней по всем привычкам. */
export function overallHours(days = 30) {
  const hours = new Array(24).fill(0);
  const t = today();
  for (const h of habitsActive()) {
    for (let i = 0; i < days; i++) {
      for (const e of getEvents(h.id, dkey(addDays(t, -i)))) {
        if (e.d > 0 && e.ts > 0 && !String(e.id).startsWith('L')) hours[new Date(e.ts).getHours()]++;
      }
    }
  }
  return hours;
}
