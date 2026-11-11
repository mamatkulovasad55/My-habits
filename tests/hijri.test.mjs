// Хиджрийский движок: совпадение с Intl (Умм аль-Кура), таблица-фолбэк, сдвиги УМУ, Магриб, расписания.
import assert from 'node:assert/strict';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import * as H from '../js/hijri.js';
import { replaceData, findHabit } from '../js/store.js';
import { isScheduled, currentStreak, bestStreak, strengthOf } from '../js/logic.js';
import { timesFor } from '../js/calibrate.js';
import { addDays, dkey } from '../js/util.js';

const S = typicalData().settings;
const intl = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const viaIntl = (d) => {
  const o = Object.fromEntries(intl.formatToParts(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12))).filter((p) => p.type !== 'literal').map((p) => [p.type, parseInt(p.value, 10)]));
  return { y: o.year, m: o.month, d: o.day };
};

// 1. 24+ дат в разных годах, включая переходы года, совпадают с Intl; обратная конверсия
const dates = [
  [1990, 7, 23], [1995, 5, 30], [2000, 4, 6], [2003, 3, 4], [2008, 1, 10], [2010, 12, 7], [2012, 11, 15], [2015, 10, 14],
  [2017, 9, 21], [2019, 8, 31], [2020, 8, 20], [2021, 8, 9], [2022, 7, 30], [2023, 7, 19], [2024, 7, 7], [2025, 6, 26],
  [2025, 6, 25], [2026, 2, 18], [2026, 3, 19], [2026, 3, 20], [2026, 5, 27], [2026, 6, 16], [2026, 11, 11], [2027, 6, 6],
  [2028, 5, 25], [2030, 1, 5], [2032, 4, 12], [2035, 12, 31],
].map(([y, m, d]) => new Date(y, m - 1, d));
let yearStarts = 0;
for (const d of dates) {
  const h = H.toHijri(d, S);
  assert.deepEqual(h, viaIntl(d), `${dkey(d)}`);
  assert.equal(dkey(H.fromHijri(h.y, h.m, h.d, S)), dkey(d), `обратно ${dkey(d)}`);
  if (h.m === 1 && h.d === 1) yearStarts++;
}
assert.ok(yearStarts >= 8, `переходов года: ${yearStarts}`);
assert.equal(H.formatHijri(H.toHijri(new Date(2026, 1, 18), S)), '1 Рамадан 1447');
console.log(`✓ ${dates.length} дат 1990–2035 совпадают с Intl (Умм аль-Кура), из них ${yearStarts} — 1 Мухаррама; обратная конверсия`);

// 2. Таблица-фолбэк совпадает с Intl на каждом дне 1400–1500 г.х.
{
  H.setHijriEngine('intl');
  const from = H.baseMonthStart(1400, 1);
  const to = H.baseMonthStart(1501, 1);
  const ref = [];
  for (let j = from; j < to; j++) ref.push(H.baseFromJdn(j));
  H.setHijriEngine('table');
  for (let j = from; j < to; j++) assert.deepEqual(H.baseFromJdn(j), ref[j - from], `jdn ${j}`);
  assert.deepEqual(H.toHijri(new Date(2026, 10, 11), S), viaIntl(new Date(2026, 10, 11)));
  H.setHijriEngine(null);
  assert.equal(H.hijriEngine(), 'intl');
  console.log(`✓ встроенная таблица совпадает с Intl на всех ${to - from} днях 1400–1500 г.х.`);
}

// 3. Сдвиг +1 для месяца сдвигает все его даты и правило «13–15»
{
  const shifted = { ...S, hijri: { offsets: [{ y: 1448, m: 6, offset: 1 }] } };
  const start0 = H.fromHijri(1448, 6, 1, S);
  const start1 = H.fromHijri(1448, 6, 1, shifted);
  assert.equal(dkey(start1), dkey(addDays(start0, 1)), 'месяц начался на день позже');
  for (let d = 1; d <= 29; d++) assert.equal(dkey(H.fromHijri(1448, 6, d, shifted)), dkey(addDays(H.fromHijri(1448, 6, d, S), 1)));
  assert.deepEqual(H.toHijri(start0, shifted), { y: 1448, m: 5, d: H.monthLength(1448, 5, S) + 1 }, 'предыдущий месяц удлинился');
  const rule = { type: 'days', days: [13, 14, 15] };
  const days0 = [];
  const days1 = [];
  for (let i = 0; i < 32; i++) {
    const d = addDays(start0, i);
    if (H.isHijriScheduled(rule, d, S)) days0.push(dkey(d));
    if (H.isHijriScheduled(rule, d, shifted)) days1.push(dkey(d));
  }
  assert.equal(days0.length, 3);
  assert.deepEqual(days1, days0.map((k) => dkey(addDays(new Date(k), 1))));
  console.log(`✓ сдвиг +1: месяц и «13–15» сдвинулись на день (${days0.join(', ')} → ${days1.join(', ')})`);
}

