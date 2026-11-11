// Расчёт времени намазов по координатам (классический астрономический алгоритм PrayTimes).
// Работает офлайн, без внешних сервисов.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const sin = (d) => Math.sin(rad(d));
const cos = (d) => Math.cos(rad(d));
const tan = (d) => Math.tan(rad(d));
const arcsin = (x) => deg(Math.asin(x));
const arccos = (x) => deg(Math.acos(Math.max(-1, Math.min(1, x))));
const arctan2 = (y, x) => deg(Math.atan2(y, x));
const arccot = (x) => deg(Math.atan(1 / x));
const fix = (a, b) => {
  a = a - b * Math.floor(a / b);
  return a < 0 ? a + b : a;
};

export const PRAYERS = [
  { key: 'fajr', name: 'Фаджр', local: 'Бомдод' },
  { key: 'dhuhr', name: 'Зухр', local: 'Пешин' },
  { key: 'asr', name: 'Аср', local: 'Аср' },
  { key: 'maghrib', name: 'Магриб', local: 'Шом' },
  { key: 'isha', name: 'Иша', local: 'Хуфтон' },
];
export const PRAYER_NAME = Object.fromEntries(PRAYERS.map((p) => [p.key, p.name]));
PRAYER_NAME.sunrise = 'Восход';

// [название, широта, долгота, часовой пояс IANA]
export const CITIES = [
  ['Ташкент', 41.2995, 69.2401, 'Asia/Tashkent'], ['Самарканд', 39.6542, 66.9597, 'Asia/Tashkent'], ['Бухара', 39.7747, 64.4286, 'Asia/Tashkent'],
  ['Андижан', 40.7821, 72.3442, 'Asia/Tashkent'], ['Наманган', 40.9983, 71.6726, 'Asia/Tashkent'], ['Фергана', 40.3864, 71.7864, 'Asia/Tashkent'],
  ['Коканд', 40.5286, 70.9425, 'Asia/Tashkent'], ['Нукус', 42.46, 59.61, 'Asia/Tashkent'], ['Ургенч', 41.55, 60.6333, 'Asia/Tashkent'],
  ['Карши', 38.8606, 65.7891, 'Asia/Tashkent'], ['Термез', 37.2242, 67.2783, 'Asia/Tashkent'], ['Джизак', 40.1158, 67.8422, 'Asia/Tashkent'],
  ['Навои', 40.0844, 65.3792, 'Asia/Tashkent'], ['Гулистан', 40.4897, 68.7842, 'Asia/Tashkent'], ['Алматы', 43.222, 76.8512, 'Asia/Almaty'],
  ['Бишкек', 42.8746, 74.5698, 'Asia/Bishkek'], ['Душанбе', 38.5598, 68.787, 'Asia/Dushanbe'], ['Москва', 55.7558, 37.6173, 'Europe/Moscow'],
  ['Санкт-Петербург', 59.9343, 30.3351, 'Europe/Moscow'], ['Казань', 55.7963, 49.1088, 'Europe/Moscow'], ['Стамбул', 41.0082, 28.9784, 'Europe/Istanbul'],
];

/** Часовой пояс для режима «Автоматически»: пояс города из списка, для своих координат — пояс устройства. */
export function cityTz(settings, deviceTz = '') {
  const c = CITIES.find(([n]) => n === settings?.prayer?.city);
  return c ? c[3] : deviceTz || settings?.tz || '';
}

/** Пояс, который должен стоять в settings.tz (null — менять не нужно: ручной режим). */
export function autoTz(settings, deviceTz = '') {
  if (settings?.tzAuto === false) return null;
  return cityTz(settings, deviceTz) || null;
}

/**
 * Часы устройства идут не по поясу профиля? Приложение сравнивает «сейчас» по часам устройства с временем намаза
 * в поясе профиля, поэтому при расхождении отметки «вовремя / ещё не наступил» сдвигаются.
 * Возвращает { device, profile } — смещения в часах — или null, если совпадают (сравнение по смещению, не по названию).
 */
