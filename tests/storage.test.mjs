// Безопасная запись в localStorage: сбой не ломает приложение, уведомление — только при смене состояния.
import assert from 'node:assert/strict';

// Фейковое хранилище, которое умеет «переполняться»
const mem = new Map();
let mode = 'ok'; // ok | quota | security | removeFail
const fake = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem(k, v) {
    if (mode === 'quota') throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    if (mode === 'security') throw Object.assign(new Error('denied'), { name: 'SecurityError' });
    mem.set(k, String(v));
  },
  removeItem(k) {
    if (mode === 'removeFail') throw Object.assign(new Error('nope'), { name: 'UnknownError' });
    mem.delete(k);
  },
};

// 1. Без localStorage (как в боте) — ни одного уведомления
{
  const st = await import('../js/storage.js?nols');
  const seen = [];
  st.onStorageStatus((f) => seen.push(f));
  assert.equal(st.storageSet('a', '1'), true);
  assert.equal(st.storageRemove('a'), true);
  assert.equal(st.storageGet('a'), null);
  assert.equal(st.storageFailed(), null);
  assert.equal(seen.length, 0);
  console.log('✓ без localStorage (бот): запись пропускается молча, это не сбой');
}

globalThis.localStorage = fake;
const st = await import('../js/storage.js');
const store = await import('../js/store.js');
const seen = [];
st.onStorageStatus((f) => seen.push(f ? f.name : 'ok'));

// 2. Переполнение: update() не падает, данные в памяти, уведомление ровно одно
mode = 'quota';
store.upsertHabit({ id: 'h1', name: 'Вода' });
store.upsertHabit({ id: 'h2', name: 'Чтение' });
store.setSetting('theme', 'dark');
assert.equal(store.getData().habits.length, 2, 'данные остались в памяти');
assert.equal(store.getData().settings.theme, 'dark');
assert.equal(st.storageFailed()?.name, 'QuotaExceededError');
assert.deepEqual(seen, ['QuotaExceededError'], 'одно уведомление на серию сбоев');
assert.equal(mem.has('myhabits:data:v1'), false, 'на устройство ничего не записалось');
console.log('✓ переполнение: данные в памяти, предупреждение одно на три записи');

// 3. Хранилище снова работает → «ок», затем новый сбой снова уведомляет
mode = 'ok';
store.upsertHabit({ id: 'h3', name: 'Зарядка' });
assert.equal(st.storageFailed(), null);
assert.deepEqual(seen, ['QuotaExceededError', 'ok']);
assert.equal(JSON.parse(mem.get('myhabits:data:v1')).habits.length, 3, 'после восстановления записано всё, включая данные времени сбоя');
mode = 'security';
store.updateLocal((l) => (l.timers = { h1: { at: 1 } }));
assert.deepEqual(seen, ['QuotaExceededError', 'ok', 'SecurityError']);
console.log('✓ восстановление снимает предупреждение; другая ошибка (SecurityError) — тоже сбой');

// 4. Ошибка removeItem — сбой
mode = 'ok';
st.storageSet('x', '1');
mode = 'removeFail';
assert.equal(st.storageRemove('x'), false);
assert.equal(st.storageFailed()?.name, 'UnknownError');
console.log('✓ ошибка удаления — тоже сбой');

// 5. Счётчик зикров через обёртку при сбое не падает
const { createCounter, DHIKR_PENDING_KEY } = await import('../js/dhikr.js');
mode = 'quota';
const rec = [];
const c = createCounter({ storage: st.storage, record: (...a) => rec.push(a) });
for (let i = 0; i < 40; i++) c.tap();
c.commit();
assert.equal(rec.length, 1);
assert.equal(rec[0][2], 40, 'подход записан в журнал целиком');
mode = 'ok';
c.tap();
assert.ok(mem.has(DHIKR_PENDING_KEY), 'после восстановления подход снова сохраняется');
console.log('✓ зикры: 40 нажатий при переполнении — подход записан, без исключений');
