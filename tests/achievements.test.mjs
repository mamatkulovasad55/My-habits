// Личные достижения: даты задним числом, сверка со «Статистикой», полученное не пропадает.
import assert from 'node:assert/strict';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { replaceData, getData, update, upsertHabit, awardAchievements, merge, normalize, resetAll, prepareImport, habitsAll } from '../js/store.js';
import { computeAchievements, earnedFromData, habitRunSteps, ACH_BADGES } from '../js/achievements.js';
import { bestStreak, currentStreak } from '../js/logic.js';

setNow(Date.UTC(2026, 10, 16, 9)); // пн 16.11.2026
const key = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const ts = (k, h = 9) => Date.parse(`${k}T${String(h).padStart(2, '0')}:00:00Z`);
let n = 0;
const ev = (k, s, extra = {}) => ({ id: `e${n++}`, ts: ts(k), d: 1, ...(s ? { s } : {}), ...extra });
const entry = (evs) => ({ ev: evs, t: evs[evs.length - 1].ts, v: evs.reduce((a, x) => a + x.d, 0) });
const FARD = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

const data = typicalData();
data.logs.namaz = {};
// 1–10 ноября все 5 фардов: 4-го Иша «позже» (засчитывается), 11-го Зухр — каза (рвёт серию)
for (let d = 1; d <= 11; d++) {
  const k = key(11, d);
  data.logs.namaz[k] = entry(FARD.map((p) => ev(k, `p-${p}`, d === 4 && p === 'isha' ? { k: 'late' } : d === 11 && p === 'dhuhr' ? { k: 'qada' } : {})));
}
// Джума: 16, 23, 30 октября и 6 ноября (13 ноября — Зухр вместо Джума)
for (const k of [key(10, 16), key(10, 23), key(10, 30), key(11, 6)]) {
  const evs = (data.logs.namaz[k]?.ev || []).filter((x) => x.s !== 'p-dhuhr');
  data.logs.namaz[k] = entry([...evs, ev(k, 'p-dhuhr', { k: 'juma' })]);
}
// после каза 11-го — снова вовремя 12-го и 13-го (13-го в пятницу Зухр вместо Джума): серия начинается заново
for (const d of [12, 13]) {
  const k = key(11, d);
  data.logs.namaz[k] = entry(FARD.map((p) => ev(k, `p-${p}`, d === 13 && p === 'dhuhr' ? { k: 'dhuhr' } : {})));
}
// Каза: 12 восполнений старого долга с 1 ноября, одно отменено (−1) → 10-е — 11 ноября
data.logs.__qada = {};
for (let d = 1; d <= 12; d++) {
  const k = key(11, d);
  data.logs.__qada[k] = entry([ev(k, 'fajr', { k: 'qada' })]);
}
data.logs.__qada[key(11, 3)].ev.push({ id: 'undo', ts: ts(key(11, 3), 10), d: -1, s: 'fajr' });
// Зарядка: 1–7 ноября подряд, 8-го пропуск
data.logs.gym = {};
for (let d = 1; d <= 7; d++) data.logs.gym[key(11, d)] = entry([ev(key(11, d))]);
// Воздержание: прошлая попытка 1–9 октября (8 дней), текущая с 14 ноября
data.abstain[0].attempts = [{ start: ts(key(10, 1)), end: ts(key(10, 9)) }];
data.abstain[0].startedAt = ts(key(11, 14));
data.settings.qada = { ...data.settings.qada, since: '2026-11-01' };
replaceData(data);

const p = computeAchievements();
const earned = Object.fromEntries(earnedFromData(p).map((x) => [x.id, x.earnedAt]));
assert.equal(earned['fard-ontime-7'], '2026-11-07', '7-й день подряд (день с «позже» засчитан)');
assert.equal(p['fard-ontime'].current, 0, '14–15-го без отметок — серия прервана');
{
  // 1–10 и 12–13 вовремя, 11-го Зухр каза: без обрыва было бы 13 дней подряд
  const { METRICS } = await import('../js/achievements.js');
  const r = METRICS.fardOntimeRun([10, 12]);
  assert.equal(r.reached[10], '2026-11-10');
  assert.equal(r.reached[12], undefined, 'каза 11-го рвёт серию');
}
assert.equal(earned['fard-ontime-30'], undefined);
assert.equal(earned['juma-4'], '2026-11-06', '4-я пятница подряд');
assert.equal(p.juma.current, 0, '13-го — Зухр вместо Джума');
assert.equal(earned['qada-total-10'], '2026-11-11', '10 с учётом отмены');
assert.equal(p['qada-total'].current, 12, '11 по старому долгу (12 − 1 отмена) + 1 каза по трекеру 11-го');
assert.equal(earned['habit-streak-7'], '2026-11-07');
assert.equal(earned['abstain-days-7'], '2026-10-08', 'прошлая попытка: начало + 7 дней');
assert.equal(p['abstain-days'].current, 2, 'текущая попытка с 14-го');
console.log('✓ даты задним числом: фарды (с «позже»), Джума, каза (с отменой), серия привычки, воздержание');

