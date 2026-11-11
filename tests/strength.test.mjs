// Сила привычки: экспоненциальное сглаживание, пропуск не обнуляет, каза засчитывается частично.
import assert from 'node:assert/strict';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { replaceData, findHabit } from '../js/store.js';
import { strengthOf, currentStreak, dayCredit, QADA_CREDIT } from '../js/logic.js';
import { addDays, dkey } from '../js/util.js';

const START = new Date(2026, 0, 1);
const PR = ['p-fajr', 'p-dhuhr', 'p-asr', 'p-maghrib', 'p-isha', 'p-vitr'];

/** Данные: зарядка (галочка) и намаз; doneDays(i) → отметить ли день i; kind(i, sid) → k события. */
function build(days, { gym = () => true, namaz = () => true, kind = () => '', vitrSince } = {}) {
  const d = typicalData();
  for (const h of d.habits) h.createdAt = START.getTime();
  if (vitrSince) d.habits[0].stages.find((s) => s.id === 'p-vitr').since = vitrSince;
  d.logs = { gym: {}, namaz: {} };
  for (let i = 0; i < days; i++) {
    const k = dkey(addDays(START, i));
    const ts = addDays(START, i).getTime() + 3600e3;
    if (gym(i)) d.logs.gym[k] = { ev: [{ id: `g${i}`, ts, d: 1 }], t: ts, v: 1 };
    if (namaz(i)) {
      const ev = PR.filter((s) => !(vitrSince && s === 'p-vitr' && k < vitrSince)).map((s, j) => ({ id: `n${i}${j}`, ts, d: 1, s, ...(kind(i, s) ? { k: kind(i, s) } : {}) }));
      d.logs.namaz[k] = { ev, t: ts, v: ev.length };
    }
  }
  replaceData(d);
}
const at = (i) => setNow(addDays(START, i).getTime() + 22 * 3600e3); // вечер дня i

// 1. Ежедневно: ≈80 через месяц, ≈96 через два, ≈99 через три
build(90);
for (const [n, exp] of [[30, 80], [60, 96], [90, 99]]) {
  at(n - 1);
  const v = strengthOf(findHabit('gym'));
  assert.ok(Math.abs(v - exp) <= 1, `${n} дней: ${v}`);
}
console.log('✓ ежедневно: 30 дней ≈80, 60 ≈96, 90 ≈99');

// 2. 60 дней подряд → пропуск → сила падает, но остаётся высокой; серия обнуляется
build(61, { gym: (i) => i !== 60 }); // дни 0..60, день 60 пропущен
at(59);
const before = strengthOf(findHabit('gym'));
assert.equal(currentStreak(findHabit('gym')).value, 60);
at(60);
setNow(addDays(START, 61).getTime() + 1); // утро следующего дня: пропуск 60-го уже засчитан
const afterMiss = strengthOf(findHabit('gym'));
assert.ok(afterMiss < before && afterMiss >= 90, `после пропуска: ${before} → ${afterMiss}`);
assert.equal(currentStreak(findHabit('gym')).value, 0, 'серия обнулилась');
build(65, { gym: (i) => i !== 60 }); // дальше снова отмечается
at(61);
assert.equal(currentStreak(findHabit('gym')).value, 1);
at(64);
assert.ok(strengthOf(findHabit('gym')) > afterMiss, 'снова растёт');
console.log(`✓ 60 дней → пропуск: сила ${before} → ${afterMiss} (серия 60 → 0), затем снова растёт`);

// 3. Сегодня ещё не отмечено — сила как на вчера
build(10, { gym: (i) => i < 9 });
setNow(addDays(START, 9).getTime() + 8 * 3600e3);
assert.equal(strengthOf(findHabit('gym')), strengthOf(findHabit('gym'), addDays(START, 8)));
console.log('✓ неотмеченное «сегодня» не снижает силу');

// 4. Каза — частичный вклад
build(30, { kind: (i, s) => (i === 29 && s === 'p-fajr' ? 'qada' : '') });
at(29);
const h = findHabit('namaz');
assert.equal(dayCredit(h, dkey(addDays(START, 29))), (5 + QADA_CREDIT) / 6);
const withQada = strengthOf(h);
build(30);
const allOntime = strengthOf(findHabit('namaz'));
build(30, { namaz: (i) => i !== 29 });
setNow(addDays(START, 30).getTime() + 1);
const missed = strengthOf(findHabit('namaz'), addDays(START, 29));
assert.ok(missed < withQada && withQada < allOntime, `пропуск ${missed} < каза ${withQada} < вовремя ${allOntime}`);
console.log(`✓ каза засчитан частично: пропуск ${missed} < каза ${withQada} < вовремя ${allOntime}`);

// 5. Витр, добавленный позже, не портит прошлое: до since вклад считается по 5 намазам
build(40, { vitrSince: dkey(addDays(START, 30)), kind: () => '' });
// до since Витр не отмечался (этапа ещё не было)
at(39);
const hv = findHabit('namaz');
assert.equal(dayCredit(hv, dkey(addDays(START, 10))), 1, 'до since этапов 5, все отмечены');
const s20 = strengthOf(hv, addDays(START, 20));
build(40);
assert.equal(s20, strengthOf(findHabit('namaz'), addDays(START, 20)), 'сила за прошлое одинакова');
console.log('✓ этап, добавленный позже, не портит силу за прошлые дни');

// 6. «N в неделю»
{
  const d = typicalData();
  const gym = d.habits.find((x) => x.id === 'gym');
  gym.createdAt = START.getTime();
  gym.schedule = { kind: 'perWeek', times: 3 };
  d.logs = { gym: {} };
  for (let w = 0; w < 8; w++) for (let j = 0; j < 3; j++) {
    const k = dkey(addDays(START, w * 7 + j * 2 + 4)); // 1 янв 2026 — четверг; недели с понедельника 5 янв
    d.logs.gym[k] = { ev: [{ id: `w${w}${j}`, ts: 1, d: 1 }], t: 1, v: 1 };
  }
  replaceData(d);
  at(60);
  const full = strengthOf(findHabit('gym'));
  assert.ok(full > 30, `8 недель нормы: ${full}`);
  console.log(`✓ N в неделю: 8 недель нормы → сила ${full}`);
}
