// Счётчик зикров: тексты символ в символ, подходы в журнале, восстановление, синхронизация.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { createCounter, recoverPending, dhikrTotals, dhikrSums, dhikrAllTime, roundView, targetFor, collectionItems, collectionIsNow, DHIKR_COLLECTIONS, DHIKR_PENDING_KEY, DHIKR_LOG } from '../js/dhikr.js';
import { replaceData, getData, addDhikrRecord, merge } from '../js/store.js';
import { dayStats } from '../js/logic.js';

// 1. Тексты из ТЗ — символ в символ (кодовые точки), знак васла U+0671 на месте, без нормализации
const list = JSON.parse(readFileSync(new URL('../data/dhikr.json', import.meta.url), 'utf8'));
const cps = (s) => [...s].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const EXPECTED = {
  subhanallah: '0633 064F 0628 0652 062D 064E 0627 0646 064E 0020 0627 0644 0644 064E 0651 0647 0650',
  alhamdulillah: '0671 0644 0652 062D 064E 0645 0652 062F 064F 0020 0644 0650 0644 064E 0651 0647 0650',
  allahuakbar: '0627 0644 0644 064E 0651 0647 064F 0020 0623 064E 0643 0652 0628 064E 0631 064F',
  astaghfirullah: '0623 064E 0633 0652 062A 064E 063A 0652 0641 0650 0631 064F 0020 0671 0644 0644 064E 0651 0647 064E',
};
assert.deepEqual(list.map((x) => x.id), ['subhanallah', 'alhamdulillah', 'allahuakbar', 'astaghfirullah']);
for (const x of list) assert.equal(cps(x.arabic), EXPECTED[x.id], x.id);
assert.ok(list[1].arabic.startsWith('ٱ') && list[3].arabic.includes('ٱ'), 'алиф с васлой U+0671');
assert.deepEqual(list.map((x) => x.translit), ['Субхааналлаах.', 'Аль-хамду лилляях.', 'Аллааху акбар.', 'Астагфируллаах.']);
assert.equal(list[0].ru, 'Преславен и Пречист Аллах от всех недостатков.');
console.log('✓ data/dhikr.json: арабский текст совпадает по кодовым точкам, U+0671 на месте');

const memStorage = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const records = () => getData().logs[DHIKR_LOG] || {};
const allEvents = () => Object.values(records()).flatMap((e) => e.ev);

setNow(new Date(2026, 10, 11, 9, 0).getTime());
replaceData(typicalData());

// 2. 200 быстрых нажатий → 200, одна запись
{
  const st = memStorage();
  const c = createCounter({ storage: st, record: addDhikrRecord });
  for (let i = 0; i < 200; i++) c.tap();
  assert.equal(c.shown, 200);
  assert.equal(allEvents().length, 0, 'до «Готово» журнал не трогаем');
  assert.equal(JSON.parse(st.getItem(DHIKR_PENDING_KEY)).n, 200, 'в localStorage на случай закрытия');
  c.commit();
  assert.equal(allEvents().length, 1);
  assert.deepEqual({ k: allEvents()[0].k, s: allEvents()[0].s, n: allEvents()[0].n, d: allEvents()[0].d }, { k: 'dhikr', s: 'subhanallah', n: 200, d: 200 });
  assert.equal(st.getItem(DHIKR_PENDING_KEY), null);
  c.commit();
  assert.equal(allEvents().length, 1, 'повторный commit без нажатий — без записи');
  console.log('✓ 200 нажатий → счёт 200, в журнале одна запись { k: dhikr, s, n: 200 }');
}

// 3. Закрыли Telegram посреди счёта → при следующем открытии подход записан ровно один раз
{
  replaceData(typicalData());
  const st = memStorage();
  const c = createCounter({ storage: st, record: addDhikrRecord, id: 'astaghfirullah' });
  for (let i = 0; i < 57; i++) c.tap();
  // приложение «убито» — без commit; новый запуск:
  assert.equal(recoverPending(st, addDhikrRecord), 57);
  assert.equal(recoverPending(st, addDhikrRecord), 0, 'второй запуск ничего не добавляет');
  assert.equal(dhikrTotals(getData(), '2026-11-11').byId.astaghfirullah, 57);
  assert.equal(allEvents().length, 1);
  console.log('✓ закрытие посреди счёта: подход 57 восстановлен и записан один раз');
}

// 4. Переключение зикра посреди счёта; сворачивание — непрерывный счёт
{
  replaceData(typicalData());
  const c = createCounter({ storage: memStorage(), record: addDhikrRecord });
  for (let i = 0; i < 20; i++) c.tap();
  c.switchTo('alhamdulillah');
  assert.equal(c.shown, 0, 'новый зикр с 0');
  for (let i = 0; i < 10; i++) c.tap();
  c.commit(); // сворачивание
  assert.equal(c.shown, 10, 'число на экране не сброшено');
  for (let i = 0; i < 23; i++) c.tap();
  assert.equal(c.shown, 33);
  c.commit();
  const t = dhikrTotals(getData(), '2026-11-11');
  assert.deepEqual(t.byId, { subhanallah: 20, alhamdulillah: 33 });
  assert.equal(allEvents().length, 3, 'три подхода: 20, 10, 23');
  c.reset();
  assert.equal(c.shown, 0);
  console.log('✓ переключение зикра — отдельная запись; сворачивание — счёт продолжается, сумма верная');
}

