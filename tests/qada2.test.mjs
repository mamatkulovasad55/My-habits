// Каза: Витр как долг-ваджиб, запретное время, тартиб.
import assert from 'node:assert/strict';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { replaceData, getData, findHabit, normalize } from '../js/store.js';
import { qadaDebt, stagesForDay, stageStatus } from '../js/schedule.js';
import { forbiddenWindows, forbiddenAt, qadaQueue, tartibHint, tartibCount, TARTIB_LIMIT } from '../js/logic.js';
import { timesFor } from '../js/calibrate.js';
import { addDays, dkey } from '../js/util.js';

const ALL = ['p-fajr', 'p-dhuhr', 'p-asr', 'p-maghrib', 'p-isha', 'p-vitr'];
/** Данные: qada с 01.11, Витр-долг с 05.11; marks[day] = список этапов, отмеченных вовремя. */
function load(marks, settings = {}) {
  const d = typicalData();
  d.settings.qada = { ...d.settings.qada, since: '2026-11-01', vitrSince: '2026-11-05' };
  Object.assign(d.settings, settings);
  d.habits.forEach((h) => (h.createdAt = new Date(2026, 9, 1).getTime()));
  d.logs = { namaz: {} };
  for (const [day, list] of Object.entries(marks)) {
    const ts = new Date(day + 'T19:00:00').getTime();
    d.logs.namaz[day] = { ev: list.map((s, i) => ({ id: `${day}${i}`, ts, d: 1, s })), t: ts, v: list.length };
  }
  replaceData(d);
}
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi);
const vitrOf = () => qadaDebt().byPrayer.vitr;

// 1. Витр: не отмечен до Фаджра → долг типа wajib; отмечен → нет; до vitrSince → не долг
{
  const full = (k) => ({ [k]: ALL });
  load({ ...full('2026-11-04'), '2026-11-05': ALL.slice(0, 5), ...full('2026-11-06') });
  setNow(at(2026, 11, 6, 3).getTime()); // ночь на 6-е: Витр 5-го ещё можно
  assert.equal(vitrOf().missed.length, 0, 'до Фаджра — ещё не долг');
  setNow(at(2026, 11, 6, 10).getTime()); // после Фаджра 6-го
  assert.equal(vitrOf().missed.length, 1, 'после Фаджра — долг');
  assert.equal(vitrOf().type, 'wajib');
  assert.equal(qadaDebt().totalWajib, 1);
  assert.equal(qadaDebt().byPrayer.fajr.type, 'fard');
  // отмечен после Иши, до Фаджра (в ночь — во вчерашний день)
  load({ ...full('2026-11-04'), ...full('2026-11-05'), ...full('2026-11-06') });
  assert.equal(vitrOf().missed.length, 0, 'отмечен — долга нет');
  // пропуск 03.11 (до vitrSince): Витр — не долг, фард — долг
  load({ '2026-11-03': ALL.slice(0, 5), '2026-11-04': ALL, '2026-11-05': ALL, '2026-11-06': ALL });
  assert.equal(vitrOf().missed.length, 0, 'прошлые Витры не стали долгом');
  const h = findHabit('namaz');
  const v3 = stagesForDay(h, new Date(2026, 10, 3)).find((s) => s.id === 'p-vitr');
  assert.equal(stageStatus(h, new Date(2026, 10, 3), v3), 'untracked');
  console.log('✓ Витр: неотмеченный до Фаджра — долг (ваджиб); отмеченный — нет; до даты релиза — не долг');
}

// 2. Запретное время
{
  const s = getData().settings;
  const t = timesFor('2026-11-11', s, s.prayer.adj);
  const day = new Date(2026, 10, 11);
  const w = forbiddenWindows(day, s);
  assert.deepEqual(w.map((x) => [x.key, x.from, x.to]), [['sunrise', t.sunrise, t.sunrise + 15], ['zenith', t.dhuhr - 10, t.dhuhr], ['sunset', t.maghrib - 15, t.maghrib]]);
  const m = (min) => new Date(2026, 10, 11, 0, min);
  const hit = forbiddenAt(m(t.sunrise + 5), s);
  assert.equal(hit.key, 'sunrise');
  assert.match(hit.until, /^\d\d:\d\d$/);
  assert.equal(forbiddenAt(m(t.sunrise - 1), s), null);
  assert.equal(forbiddenAt(m(t.sunrise + 15), s), null);
  assert.equal(forbiddenAt(m(t.dhuhr - 3), s).key, 'zenith');
  assert.equal(forbiddenAt(m(t.maghrib - 1), s).key, 'sunset');
  const custom = { ...s, forbidden: { sunrise: 20, zenith: 0, sunset: 15 } };
  assert.equal(forbiddenAt(m(t.sunrise + 17), custom).key, 'sunrise', 'N из настроек');
  assert.equal(forbiddenAt(m(t.dhuhr - 3), custom), null, 'зенит 0 мин — окна нет');
  console.log(`✓ запретное время: восход ${hit.until.replace(/.*/, '')}+15, зенит −10, закат −15; попытка в окне восхода → подсказка «после ${hit.until}»`);
}

