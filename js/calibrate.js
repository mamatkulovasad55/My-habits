// Сверка времени намаза с официальным расписанием (muslim.uz, мечеть).
// Эталоны хранятся в settings.prayer.calib.refs; поправки пишутся в существующие settings.prayer.adj.
// Базовый метод (координаты, углы, Аср) и поправки хранятся раздельно.
import { prayerTimes, tzOffsetHours } from './prayer.js';
import { parseKey } from './util.js';

export const CALIB_KEYS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
/** Разброс поправки между датами (мин), при котором поправка явно зависит от сезона. */
export const SEASONAL_SPREAD = 2;

/** Время на дату (ключ YYYY-MM-DD) с заданными поправками, в минутах от полуночи. */
export function timesFor(dateKey, settings, adj = {}) {
  const d = parseKey(dateKey);
  const noon = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12));
  return prayerTimes(d.getFullYear(), d.getMonth() + 1, d.getDate(), { ...settings.prayer, adj }, tzOffsetHours(settings.tz, noon));
}

const roundHalfAway = (x) => {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r; // без -0
};

/**
 * Отчёт сверки.
 * rows: по каждой дате — для каждого намаза эталон, базовое и текущее время, delta = эталон − текущее, need = эталон − база.
 * summary[k]: { adj, spread, seasonal, n } — поправка (округлённое среднее need) и разброс между датами.
 */
export function calibrationReport(settings) {
  const refs = [...(settings.prayer?.calib?.refs || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  const curAdj = settings.prayer?.adj || {};
  const rows = refs.map((r) => {
    const base = timesFor(r.date, settings, {});
    const cur = timesFor(r.date, settings, curAdj);
    return {
      date: r.date,
      items: CALIB_KEYS.map((k) => {
        const ref = Number.isFinite(r.t?.[k]) ? r.t[k] : null;
        return { k, ref, base: base[k], cur: cur[k], delta: ref == null ? null : ref - cur[k], need: ref == null ? null : ref - base[k] };
      }),
    };
  });
  const summary = {};
  for (const k of CALIB_KEYS) {
    const needs = rows.map((r) => r.items.find((x) => x.k === k).need).filter((n) => n != null);
    if (!needs.length) continue;
    const spread = Math.max(...needs) - Math.min(...needs);
    summary[k] = { adj: roundHalfAway(needs.reduce((s, n) => s + n, 0) / needs.length), spread, seasonal: spread > SEASONAL_SPREAD, n: needs.length };
  }
  return { rows, summary };
}

/** Новые настройки намаза после «Применить поправки». */
export function applyCalibration(settings, todayKey) {
  const { summary } = calibrationReport(settings);
  const adj = { ...(settings.prayer.adj || {}) };
  for (const [k, s] of Object.entries(summary)) adj[k] = s.adj;
  return { ...settings.prayer, adj, calib: { ...(settings.prayer.calib || {}), at: todayKey, adj: { ...adj } } };
}

/** Добавить или заменить эталон на дату. t — { fajr: минуты, ... }. */
export function withRef(prayer, date, t) {
  const refs = (prayer.calib?.refs || []).filter((r) => r.date !== date);
  refs.push({ date, t });
  refs.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { ...prayer, calib: { ...(prayer.calib || {}), refs } };
}

export function withoutRef(prayer, date) {
  return { ...prayer, calib: { ...(prayer.calib || {}), refs: (prayer.calib?.refs || []).filter((r) => r.date !== date) } };
}

/** Источник времени: формула / сверено с расписанием (и правилось ли вручную после сверки). */
export function prayerSource(settings) {
  const c = settings.prayer?.calib;
  if (!c?.at) return { kind: 'formula' };
  const adj = settings.prayer.adj || {};
  const manual = CALIB_KEYS.some((k) => (Number(adj[k]) || 0) !== (Number(c.adj?.[k]) || 0));
  return { kind: manual ? 'calibrated+manual' : 'calibrated', at: c.at };
}