// 5. Два устройства за день суммируются
{
  const base = typicalData();
  replaceData(base);
  addDhikrRecord('2026-11-11', 'subhanallah', 33, 1);
  const a = JSON.parse(JSON.stringify(getData()));
  replaceData(base);
  addDhikrRecord('2026-11-11', 'subhanallah', 100, 2);
  addDhikrRecord('2026-11-11', 'allahuakbar', 34, 3);
  const b = JSON.parse(JSON.stringify(getData()));
  for (const m of [merge(a, b), merge(b, a), merge(merge(a, b), a)]) {
    const t = dhikrTotals(m, '2026-11-11');
    assert.deepEqual(t.byId, { subhanallah: 133, allahuakbar: 34 });
    assert.equal(t.total, 167);
  }
  console.log('✓ два устройства: 33 + 100 Субханаллах = 133 в обе стороны слияния');
}

// 6. 7 и 30 дней; зикры не влияют на итоги дня
{
  replaceData(typicalData());
  const before = dayStats(new Date(2026, 10, 11));
  addDhikrRecord('2026-11-11', 'subhanallah', 33);
  addDhikrRecord('2026-11-06', 'subhanallah', 99);
  addDhikrRecord('2026-10-20', 'subhanallah', 1000);
  addDhikrRecord('2026-10-01', 'subhanallah', 5);
  const until = new Date(2026, 10, 11);
  assert.equal(dhikrSums(getData(), until, 7).byId.subhanallah, 132);
  assert.equal(dhikrSums(getData(), until, 30).byId.subhanallah, 1132);
  assert.deepEqual(dayStats(new Date(2026, 10, 11)), before, 'кольцо дня не меняется');
  console.log('✓ суммы за 7 и 30 дней; итоги дня не зависят от зикров');
}

// 7. Круги: после цели — ✓, затем счёт с 1; в журнал — общее число нажатий
{
  assert.deepEqual(roundView(0, 33), { value: 0, rounds: 0, full: false });
  assert.deepEqual(roundView(32, 33), { value: 32, rounds: 0, full: false });
  assert.deepEqual(roundView(33, 33), { value: 33, rounds: 1, full: true });
  assert.deepEqual(roundView(34, 33), { value: 1, rounds: 1, full: false });
  assert.deepEqual(roundView(66, 33), { value: 33, rounds: 2, full: true });
  assert.deepEqual(roundView(70, 33), { value: 4, rounds: 2, full: false });
  assert.deepEqual(roundView(150, 0), { value: 150, rounds: 0, full: false }, 'без цели — растущее число');
  replaceData(typicalData());
  const c = createCounter({ storage: memStorage(), record: addDhikrRecord });
  for (let i = 0; i < 70; i++) c.tap();
  assert.equal(roundView(c.shown, 33).value, 4);
  c.switchTo('alhamdulillah'); // свайп на следующий
  assert.deepEqual(allEvents().map((e) => e.n), [70], 'одна запись n = 70, круги не влияют');
  console.log('✓ круги: 33 ✓ → 1, 70 нажатий = круг 3 со счётом 4; в журнале одна запись n = 70');
}

// 8. Разделы: избранное, цель элемента, всего за всё время, «Сейчас»
{
  const s = { dhikr: { target: 33, favorites: ['astaghfirullah', 'nope', 'subhanallah'] } };
  assert.deepEqual(collectionItems('favorites', list, s).map((x) => x.id), ['astaghfirullah', 'subhanallah']);
  assert.equal(collectionItems('all', list, s).length, 4);
  assert.deepEqual(collectionItems('morning', list, s), [], 'утренние азкары — позже');
  assert.equal(targetFor(list[0], s), 33);
  assert.equal(targetFor({ ...list[0], count: 3 }, s), 3, 'свой счёт повторов важнее общей цели');
  assert.equal(targetFor(list[0], { dhikr: { target: 0 } }), 0);
  replaceData(typicalData());
  addDhikrRecord('2026-11-01', 'subhanallah', 40);
  addDhikrRecord('2026-11-11', 'subhanallah', 2);
  assert.deepEqual(dhikrAllTime(getData()), { subhanallah: 42 });
  const morning = DHIKR_COLLECTIONS.find((c) => c.id === 'morning');
  const pr = { fajr: 340, dhuhr: 727, asr: 925, isha: 1106 };
  assert.ok(collectionIsNow(morning, pr, 400) && !collectionIsNow(morning, pr, 800));
  console.log('✓ разделы: избранное, свой count, «всего» за всё время, метка «Сейчас» по времени намаза');
}
