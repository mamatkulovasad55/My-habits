// Хиджрийский календарь (Умм аль-Кура) со сдвигами по объявлению УМУ и сменой дня на Магрибе.
// Чистые функции: настройки пользователя передаются параметром. Работает в приложении и в Worker.
// Основной источник — Intl (календарь islamic-umalqura); если его нет — встроенная таблица Умм аль-Кура
// (сгенерирована из ICU скриптом tests/tools/gen-umq-table.mjs), вне её — арифметический календарь.
import { timesFor } from './calibrate.js';
import { dkey } from './util.js';

export const HIJRI_MONTHS = ['Мухаррам', 'Сафар', 'Раби аль-авваль', 'Раби ас-сани', 'Джумада аль-уля', 'Джумада ас-сания', 'Раджаб', 'Шабан', 'Рамадан', 'Шавваль', 'Зуль-када', 'Зуль-хиджа'];
/** Допустимый сдвиг месяца по объявлению УМУ, дней. */
export const HIJRI_OFFSET_MIN = -2;
export const HIJRI_OFFSET_MAX = 2;

const DAY = 86400000;
const UNIX_JDN = 2440588; // юлианский день 1970-01-01

/** Юлианский день для «наивной» местной даты (берутся год, месяц, число). */
export const jdnOf = (date) => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY) + UNIX_JDN;
/** Местная дата (полночь) по юлианскому дню. */
export const dateOfJdn = (jdn) => {
  const u = new Date((jdn - UNIX_JDN) * DAY);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
};

// ---------- Арифметический (табличный) исламский календарь ----------
const ISLAMIC_EPOCH = 1948440;
const arithToJdn = (y, m, d) => d + Math.ceil(29.5 * (m - 1)) + (y - 1) * 354 + Math.floor((3 + 11 * y) / 30) + ISLAMIC_EPOCH - 1;
function arithFromJdn(jdn) {
  const y = Math.floor((30 * (jdn - ISLAMIC_EPOCH) + 10646) / 10631);
  const m = Math.min(12, Math.ceil((jdn - (29 + arithToJdn(y, 1, 1))) / 29.5) + 1);
  return { y, m, d: jdn - arithToJdn(y, m, 1) + 1 };
}

// ---------- Таблица Умм аль-Кура ----------
const UMQ_FIRST = 1380;
const UMQ_START_JDN = 2437112; // 1 Мухаррама 1380
const UMQ_BITS = 'aaa95a2da5b9bb27646c95552ab4dbaba5b4da9d52aa592d26d8ed2daad5aa5a4b4979372b6975d69d52c9592b25b4db9d55d2da5d4aa9554daad3aabd2bc4b89a9552d5adb6a6d4dc9d92aa69562ae56d36ab55aaa94d49d95d2ba5b55aad55a9a92e26e55dada6d46a5b27a4d4ad56db5a754f49e92d26a563566b5baab92b2568ba9b55aada5b4da9b52a9a536276575af26d46a95552ad4bd9ba574b69b52a9552da5d4daad96b2e95e2ac9692eaad56ad65d4ad1562bc5b53a6b5db2d64d29a554ad96daea6e8ed1da4d4aa6a2da5b9b72';
let tableStarts = null; // начала месяцев (JDN), индекс (y - UMQ_FIRST) * 12 + (m - 1)
function starts() {
  if (tableStarts) return tableStarts;
  tableStarts = [UMQ_START_JDN];
  for (let i = 0; i < UMQ_BITS.length / 3; i++) {
    const yb = parseInt(UMQ_BITS.slice(i * 3, i * 3 + 3), 16);
    for (let m = 0; m < 12; m++) tableStarts.push(tableStarts[tableStarts.length - 1] + (yb & (1 << m) ? 30 : 29));
  }
  return tableStarts;
}
function tableMonthStart(y, m) {
  const i = (y - UMQ_FIRST) * 12 + (m - 1);
  const s = starts();
  return i >= 0 && i < s.length - 1 ? s[i] : arithToJdn(y, m, 1);
}
function tableFromJdn(jdn) {
  const s = starts();
  if (jdn < s[0] || jdn >= s[s.length - 1]) return arithFromJdn(jdn);
  let lo = 0;
  let hi = s.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= jdn) lo = mid;
    else hi = mid - 1;
  }
  return { y: UMQ_FIRST + Math.floor(lo / 12), m: (lo % 12) + 1, d: jdn - s[lo] + 1 };
}

// ---------- Intl ----------
let intlFmt = null;
function intlSupported() {
  try {
    const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
    if (f.resolvedOptions().calendar !== 'islamic-umalqura') return null;
    const p = intlParts(f, 2461090); // 18.02.2026 = 1 Рамадана 1447
    return p.y === 1447 && p.m === 9 && p.d === 1 ? f : null;
  } catch {
    return null;
  }
}
function intlParts(f, jdn) {
  const o = {};
  for (const p of f.formatToParts(new Date((jdn - UNIX_JDN) * DAY + DAY / 2))) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day') o[p.type] = parseInt(p.value, 10);
  }
  return { y: o.year, m: o.month, d: o.day };
}

let engine = null; // 'intl' | 'table'
/** Источник расчёта: 'intl' (календарь устройства) или 'table' (встроенная таблица). */
export function hijriEngine() {
  if (!engine) {
    intlFmt = intlSupported();
    engine = intlFmt ? 'intl' : 'table';
  }
  return engine;
}
/** Только для тестов: принудительно выбрать источник (null — автоматически). */
export function setHijriEngine(e) {
  engine = e;
  if (e === 'intl') intlFmt = intlSupported();
  monthCache.clear();
}

