// Расписание этапов и напоминаний. Чистая логика: используется и в приложении, и в Cloudflare Worker.
import { prayerTimes, tzOffsetHours, PRAYER_NAME, fmtMin } from './prayer.js';
import { getData, habitsActive, abstainAll, getEvents, QADA_LOG } from './store.js';
import { isScheduled, isDone, valueOf, hasStages, stageDone, firstDay, stageActive } from './logic.js';
import { dkey, plural, addDays, today, parseKey, startOfDay } from './util.js';

export const parseHM = (s) => {
  const [h, m] = String(s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

/** Контекст дня: режим (подъём/сон) и время намазов. date — «наивная» местная дата. */
// Кэш контекста дня: расчёт времени намаза дорогой, а долг каза и статистика проходят по сотням дней.
// Ключ — настройки, влияющие на расчёт; при их изменении кэш сбрасывается.
const ctxCache = new Map();
let ctxSig = '';

export function dayContext(date, settings = getData().settings) {
  const sig = JSON.stringify([settings.tz, settings.wakeWd, settings.sleepWd, settings.wakeWe, settings.sleepWe, settings.prayer]);
  if (sig !== ctxSig || ctxCache.size > 1500) {
    ctxCache.clear();
    ctxSig = sig;
  }
  const k = dkey(date);
  const hit = ctxCache.get(k);
  if (hit) return { ...hit, settings };
  const ctx = computeDayContext(date, settings);
  ctxCache.set(k, ctx);
  return { ...ctx };
}

function computeDayContext(date, settings) {
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

export const isFriday = (date) => date.getDay() === 5;

/** Ключ намаза этапа: fajr…isha или vitr; null — если этап не намаз. */
export const prayerKeyOf = (s) => (s.role === 'vitr' ? 'vitr' : s.time?.mode === 'prayer' ? s.time.prayer : null);
export const isNamazHabit = (h) => hasStages(h) && h.stages.some((s) => prayerKeyOf(s));

/** Этапы привычки на день с окнами времени [start, end). */
export function stagesForDay(h, date, ctx = dayContext(date)) {
  if (!hasStages(h)) return [];
  const juma = ctx.settings?.juma;
  const list = h.stages
    .filter((s) => stageActive(s, date))
    .map((s) => {
      const out = { ...s, start: resolveTime(s.time, ctx) };
      // пятница: вместо Зухра — Джума в мечети
      if (juma?.enabled && isFriday(date) && s.time?.mode === 'prayer' && s.time.prayer === 'dhuhr' && s.role !== 'vitr') {
        out.juma = true;
        out.name = 'Джума';
        out.start = parseHM(juma.time || '13:00');
        out.remindAt = out.start - (Number(juma.lead) || 0);
      }
      return out;
    });
  const sorted = [...list].filter((s) => s.start != null).sort((a, b) => a.start - b.start);
  for (const s of list) {
    if (s.start == null) continue;
    if (s.time?.mode === 'prayer') {
      // Витр и Иша — до Фаджра следующего дня
      const nx = s.role === 'vitr' ? null : PRAYER_NEXT[s.time.prayer];
      s.end = nx ? ctx.prayers[nx] : ctx.prayers.fajr + 1440;
    } else {
      const next = sorted.find((x) => x.start > s.start);
      s.end = next ? next.start : Math.max(s.start + 60, ctx.sleep);
    }
  }
  return list;
}

/** Через сколько минут после начала Иши повторить напоминание, если не отмечено. */
export const ISHA_REPEAT_AFTER = 150;

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
        const vitr = s.time?.prayer === 'isha' && s.role !== 'vitr' && h.stages.some((x) => x.role === 'vitr' && stageActive(x, date) && !stageDone(h, key, x));
        const nameFull = vitr ? `${s.name} и Витр` : s.name;
        if (inWindow(s.remindAt ?? s.start)) {
          out.push({
            key: `${key}:${h.id}:${s.id}:1`,
            title: s.juma ? `🕌 Джума в ${fmtMin(s.start)}` : `${h.emoji} ${isPrayer ? `${nameFull} · ${fmtMin(s.start)}` : `${h.name} · ${s.name}`}`,
            body: s.juma
              ? `Пора собираться в мечеть — до Джума ${s.start - s.remindAt} мин.`
              : isPrayer ? `Время намаза ${nameFull}. Не забудь отметить в трекере.` : `Пора${amount ? `: ${amount.replace(' · ', '')}` : ''} — отметь, когда сделаешь.`,
            url: './#today',
          });
        }
        // Иша: время до Фаджра, поэтому два повтора — вечером и утром перед Фаджром
        const isha = isPrayer && s.time.prayer === 'isha' && s.role !== 'vitr' && s.end > 1440;
        if (repeat && isha) {
          const evening = Math.min(s.start + ISHA_REPEAT_AFTER, s.end - 60);
          const both = vitr ? 'Иша и Витр ещё не отмечены' : 'Иша ещё не отмечен';
          if (inWindow(evening)) {
            out.push({ key: `${key}:${h.id}:${s.id}:2`, title: `${h.emoji} ${both}`, body: `Время до Фаджра (${fmtMin(s.end - 1440)}). Отметь, когда прочитаешь.`, url: './#today' });
          }
          if (inWindow(s.end - 25)) {
            out.push({ key: `${key}:${h.id}:${s.id}:3`, title: `🌅 ${both}`, body: `До Фаджра около 25 минут (${fmtMin(s.end - 1440)}). Если уже прочитал — отметь, кнопка на карточке отметит вчерашний день.`, url: './#today' });
          }
        } else if (repeat) {
          let r = s.start + repeat;
          if (isPrayer && s.end - 25 > s.start + 10) r = s.end - 25;
          if (inWindow(r) && (isPrayer || !inQuiet(r, settings))) {
            out.push({
              key: `${key}:${h.id}:${s.id}:2`,
              title: `${h.emoji} ${isPrayer ? `${s.juma ? 'Зухр' : nameFull} ещё не отмечен` : `${h.name} · ${s.name}`}`,
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
      const debt = qadaDebt(date, toMin).total;
      if (debt) parts.push(`долг каза: ${debt}`);
      out.push({ key: `${key}:checkin`, title: '🌙 Вечерний чек-ин', body: parts.join('; ').replace(/^./, (c) => c.toUpperCase()), url: './#checkin' });
    }
  }
  return out;
}


// ================= Статусы этапов и каза =================

/** Минуты «сейчас» относительно полуночи дня date (для вчерашней Иши может быть > 1440). */
function minutesFrom(date, now) {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  return days * 1440 + now.getHours() * 60 + now.getMinutes();
}

/** Последняя положительная отметка этапа. */
export function stageMark(h, day, s) {
  const pos = getEvents(h.id, typeof day === 'string' ? day : dkey(day)).filter((e) => e.s === s.id && e.d > 0);
  return pos[pos.length - 1] || null;
}

/**
 * Намаз, время которого ещё не наступило: возвращает минуту начала (от полуночи дня date), иначе null.
 * Начало — настоящее время намаза без сдвига этапа: для Джума это время Зухра, для Витра — время Иши.
 */
export function prayerNotStarted(date, s, now = new Date()) {
  if (s?.time?.mode !== 'prayer') return null;
  const earliest = dayContext(date).prayers[s.time.prayer];
  if (earliest == null) return null;
  return minutesFrom(date, now) < earliest ? earliest : null;
}

/** Время этапа уже вышло? */
export function stageExpired(date, s, now = new Date()) {
  return s.end != null && minutesFrom(date, now) > s.end;
}

/**
 * Статус этапа: ontime | late | qada | missed | pending | untracked.
 * missed — время вышло и не отмечено (это долг каза); untracked — до включения учёта каза.
 */
export function stageStatus(h, date, s, now = new Date()) {
  const key = dkey(date);
  if (stageDone(h, key, s)) {
    const m = stageMark(h, key, s);
    return m?.k === 'qada' ? 'qada' : m?.k === 'late' ? 'late' : 'ontime';
  }
  if (!stageExpired(date, s, now)) return 'pending';
  const q = getData().settings.qada || {};
  // Витр становится долгом (ваджиб) только с vitrSince — прошлые неотмеченные Витры не превращаются в долг
  const since = prayerKeyOf(s) === 'vitr' && q.vitrSince && q.vitrSince > (q.since || '') ? q.vitrSince : q.since;
  if (!since || key < since || !prayerKeyOf(s)) return 'untracked';
  return 'missed';
}

export const QADA_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'vitr'];
export const QADA_NAMES = { fajr: 'Фаджр', dhuhr: 'Зухр', asr: 'Аср', maghrib: 'Магриб', isha: 'Иша', vitr: 'Витр' };
/** Тип долга: Витр — ваджиб, остальные — фард. */
export const QADA_TYPE = { fajr: 'fard', dhuhr: 'fard', asr: 'fard', maghrib: 'fard', isha: 'fard', vitr: 'wajib' };

/**
 * Долг каза по каждому намазу.
 * { total, byPrayer: { fajr: { missed: [{hid, day, sid}], oldLeft, total } }, oldLeft, repaidToday }
 * dateArg/minArg — для сервера (наивная дата и минута); в приложении берётся текущее время.
 */
export function qadaDebt(dateArg, minArg) {
  const data = getData();
  const q = data.settings.qada || {};
  const now = dateArg ? new Date(dateArg.getFullYear(), dateArg.getMonth(), dateArg.getDate(), 0, minArg ?? 0) : new Date();
  const t = startOfDay(now);
  const byPrayer = Object.fromEntries(QADA_KEYS.map((k) => [k, { missed: [], oldLeft: 0, total: 0, type: QADA_TYPE[k] }]));
  if (q.since) {
    for (const h of habitsActive().filter(isNamazHabit)) {
      let d = parseKey(q.since);
      const first = firstDay(h);
      if (d < first) d = first;
      for (let i = 0; d <= t && i < 3700; d = addDays(d, 1), i++) {
        if (!isScheduled(h, d)) continue;
        const key = dkey(d);
        for (const s of stagesForDay(h, d)) {
          const p = prayerKeyOf(s);
          if (p && stageStatus(h, d, s, now) === 'missed') byPrayer[p].missed.push({ hid: h.id, day: key, sid: s.id });
        }
      }
    }
  }
  // старые долги минус восполненное
  const repaid = Object.fromEntries(QADA_KEYS.map((k) => [k, 0]));
  let repaidToday = 0;
  const tk = dkey(t);
  for (const [day, e] of Object.entries(data.logs[QADA_LOG] || {})) {
    for (const ev of e.ev || []) {
      if (repaid[ev.s] != null) repaid[ev.s] += ev.d || 0;
      if (day === tk && ev.d > 0) repaidToday += ev.d;
    }
  }
  // восполнения пропусков по трекеру сегодня тоже считаются в дневную цель
  for (const h of habitsActive().filter(isNamazHabit)) {
    for (const [, e] of Object.entries(data.logs[h.id] || {})) {
      for (const ev of e.ev || []) if (ev.k === 'qada' && ev.d > 0 && dkey(new Date(ev.ts)) === tk) repaidToday += 1;
    }
  }
  let total = 0;
  let oldLeft = 0;
  let totalFard = 0;
  let totalWajib = 0;
  for (const k of QADA_KEYS) {
    const b = byPrayer[k];
    b.oldLeft = Math.max(0, (Number(q.old?.[k]) || 0) - repaid[k]);
    b.total = b.missed.length + b.oldLeft;
    total += b.total;
    oldLeft += b.oldLeft;
    if (b.type === 'wajib') totalWajib += b.total;
    else totalFard += b.total;
  }
  return { total, totalFard, totalWajib, oldLeft, byPrayer, repaidToday, perDay: Math.max(0, Number(q.perDay) || 0) };
}

/** Итоги намазов за n дней: вовремя / отмечено поздно / каза / пропущено, Джума. */
export function namazStats(h, days = 30) {
  const res = { ontime: 0, late: 0, qada: 0, missed: 0, juma: 0, jumaDhuhr: 0, fridays: 0 };
  const t = today();
  const now = new Date();
  const first = firstDay(h);
  for (let i = 0; i < days; i++) {
    const d = addDays(t, -i);
    if (d < first) break;
    for (const s of stagesForDay(h, d)) {
      if (!prayerKeyOf(s)) continue;
      const st = stageStatus(h, d, s, now);
      if (res[st] != null) res[st]++;
      if (s.juma) {
        if (st !== 'pending' && st !== 'untracked') res.fridays++;
        const m = stageMark(h, d, s);
        if (m?.k === 'juma') res.juma++;
        else if (m) res.jumaDhuhr++;
      }
    }
  }
  return res;
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
          if (e.k !== 'qada' && e.k !== 'late' && m >= w.start - 30 && m <= (w.end ?? w.start + 120)) st.onTime++;
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
