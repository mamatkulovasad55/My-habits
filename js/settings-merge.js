// Слияние настроек по полям. Чистые функции без зависимостей от браузера:
// работают и в приложении, и в Cloudflare Worker (как store.js).
//
// Значения настроек хранятся как раньше, рядом — карта меток времени settings._t:
//   { "theme": 1731340000000, "prayer.adj.fajr": 1731250000000, "prayer.city": …, … }
// Единица слияния — лист дерева настроек. Исключения:
//  • ATOMIC — блоки, которые сливаются целиком (массивы и связанные данные);
//  • GROUPS — несколько полей с одной общей меткой (меняются только вместе).
// По каждой единице побеждает более свежая метка; settings.updatedAt всегда = max(_t).
import { stableStringify } from './util.js';

const SKIP = new Set(['_t', 'updatedAt']);
const ATOMIC = new Set(['prayer.calib', 'hijri.offsets', 'dhikr.favorites']);
export const GROUPS = {
  'prayer.city': ['prayer.city', 'prayer.lat', 'prayer.lon'], // город и его координаты
  tz: ['tz', 'tzAuto'], // пояс и режим «по городу»
};
const GROUP_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, members]) => members.map((m) => [m, g])));
/** Метки дальше этого от времени сервера считаются ошибкой часов устройства. */
export const FUTURE_SLACK = 5 * 60 * 1000;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === undefined ? '' : stableStringify(v));
const stampsOf = (s) => (isPlain(s?._t) ? s._t : {});
export const maxStamp = (t) => Object.values(t || {}).reduce((m, x) => (Number(x) > m ? Number(x) : m), 0);

/** Единицы слияния: Map(ключ → значение). Значение группы — { путь: значение } присутствующих полей. */
export function unitsOf(settings) {
  const out = new Map();
  const walk = (o, prefix) => {
    for (const k of Object.keys(o).sort()) {
      if (!prefix && SKIP.has(k)) continue;
      const v = o[k];
      if (v === undefined) continue;
      const p = prefix ? `${prefix}.${k}` : k;
      const g = GROUP_OF[p];
      if (g) {
        out.set(g, { ...(out.get(g) || {}), [p]: v });
      } else if (isPlain(v) && !ATOMIC.has(p)) walk(v, p);
      else out.set(p, v);
    }
  };
  if (isPlain(settings)) walk(settings, '');
  return out;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = isPlain(o[k]) ? o[k] : (o[k] = {});
  o[keys[keys.length - 1]] = value;
}

function deletePath(obj, path) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlain(o[k])) return;
    o = o[k];
  }
  delete o[keys[keys.length - 1]];
}