// 3. Тартиб
{
  const Q9 = { since: '2026-11-09', vitrSince: '2026-11-09', perDay: 2, old: {} };
  const on = { qada: Q9, tartib: { enabled: true, limit: TARTIB_LIMIT, countOld: false, countVitr: true } };
  const day11 = ALL;
  // один долг: Фаджр 10.11
  load({ '2026-11-09': ALL, '2026-11-10': ALL.slice(1), '2026-11-11': [] }, on);
  setNow(at(2026, 11, 11, 13).getTime());
  let d = qadaDebt();
  // сегодняшний Фаджр тоже пропущен (13:00) — 2 долга; первый — 10.11
  assert.equal(qadaQueue(d)[0].day, '2026-11-10');
  assert.equal(qadaQueue(d)[0].p, 'fajr');
  let hint = tartibHint(d, getData().settings, { day: '2026-11-11', sid: 'p-dhuhr' });
  assert.ok(hint, 'отмечаю Зухр → подсказка');
  assert.equal(hint.item.p, 'fajr');
  assert.equal(hint.item.day, '2026-11-10');
  assert.equal(tartibHint(d, getData().settings, { day: '2026-11-10', sid: 'p-fajr' }), null, 'сам первый долг — без подсказки');
  // выключен
  load({ '2026-11-09': ALL, '2026-11-10': ALL.slice(1), '2026-11-11': [] }, { qada: Q9, tartib: { enabled: false } });
  assert.equal(tartibHint(qadaDebt(), getData().settings, { day: '2026-11-11', sid: 'p-dhuhr' }), null, 'выключен — подсказок нет');
  // 6+ долгов: 10.11 без отметок (6 с Витром)
  load({ '2026-11-09': ALL, '2026-11-10': [], '2026-11-11': ALL.slice(0, 1) }, on);
  d = qadaDebt();
  assert.ok(tartibCount(d, getData().settings) >= 6);
  assert.equal(tartibHint(d, getData().settings, { day: '2026-11-11', sid: 'p-dhuhr' }), null, '6+ долгов — подсказки нет');
  // countVitr=false: 5 фард + Витр = 6 → без Витра 5 < 6 → подсказка есть
  load({ '2026-11-09': ALL, '2026-11-10': [], '2026-11-11': ALL.slice(0, 1) }, { qada: Q9, tartib: { ...on.tartib, countVitr: false } });
  d = qadaDebt();
  assert.equal(tartibCount(d, getData().settings), 5);
  assert.ok(tartibHint(d, getData().settings, { day: '2026-11-11', sid: 'p-dhuhr' }), 'без учёта Витра — 5 долгов, подсказка есть');
  // countOld: 1 долг по трекеру + 10 старых → порог превышен
  load({ '2026-11-09': ALL, '2026-11-10': ALL.slice(1), '2026-11-11': ALL.slice(0, 1) }, { ...on, qada: { ...Q9, old: { fajr: 10 } } });
  assert.ok(tartibHint(qadaDebt(), getData().settings, { day: '2026-11-11', sid: 'p-dhuhr' }), 'старые долги не учитываются по умолчанию');
  load({ '2026-11-09': ALL, '2026-11-10': ALL.slice(1), '2026-11-11': ALL.slice(0, 1) }, { tartib: { ...on.tartib, countOld: true }, qada: { ...Q9, old: { fajr: 10 } } });
  assert.equal(tartibHint(qadaDebt(), getData().settings, { day: '2026-11-11', sid: 'p-dhuhr' }), null, 'со старыми — 11 долгов, порядок не обязателен');
  void day11;
  console.log('✓ тартиб: 1 долг Фаджра → подсказка при Зухре; 6+ — нет; выключен — нет; Витр и старые долги — по настройкам');
}

// 4. Миграция старых данных: без потерь, Витры прошлого не стали долгом, тартиб включён
{
  const old = typicalData();
  old.schemaVersion = 2;
  delete old.settings.tartib;
  old.settings.qada = { ...old.settings.qada, since: '2026-11-01', vitrSince: undefined };
  old.logs = { namaz: { '2026-11-03': { ev: ALL.slice(0, 5).map((s, i) => ({ id: 'o' + i, ts: 1, d: 1, s })), t: 1, v: 5 } } };
  const n = normalize(old);
  assert.equal(n.settings.tartib.enabled, true);
  assert.equal(n.settings.qada.vitrSince, '2026-11-11');
  assert.deepEqual(n.logs, old.logs, 'журнал без изменений');
  replaceData(n);
  setNow(at(2026, 11, 12, 12).getTime());
  assert.equal(qadaDebt().byPrayer.vitr.missed.filter((m) => m.day < '2026-11-11').length, 0, 'прошлые Витры не стали долгом');
  console.log('✓ миграция v3: без потерь, тартиб включён, долг Витра — с 11.11');
}
void addDays; void dkey;