export function tzMismatch(settings, date = new Date(), deviceOffset = -date.getTimezoneOffset() / 60) {
  if (!settings?.tz) return null;
  const profile = tzOffsetHours(settings.tz, date);
  return profile === deviceOffset ? null : { device: deviceOffset, profile };
}

/** Подпись смещения: 5 → «UTC+5», -3.5 → «UTC−3:30». */
export function offsetLabel(h) {
  const sign = h < 0 ? '−' : '+';
  const a = Math.abs(h);
  const m = Math.round((a % 1) * 60);
  return `UTC${h === 0 ? '' : sign + Math.floor(a) + (m ? ':' + String(m).padStart(2, '0') : '')}`;
}

/** «UTC+5», «UTC+5:30», «UTC−3». */
export const tzLabel = (tz, date = new Date()) => offsetLabel(tzOffsetHours(tz, date));

function julian(y, m, d) {
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * D, 360);
  const q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(q + 1.915 * sin(g) + 0.02 * sin(2 * g), 360);
  const e = 23.439 - 0.00000036 * D;
  const RA = arctan2(cos(e) * sin(L), cos(L)) / 15;
  const eqt = q / 15 - fix(RA, 24);
  const decl = arcsin(sin(e) * sin(L));
  return { decl, eqt };
}

/**
 * Время намазов на дату (y, m 1..12, d) в минутах от местной полуночи.
 * tzOffsetHours — смещение часового пояса от UTC (например 5 для Ташкента).
 */
export function prayerTimes(y, m, d, p, tzOffsetHours) {
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  const jDate = julian(y, m, d) - lon / (15 * 24);

  const midDay = (t) => fix(12 - sunPosition(jDate + t).eqt, 24);
  const sunAngleTime = (angle, t, ccw) => {
    const { decl } = sunPosition(jDate + t);
    const noon = midDay(t);
    const T = (1 / 15) * arccos((-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat)));
    return noon + (ccw ? -T : T);
  };
  const asrTime = (factor, t) => {
    const { decl } = sunPosition(jDate + t);
    const angle = -arccot(factor + tan(Math.abs(lat - decl)));
    return sunAngleTime(angle, t);
  };

  // два прохода для точности
  let t = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, maghrib: 18, isha: 18 };
  for (let i = 0; i < 2; i++) {
    const f = (h) => h / 24;
    t = {
      fajr: sunAngleTime(Number(p.fajrAngle) || 15, f(t.fajr), true),
      sunrise: sunAngleTime(0.833, f(t.sunrise), true),
      dhuhr: midDay(f(t.dhuhr)),
      asr: asrTime(p.asr === 'shafi' ? 1 : 2, f(t.asr)),
      maghrib: sunAngleTime(0.833, f(t.maghrib)),
      isha: sunAngleTime(Number(p.ishaAngle) || 15, f(t.isha)),
    };
  }
  const out = {};
  const adj = p.adj || {};
  for (const [k, h] of Object.entries(t)) {
    const local = h + tzOffsetHours - lon / 15;
    out[k] = Math.round(fix(local, 24) * 60) + (Number(adj[k]) || 0);
  }
  return out;
}

/** Смещение часового пояса (в часах) для даты в IANA-зоне. */
const TZ_FMT = new Map(); // создание Intl.DateTimeFormat дорогое — переиспользуем

export function tzOffsetHours(tz, date = new Date()) {
  if (!tz) return -date.getTimezoneOffset() / 60;
  try {
    let fmt = TZ_FMT.get(tz);
    if (!fmt) TZ_FMT.set(tz, (fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })));
    const parts = Object.fromEntries(
      fmt
        .formatToParts(date)
        .map((x) => [x.type, x.value]),
    );
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    return Math.round((asUTC - Math.floor(date.getTime() / 60000) * 60000) / 60000) / 60;
  } catch {
    return -date.getTimezoneOffset() / 60;
  }
}

export const fmtMin = (m) => {
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