/** Базовая (без сдвигов) хиджрийская дата для юлианского дня. */
export function baseFromJdn(jdn) {
  return hijriEngine() === 'intl' ? intlParts(intlFmt, jdn) : tableFromJdn(jdn);
}

const monthCache = new Map();
/** Базовое начало хиджрийского месяца (JDN). */
export function baseMonthStart(y, m) {
  const k = y * 12 + m;
  if (monthCache.has(k)) return monthCache.get(k);
  let r;
  if (hijriEngine() === 'intl') {
    const est = tableMonthStart(y, m);
    r = est;
    for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
      const p = intlParts(intlFmt, est + delta);
      if (p.y === y && p.m === m && p.d === 1) {
        r = est + delta;
        break;
      }
    }
  } else r = tableMonthStart(y, m);
  monthCache.set(k, r);
  return r;
}

// ---------- Сдвиги УМУ ----------
const norm = (y, m) => ({ y: y + Math.floor((m - 1) / 12), m: ((((m - 1) % 12) + 12) % 12) + 1 });

/** Сдвиг месяца из настроек пользователя (0, если не задан). */
export function monthOffset(y, m, settings) {
  const o = (settings?.hijri?.offsets || []).find((x) => +x.y === y && +x.m === m);
  return Math.max(HIJRI_OFFSET_MIN, Math.min(HIJRI_OFFSET_MAX, Number(o?.offset) || 0));
}
/** Начало месяца с учётом сдвига (JDN). */
export function monthStart(y, m, settings) {
  ({ y, m } = norm(y, m));
  return baseMonthStart(y, m) + monthOffset(y, m, settings);
}
export function monthLength(y, m, settings) {
  const n = norm(y, m + 1);
  return monthStart(n.y, n.m, settings) - monthStart(y, m, settings);
}

/** Хиджрийская дата {y, m, d} для календарного дня (с учётом сдвигов пользователя). */
export function toHijri(date, settings) {
  const jdn = jdnOf(date);
  const b = baseFromJdn(jdn);
  let best = null;
  for (const dm of [-1, 0, 1]) {
    const { y, m } = norm(b.y, b.m + dm);
    const s = monthStart(y, m, settings);
    if (s <= jdn && (!best || s > best.s)) best = { y, m, s };
  }
  return { y: best.y, m: best.m, d: jdn - best.s + 1 };
}

/** Григорианская дата (местная полночь) по хиджрийской. */
export function fromHijri(y, m, d, settings) {
  return dateOfJdn(monthStart(y, m, settings) + d - 1);
}

/**
 * Хиджрийский день на момент datetime: сутки начинаются с Магриба (по скорректированному времени намаза).
 * Возвращает {y, m, d, evening} — evening: true, если уже после Магриба (идёт ночь следующего дня).
 */
export function hijriAt(datetime, settings) {
  const day = new Date(datetime.getFullYear(), datetime.getMonth(), datetime.getDate());
  const maghrib = timesFor(dkey(day), settings, settings?.prayer?.adj || {}).maghrib;
  const min = datetime.getHours() * 60 + datetime.getMinutes();
  if (min >= maghrib) return { ...toHijri(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1), settings), evening: true };
  return { ...toHijri(day, settings), evening: false };
}

export const formatHijri = (h) => `${h.d} ${HIJRI_MONTHS[h.m - 1]} ${h.y}`;

// ---------- Хиджрийские правила расписания ----------
// { type: 'days', days: [13, 14, 15] } — числа каждого месяца
// { type: 'date', m: 12, d: 9 } — конкретная дата
// { type: 'range', m: 9, from: -10, to: -1 } — диапазон; отрицательные — от конца месяца (−1 = последний день)
// { type: 'month', m: 9 } — месяц целиком

const resolveDay = (x, len) => (Number(x) < 0 ? len + 1 + Number(x) : Number(x));

export function matchesHijriRule(rule, h, monthLen) {
  if (!rule) return false;
  switch (rule.type) {
    case 'days': return (rule.days || []).map(Number).includes(h.d);
    case 'date': return h.m === +rule.m && h.d === +rule.d;
    case 'range': return h.m === +rule.m && h.d >= resolveDay(rule.from, monthLen) && h.d <= resolveDay(rule.to, monthLen);
    case 'month': return h.m === +rule.m;
    default: return false;
  }
}

/** Попадает ли календарный день под хиджрийское правило (с учётом сдвигов пользователя). */
export function isHijriScheduled(rule, date, settings) {
  const h = toHijri(date, settings);
  return matchesHijriRule(rule, h, monthLength(h.y, h.m, settings));
}

export function hijriRuleText(rule) {
  const M = (m) => HIJRI_MONTHS[(+m || 1) - 1];
  switch (rule?.type) {
    case 'days': return `${[...(rule.days || [])].sort((a, b) => a - b).join(', ')} числа (хиджра)`;
    case 'date': return `${rule.d} ${M(rule.m)}`;
    case 'range': {
      if (+rule.from < 0 && +rule.to === -1) return `Последние ${-rule.from} дней · ${M(rule.m)}`;
      return `${rule.from}–${rule.to} ${M(rule.m)}`;
    }
    case 'month': return `Весь ${M(rule.m)}`;
    default: return 'Хиджрийский календарь';
  }
}