/** Записать значение единицы (undefined — удалить). */
function setUnit(obj, key, value) {
  const members = GROUPS[key];
  if (!members) return value === undefined ? deletePath(obj, key) : setPath(obj, key, value);
  for (const m of members) {
    if (value && m in value) setPath(obj, m, value[m]);
    else deletePath(obj, m);
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bump = (t, k, now) => (t[k] = Math.max(Number(now) || 0, (Number(t[k]) || 0) + 1)); // метка поля не уменьшается

/**
 * Достроить метки после normalizeSettings. raw — настройки как пришли (из файла, с другого устройства),
 * normalized — они же с подставленными значениями по умолчанию (изменяется на месте).
 *  • единица была в raw: её метка из raw._t, а если её нет — raw.updatedAt (не меньше 1, чтобы не делить ничью с умолчаниями);
 *  • единица подставлена по умолчанию: 0 (или метка удаления из raw._t);
 *  • переходный период: raw.updatedAt > max(raw._t) — настройки правила версия без меток по полям,
 *    поэтому всем её полям — не меньше raw.updatedAt (как раньше: «кто позже»);
 *  • без меток и без updatedAt значение, равное умолчанию (defaults), получает 0 — оно ничего не сообщает.
 * Идемпотентна: повторный вызов на результате ничего не меняет.
 */
export function materialize(raw, normalized, defaults = null) {
  const rawT = stampsOf(raw);
  const rawUnits = unitsOf(raw);
  const defUnits = unitsOf(defaults);
  const rawUpd = Number(raw?.updatedAt) || 0;
  const legacy = rawUpd > maxStamp(rawT);
  const t = {};
  for (const [k, x] of Object.entries(rawT)) if (Number.isFinite(Number(x))) t[k] = Number(x); // в т.ч. метки удаления
  for (const k of unitsOf(normalized).keys()) {
    if (rawUnits.has(k)) {
      // без какой-либо метки значение, равное умолчанию, ничего не сообщает — как подставленное (0)
      const noInfo = !rawUpd && !Number.isFinite(Number(rawT[k])) && defUnits.has(k) && str(defUnits.get(k)) === str(rawUnits.get(k));
      let s = Number.isFinite(Number(rawT[k])) ? Number(rawT[k]) : noInfo ? 0 : Math.max(rawUpd, 1);
      if (legacy) s = Math.max(s, rawUpd);
      t[k] = s;
    } else if (!(k in t)) t[k] = 0;
  }
  normalized._t = t;
  normalized.updatedAt = maxStamp(t);
  return normalized;
}

/** Метки для изменившихся единиц (сравнение «до/после» в update()). after изменяется на месте. */
export function stampChanges(before, after, now) {
  const t = { ...stampsOf(before), ...stampsOf(after) };
  const ub = unitsOf(before);
  const ua = unitsOf(after);
  for (const k of new Set([...ub.keys(), ...ua.keys()])) if (str(ub.get(k)) !== str(ua.get(k))) bump(t, k, now);
  after._t = t;
  after.updatedAt = maxStamp(t);
  return after;
}

/** Свежие метки всем единицам (сброс, импорт после сброса): эти настройки — самые новые. */
export function stampAll(settings, now) {
  const t = { ...stampsOf(settings) };
  for (const k of unitsOf(settings).keys()) bump(t, k, now);
  settings._t = t;
  settings.updatedAt = maxStamp(t);
  return settings;
}

/** Метки из будущего (часы устройства спешат) — до времени сервера. updatedAt пересчитывается. */
export function clampFuture(settings, serverNow) {
  const t = { ...stampsOf(settings) };
  for (const [k, x] of Object.entries(t)) if (x > serverNow + FUTURE_SLACK) t[k] = serverNow;
  return { ...settings, _t: t, updatedAt: maxStamp(t) };
}

/**
 * Слить настройки по полям: по каждой единице — значение с более свежей меткой.
 * При равных метках — детерминированно (бо́льшая строка), чтобы результат не зависел от порядка аргументов.
 * serverNow — только на сервере: сначала урезать метки из будущего.
 */
export function mergeSettings(a, b, { serverNow } = {}) {
  if (serverNow) {
    a = clampFuture(a, serverNow);
    b = clampFuture(b, serverNow);
  }
  const ta = stampsOf(a);
  const tb = stampsOf(b);
  const ua = unitsOf(a);
  const ub = unitsOf(b);
  const out = {};
  const t = {};
  const keys = [...new Set([...ua.keys(), ...ub.keys(), ...Object.keys(ta), ...Object.keys(tb)])].sort();
  for (const k of keys) {
    const sa = Number(ta[k]) || 0;
    const sb = Number(tb[k]) || 0;
    const va = ua.get(k);
    const vb = ub.get(k);
    const useB = sb !== sa ? sb > sa : str(vb) > str(va);
    setUnit(out, k, clone(useB ? vb : va));
    t[k] = Math.max(sa, sb);
  }
  out._t = t;
  out.updatedAt = maxStamp(t);
  return out;
}

/**
 * После синхронизации: где значение то же, что на сервере, а локальная метка свежее (сервер урезал метку из будущего) —
 * взять серверную. Иначе устройство со спешащими часами и сервер бесконечно перебрасывали бы метку.
 */
export function adoptStamps(local, server) {
  const tl = { ...stampsOf(local) };
  const ts = stampsOf(server);
  const ul = unitsOf(local);
  const us = unitsOf(server);
  for (const [k, v] of ul) {
    if (k in ts && tl[k] > ts[k] && us.has(k) && str(us.get(k)) === str(v)) tl[k] = ts[k];
  }
  return { ...local, _t: tl, updatedAt: maxStamp(tl) };
}