// Сверка со «Статистикой»: серии с датами = bestStreak / currentStreak, прогресс = «Лучшая текущая серия»
const runOf = (steps) => {
  let run = 0;
  let best = 0;
  for (const s of steps) {
    if (s.ok === null) continue;
    run = s.ok ? run + (s.weight || 1) : 0;
    best = Math.max(best, run);
  }
  return { run, best };
};
for (const h of habitsAll()) {
  const r = runOf(habitRunSteps(h));
  const mul = h.schedule?.kind === 'perWeek' ? 7 : 1;
  assert.equal(r.best, bestStreak(h).value * mul, `${h.name}: рекорд`);
  assert.equal(r.run, currentStreak(h).value * mul, `${h.name}: текущая`);
}
// недельная привычка: 3 раза в неделю, 3 недели подряд
upsertHabit({ id: 'read', name: 'Чтение', type: 'check', createdAt: ts(key(10, 19)), schedule: { kind: 'perWeek', times: 3 } });
update((d) => {
  d.logs.read = {};
  for (const k of ['2026-10-19', '2026-10-20', '2026-10-22', '2026-10-26', '2026-10-27', '2026-10-29', '2026-11-02', '2026-11-03', '2026-11-04']) d.logs.read[k] = entry([ev(k)]);
});
const rh = habitsAll().find((h) => h.id === 'read');
assert.equal(runOf(habitRunSteps(rh)).best, bestStreak(rh).value * 7);
const p2 = computeAchievements();
const cur = Math.max(...habitsAll().filter((h) => !h.archived).map((h) => { const c = currentStreak(h); return c.unit === 'weeks' ? c.value * 7 : c.value; }));
assert.equal(p2['habit-streak'].current, cur, 'прогресс = «Лучшая текущая серия»');
console.log('✓ серии совпадают с «Статистикой» (рекорд, текущая, недельная привычка)');

// Выдача и сохранность
const added = awardAchievements(earnedFromData(computeAchievements()));
assert.equal(added.length, 5);
assert.equal(awardAchievements(earnedFromData(computeAchievements())).length, 0, 'повторно не выдаётся');
upsertHabit({ id: 'gym', archived: true });
update((d) => delete d.logs.gym);
update((d) => delete d.logs.__qada);
awardAchievements(earnedFromData(computeAchievements()));
const ids = getData().achievements.map((x) => x.id);
assert.ok(ids.includes('habit-streak-7') && ids.includes('qada-total-10'), 'архивация и удаление отметок не отбирают');
console.log('✓ архивация привычки и удаление отметок не отбирают полученное');

// Слияние двух устройств
const A = normalize({ achievements: [{ id: 'juma-4', earnedAt: '2026-11-06', at: 5 }, { id: 'fard-ontime-7', earnedAt: '2026-11-07', at: 5 }] });
const B = normalize({ achievements: [{ id: 'fard-ontime-7', earnedAt: '2026-11-05', at: 9 }, { id: 'qada-total-10', earnedAt: '2026-11-11', at: 9 }] });
const m = merge(A, B).achievements;
assert.deepEqual(m.map((x) => x.id).sort(), ['fard-ontime-7', 'juma-4', 'qada-total-10']);
assert.equal(m.find((x) => x.id === 'fard-ontime-7').earnedAt, '2026-11-05', 'самая ранняя дата');
assert.deepEqual(merge(B, A).achievements, m, 'порядок не важен');
console.log('✓ слияние двух устройств: объединение, самая ранняя дата');

// Экспорт → удалить всё → импорт
const backup = JSON.parse(JSON.stringify(getData()));
setNow(Date.UTC(2026, 10, 16, 10));
resetAll(null, Date.UTC(2026, 10, 16, 10));
const wiped = JSON.parse(JSON.stringify(getData()));
assert.deepEqual(wiped.achievements, []);
assert.deepEqual(merge(backup, wiped).achievements, [], 'сервер со старыми записями их не возвращает');
const restored = merge(wiped, prepareImport(wiped, backup, Date.UTC(2026, 10, 16, 11)));
assert.equal(restored.achievements.length, backup.achievements.length, 'импорт вернул');
assert.equal(merge(restored, backup).achievements.length, backup.achievements.length, 'и сервер не отменяет');
console.log('✓ экспорт → удалить всё → импорт: достижения на месте');
assert.equal(ACH_BADGES.length, 15);
