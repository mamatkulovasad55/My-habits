// Общие утилиты: даты, форматирование, экранирование.

export const pad = (n) => String(n).padStart(2, '0');

/** Ключ дня в локальном времени: YYYY-MM-DD */
export const dkey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const today = () => startOfDay(new Date());
export const todayKey = () => dkey(new Date());

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

/** Понедельник недели, в которую попадает дата */
export const startOfWeek = (d) => {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
};

export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Русское склонение: plural(5, ['день','дня','дней']) */
export function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export const DAY_FORMS = ['день', 'дня', 'дней'];
export const WEEK_FORMS = ['неделя', 'недели', 'недель'];
export const TIMES_FORMS = ['раз', 'раза', 'раз'];

export const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
export const WEEKDAYS_LETTER = ['В', 'П', 'В', 'С', 'Ч', 'П', 'С'];
export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export const fmtDayLong = (d) =>
  `${d.toLocaleDateString('ru-RU', { weekday: 'long' })}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;

export const fmtDateShort = (d) => `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}`;

export const fmtDateTime = (ts) => {
  const d = new Date(ts);
  return `${fmtDateShort(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Секунды → "12:05" или "1:02:05" */
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Миллисекунды → части для большого таймера */
export function durationParts(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

/** Миллисекунды → "12 дн. 4 ч" (короткая человеческая запись) */
export function fmtDuration(ms) {
  const { d, h, m } = durationParts(ms);
  if (d >= 1) return h ? `${d} ${plural(d, DAY_FORMS)} ${h} ч` : `${d} ${plural(d, DAY_FORMS)}`;
  if (h >= 1) return m ? `${h} ч ${m} мин` : `${h} ч`;
  return `${m} мин`;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** JSON с отсортированными ключами — для сравнения состояний */
export function stableStringify(v, space) {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = sort(x[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(sort(v), null, space);
}