// 4. hijriAt до и после Магриба (по скорректированному времени)
{
  const day = new Date(2026, 10, 11);
  const s = { ...S, prayer: { ...S.prayer, adj: { ...S.prayer.adj, maghrib: 5 } } };
  const mg = timesFor(dkey(day), s, s.prayer.adj).maghrib;
  const at = (min) => new Date(2026, 10, 11, 0, min);
  const before = H.hijriAt(at(mg - 1), s);
  const after = H.hijriAt(at(mg), s);
  assert.deepEqual({ ...before, evening: undefined }, { ...H.toHijri(day, s), evening: undefined });
  assert.equal(before.evening, false);
  assert.deepEqual({ y: after.y, m: after.m, d: after.d }, H.toHijri(addDays(day, 1), s));
  assert.equal(after.evening, true);
  const noAdj = H.hijriAt(at(mg - 2), { ...S });
  assert.equal(noAdj.evening, true, 'без поправки +5 Магриб на 5 мин раньше');
  console.log('✓ hijriAt: до Магриба — тот же день, после — следующий (с учётом поправки)');
}

// 5. Последние 10 дней Рамадана — в 29- и 30-дневном месяце
{
  const rule = { type: 'range', m: 9, from: -10, to: -1 };
  for (const y of [1446, 1447]) {
    const len = H.monthLength(y, 9, S);
    let n = 0;
    for (let d = 1; d <= len; d++) if (H.isHijriScheduled(rule, H.fromHijri(y, 9, d, S), S)) n++;
    assert.equal(n, 10, `Рамадан ${y} (${len} дн.)`);
    assert.ok(!H.isHijriScheduled(rule, H.fromHijri(y, 9, len - 10, S), S));
    assert.ok(!H.isHijriScheduled(rule, H.fromHijri(y, 10, 1, S), S));
  }
  assert.ok(H.isHijriScheduled({ type: 'date', m: 12, d: 9 }, H.fromHijri(1447, 12, 9, S), S));
  assert.ok(H.isHijriScheduled({ type: 'month', m: 9 }, H.fromHijri(1447, 9, 17, S), S));
  console.log('✓ правила: последние 10 дней Рамадана (29/30 дней), 9 Зуль-хиджа, весь месяц');
}

// 6. Привычка «13, 14, 15»: только в эти дни, серия и сила не страдают от остальных дней
{
  const d = typicalData();
  const gym = d.habits.find((h) => h.id === 'gym');
  gym.schedule = { kind: 'hijri', hijri: { type: 'days', days: [13, 14, 15] } };
  const start = H.fromHijri(1448, 2, 1, S);
  gym.createdAt = start.getTime();
  d.logs = { gym: {} };
  let scheduled = 0;
  for (let i = 0; i < 90; i++) {
    const day = addDays(start, i);
    const h = H.toHijri(day, S);
    if ([13, 14, 15].includes(h.d)) {
      scheduled++;
      d.logs.gym[dkey(day)] = { ev: [{ id: `e${i}`, ts: day.getTime(), d: 1 }], t: day.getTime(), v: 1 };
    }
  }
  replaceData(d);
  setNow(addDays(start, 89).getTime() + 20 * 3600e3);
  const g = findHabit('gym');
  let sched = 0;
  for (let i = 0; i < 90; i++) {
    const day = addDays(start, i);
    const yes = isScheduled(g, day);
    assert.equal(yes, [13, 14, 15].includes(H.toHijri(day, S).d), dkey(day));
    if (yes) sched++;
  }
  assert.equal(sched, scheduled);
  assert.equal(currentStreak(g).value, scheduled, 'серия не рвётся в «пустые» дни');
  assert.equal(bestStreak(g).value, scheduled);
  assert.ok(strengthOf(g) > 30, `сила ${strengthOf(g)}`);
  console.log(`✓ привычка «13, 14, 15»: ${sched} дней из 90 по расписанию, серия ${currentStreak(g).value}, сила ${strengthOf(g)}`);
}
