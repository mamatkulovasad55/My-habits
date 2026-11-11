// Версия схемы, миграции и совместимость слияния между старым и новым кодом.
import assert from 'node:assert/strict';
import { migrate, SCHEMA_VERSION } from '../js/migrate.js';
import { merge, normalize, defaultSettings } from '../js/store.js';
import { typicalData } from './fixtures.mjs';

const strip = (d) => {
  const { schemaVersion, version, ...rest } = d;
  return rest;
};

// 1. Данные без schemaVersion → v1 без потерь
{
  const old = typicalData();
  old.logs = { namaz: { '2026-11-10': { ev: [{ id: 'a', ts: 1, d: 1, s: 'p-fajr', k: 'qada' }], t: 1, v: 1 } }, gym: { '2026-01-01': { v: 1, t: 5 } } };
  old.notes = { '2026-11-10': { text: 'день', t: 3 } };
  const snapshot = JSON.stringify(old);
  const m = migrate(old);
  assert.equal(m.schemaVersion, SCHEMA_VERSION);
  assert.equal(JSON.stringify(old), snapshot, 'исходный объект не изменён');
  assert.deepEqual(strip(m), JSON.parse(snapshot), 'кроме schemaVersion всё на месте');
  const n = normalize(old);
  assert.equal(n.schemaVersion, 1);
  for (const k of ['habits', 'logs', 'abstain', 'notes']) assert.deepEqual(n[k], old[k], `${k} без изменений`);
  assert.deepEqual(n.settings, { ...defaultSettings(), ...old.settings, qada: { ...defaultSettings().qada, ...old.settings.qada } });
  assert.deepEqual(migrate(m), m, 'идемпотентно');
  assert.equal(migrate(m), m, 'актуальная версия не копируется');
  console.log('✓ данные без schemaVersion → v1 без потерь, миграция идемпотентна');
}

// 2. Неизвестный k и неизвестные поля события переживают слияние в обе стороны
{
  const base = typicalData();
  const a = { ...base, logs: { namaz: { '2026-11-11': { ev: [{ id: 'e1', ts: 10, d: 1, s: 'p-fajr', k: 'jamaat', x: 1, mosque: 'Минор' }], t: 10, v: 1 } } } };
  const b = { ...base, logs: { namaz: { '2026-11-11': { ev: [{ id: 'e2', ts: 20, d: 1, s: 'p-dhuhr' }], t: 20, v: 1 } } } };
  for (const m of [merge(a, b), merge(b, a), merge(merge(a, b), b)]) {
    const ev = m.logs.namaz['2026-11-11'].ev;
    assert.equal(ev.length, 2);
    assert.deepEqual(ev.find((e) => e.id === 'e1'), { id: 'e1', ts: 10, d: 1, s: 'p-fajr', k: 'jamaat', x: 1, mosque: 'Минор' });
    assert.equal(m.logs.namaz['2026-11-11'].v, 2);
  }
  console.log('✓ неизвестный k и поля события переживают слияние в обе стороны');
}

// 3. Неизвестный раздел верхнего уровня и будущая версия схемы
{
  const base = typicalData();
  const future = { ...base, schemaVersion: 7, updatedAt: 100, fasts: { '2026-03-01': { type: 'ramadan' } }, habits: base.habits.map((h) => (h.id === 'namaz' ? { ...h, updatedAt: 100, ibadah: true, newField: [1] } : h)) };
  const oldDevice = { ...base, updatedAt: 50 };
  assert.deepEqual(normalize(future).fasts, future.fasts, 'normalize сохраняет раздел');
  assert.equal(normalize(future).schemaVersion, 7, 'будущая версия не понижается');
  for (const m of [merge(future, oldDevice), merge(oldDevice, future)]) {
    assert.deepEqual(m.fasts, future.fasts, 'раздел не потерян');
    assert.equal(m.schemaVersion, 7);
    assert.equal(m.habits.find((h) => h.id === 'namaz').newField[0], 1, 'неизвестные поля привычки сохраняются');
  }
  const newer = { ...oldDevice, updatedAt: 200, fasts: { '2026-03-02': { type: 'nafl' } } };
  assert.deepEqual(merge(future, newer).fasts, newer.fasts, 'при конфликте — более свежая сторона');
  console.log('✓ неизвестные разделы и будущая версия схемы сохраняются при слиянии');
}

// 4. Пустые и битые данные
{
  assert.equal(normalize(null).schemaVersion, SCHEMA_VERSION);
  assert.equal(normalize([]).habits.length, 0);
  assert.equal(merge({}, {}).schemaVersion, SCHEMA_VERSION);
  console.log('✓ пустые данные получают актуальную версию');
}
