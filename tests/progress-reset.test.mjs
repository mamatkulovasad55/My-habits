// «Сбросить прогресс»: история обнуляется, структура остаётся; второе устройство и отстающая правка детокса
// не возвращают старое; импорт бэкапа «до сброса» восстанавливает всё, включая детокс и долг каза.
import assert from 'node:assert/strict';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { normalize, merge, prepareImport, replaceData, getData } from '../js/store.js';
import { resetProgressNow } from '../js/backup.js';
import { qadaDebt, QADA_KEYS, stageStatus, stagesForDay } from '../js/schedule.js';
import { firstDay } from '../js/logic.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const T0 = at(2026, 11, 10, 20);
const RESET = at(2026, 11, 16, 12);
const LATER = at(2026, 11, 16, 13);
const debtBy = () => Object.fromEntries(QADA_KEYS.map((k) => [k, qadaDebt().byPrayer[k].total]));

function full() {
  const d = normalize(typicalData());
  d.habits.forEach((h) => (h.createdAt = at(2026, 11, 1, 0)));
  d.settings.profile = { niyyah: 'Ради Аллаха' };
  d.settings.qada = { ...d.settings.qada, since: '2026-11-01', vitrSince: '2026-11-01', old: { ...d.settings.qada.old, fajr: 10 } };
  d.settings.updatedAt = T0;
  const all = ['p-fajr', 'p-dhuhr', 'p-asr', 'p-maghrib', 'p-isha', 'p-vitr'];
  d.logs.namaz = {};
  for (let day = 1; day <= 15; day++) {
    if (day === 7) continue; // 7-го ничего не отмечено — 6 пропусков в долг
    const k = `2026-11-${String(day).padStart(2, '0')}`;
    const ts = at(2026, 11, day, 21);
    d.logs.namaz[k] = { ev: all.map((s, i) => ({ id: `${k}${i}`, ts, d: 1, s })), t: ts, v: 6 };
  }
  d.logs.gym = { '2026-11-10': { v: 1, t: T0, ev: [{ id: 'g1', ts: T0, d: 1 }] } };
  d.logs.__dhikr = { '2026-11-10': { v: 33, t: T0, ev: [{ id: 'z1', ts: T0, d: 33, n: 33, s: 'subhanallah', k: 'dhikr' }] } };
  d.logs.__qada = { '2026-11-10': { v: 2, t: T0, ev: [{ id: 'q1', ts: T0, d: 2, s: 'fajr', k: 'qada' }] } };
  d.notes = { '2026-11-10': { text: 'заметка', t: T0 } };
  d.achievements = [{ id: 'streak-7', earnedAt: '2026-11-08', at: T0 }];
  d.abstain[0] = { ...d.abstain[0], startedAt: at(2026, 11, 5, 9), attempts: [{ start: at(2026, 11, 1, 9), end: at(2026, 11, 5, 9), note: '' }], cleanDays: ['2026-11-06', '2026-11-07'], updatedAt: T0 };
  return d;
}

// 1. Сброс на устройстве
const server = full();
replaceData(clone(server));
setNow(RESET);
const before = debtBy();
assert.equal(before.fajr, 10 - 2 + 2, 'до сброса: старый долг минус восполненное плюс пропуски 7-го и сегодняшний (16-е не отмечено)');
resetProgressNow(new Date(RESET));
const reset = clone(getData());
assert.equal(reset.habits.filter((h) => !h.deleted).length, server.habits.length, 'привычки на месте');
assert.deepEqual(reset.habits.find((h) => h.id === 'namaz').stages, server.habits.find((h) => h.id === 'namaz').stages, 'этапы на месте');
assert.deepEqual(reset.logs, {});
assert.deepEqual(reset.notes, {});
assert.deepEqual(reset.achievements, []);
assert.equal(reset.settings.profile.niyyah, 'Ради Аллаха', 'ниййа осталась');
assert.equal(reset.settings.prayer.city, 'Ташкент', 'настройки остались');
const a = reset.abstain[0];
assert.equal(a.startedAt, RESET, 'отсчёт детокса — с момента сброса');
assert.deepEqual(a.attempts, []);
assert.deepEqual(a.cleanDays, []);
assert.ok(!a.deleted, 'детокс не удалён');
assert.deepEqual(debtBy(), before, 'долг каза после сброса не изменился');
const namaz = getData().habits.find((h) => h.id === 'namaz');
assert.equal(+firstDay(namaz), +new Date(2026, 10, 16), 'история привычки — с дня сброса');
const today = new Date(2026, 10, 16);
assert.ok(stagesForDay(namaz, today).every((s) => stageStatus(namaz, today, s, new Date(RESET)) !== 'missed'), 'сегодняшние намазы не становятся долгом');
console.log('✓ сброс: привычки, этапы, настройки и ниййа на месте; история, достижения и детокс обнулены; долг каза тот же');

// 2. Сервер и второе устройство со старыми данными не возвращают историю
for (const m of [merge(clone(server), reset), merge(reset, clone(server))]) {
  assert.deepEqual(m.logs, {});
  assert.deepEqual(m.notes, {});
  assert.deepEqual(m.achievements, []);
  assert.deepEqual(m.abstain[0].attempts, []);
  assert.deepEqual(m.abstain[0].cleanDays, []);
  assert.equal(m.habits.filter((h) => !h.deleted).length, server.habits.length);
}
console.log('✓ слияние со старой копией: история не возвращается, привычки не пропадают');

// 3. Отстающее устройство отметило чистый день и срыв, не зная о сбросе — старые попытки не возвращаются
const stale = clone(server);
stale.abstain[0] = { ...stale.abstain[0], cleanDays: [...stale.abstain[0].cleanDays, '2026-11-16'], updatedAt: LATER };
// и срыв: в его попытках — старая история плюс попытка, начатая до сброса и законченная после
const staleRelapse = clone(stale);
staleRelapse.abstain[0] = { ...staleRelapse.abstain[0], attempts: [...staleRelapse.abstain[0].attempts, { start: staleRelapse.abstain[0].startedAt, end: LATER, note: '' }], startedAt: LATER, cleanDays: [], updatedAt: LATER + 1 };
for (const m of [merge(reset, staleRelapse), merge(staleRelapse, reset)]) {
  const x = m.abstain[0];
  assert.deepEqual(x.attempts, [{ start: RESET, end: LATER, note: '' }], 'срыв после сброса — одна попытка, начатая с момента сброса');
  assert.equal(x.startedAt, LATER);
}
stale.logs.gym['2026-11-16'] = { v: 1, t: LATER, ev: [{ id: 'g2', ts: LATER, d: 1 }] };
for (const m of [merge(reset, stale), merge(stale, reset), merge(merge(reset, stale), clone(server))]) {
  const x = m.abstain[0];
  assert.deepEqual(x.attempts, [], 'старые попытки не вернулись');
  assert.deepEqual(x.cleanDays, ['2026-11-16'], 'новая отметка осталась, старые — нет');
  assert.equal(x.startedAt, RESET);
  assert.equal(m.logs.gym['2026-11-16'].v, 1, 'отметка после сброса живёт');
  assert.equal(m.logs.gym['2026-11-10'], undefined);
}
console.log('✓ отстающее устройство: правка детокса не возвращает историю до сброса');

// 4. Новая попытка после сброса живёт
const after = clone(reset);
after.abstain[0] = { ...after.abstain[0], attempts: [{ start: RESET, end: LATER, note: '' }], startedAt: LATER, updatedAt: LATER };
assert.equal(merge(clone(server), after).abstain[0].attempts.length, 1);
console.log('✓ срыв после сброса сохраняется');

// 5. Импорт бэкапа «до сброса» возвращает всё; синхронизация это не отменяет
setNow(LATER);
const restored = merge(reset, prepareImport(reset, clone(server), LATER));
replaceData(clone(restored));
assert.equal(restored.logs.namaz['2026-11-10'].v, 6);
assert.equal(restored.logs.__dhikr['2026-11-10'].v, 33);
assert.equal(restored.logs.__qada['2026-11-10'].v, 2);
assert.equal(restored.notes['2026-11-10'].text, 'заметка');
assert.equal(restored.achievements.length, 1);
assert.equal(restored.abstain[0].attempts.length, 1, 'попытки детокса вернулись');
assert.deepEqual(restored.abstain[0].cleanDays, ['2026-11-06', '2026-11-07']);
assert.equal(restored.abstain[0].startedAt, server.abstain[0].startedAt);
assert.deepEqual(debtBy(), before, 'долг каза после «сброс → импорт» равен долгу до сброса');
for (const m of [merge(reset, restored), merge(restored, reset), merge(restored, clone(server))]) {
  assert.equal(m.abstain[0].attempts.length, 1);
  assert.equal(m.logs.namaz['2026-11-10'].v, 6);
}
console.log('✓ импорт бэкапа после сброса: журналы, достижения, детокс и долг каза вернулись и не пропадают при синхронизации');

// 6. Импорт после сброса не трогает здешние настройки: тема, город и защита «Детокса» остаются, долг каза возвращается
{
  const local = clone(reset);
  local.settings.theme = 'dark';
  local.settings.privacy = { ...local.settings.privacy, enabled: true };
  local.settings.prayer = { ...local.settings.prayer, city: 'Самарканд' };
  local.settings._t = { ...local.settings._t, theme: LATER, 'privacy.enabled': LATER, 'prayer.city': LATER };
  const m = merge(local, prepareImport(local, clone(server), LATER + 1000));
  assert.equal(m.settings.theme, 'dark');
  assert.equal(m.settings.privacy.enabled, true, 'импорт старого файла не выключает защиту');
  assert.equal(m.settings.prayer.city, 'Самарканд');
  assert.deepEqual(m.settings.qada.old, server.settings.qada.old, 'остаток долга — из файла');
  assert.equal(m.settings.qada.since, server.settings.qada.since);
  assert.equal(m.settings.profile.niyyah, 'Ради Аллаха');
  console.log('✓ импорт после сброса: настройки остаются здешними, из файла — только долг каза');
}

// 7. Намаз без единой отметки: долг после «сброс → импорт» равен долгу до сброса
{
  const bare = full();
  delete bare.logs.namaz;
  replaceData(clone(bare));
  setNow(RESET);
  const was = qadaDebt().total;
  resetProgressNow(new Date(RESET));
  assert.equal(qadaDebt().total, was);
  const r = clone(getData());
  setNow(LATER);
  replaceData(merge(r, prepareImport(r, clone(bare), LATER)));
  assert.equal(qadaDebt().total, was, 'долг после импорта тот же');
  // второй сброс после импорта снова считает историю с дня сброса
  setNow(LATER + 60000);
  resetProgressNow(new Date(LATER + 60000));
  assert.equal(qadaDebt().total, was);
  console.log('✓ намаз без отметок: долг каза совпадает после сброса, импорта и повторного сброса');
}
