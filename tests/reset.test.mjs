// «Удалить все данные»: журналы и заметки не возвращаются с сервера и со второго устройства, импорт бэкапа их возвращает.
import assert from 'node:assert/strict';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { normalize, merge, prepareImport, replaceData, getData, resetAll } from '../js/store.js';

const T0 = Date.UTC(2026, 10, 10, 12);
const RESET = Date.UTC(2026, 10, 11, 12);
const LATER = Date.UTC(2026, 10, 11, 13);

function full() {
  const d = normalize(typicalData());
  d.settings.profile = { niyyah: 'Ради Аллаха' };
  d.settings.updatedAt = T0;
  d.logs.gym = { '2026-11-10': { v: 1, t: T0, ev: [{ id: 'g1', ts: T0, d: 1 }] } };
  d.logs.__dhikr = { '2026-11-10': { v: 33, t: T0, ev: [{ id: 'z1', ts: T0, d: 33, n: 33, s: 'subhanallah', k: 'dhikr' }] } };
  d.logs.__qada = { '2026-11-10': { v: 2, t: T0, ev: [{ id: 'q1', ts: T0, d: 2, s: 'fajr', k: 'qada' }] } };
  d.logs.water = { '2026-11-09': { v: 3, t: T0 } }; // старая запись без событий
  d.notes = { '2026-11-10': { text: 'заметка', t: T0 } };
  return d;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const live = (d) => d.habits.filter((h) => !h.deleted).length;

// 1. Сброс на устройстве
const server = full();
replaceData(clone(server));
setNow(RESET);
resetAll({ fajr: 7 }, RESET);
const wiped = clone(getData());
assert.equal(live(wiped), 0);
assert.deepEqual(wiped.logs, {});
assert.deepEqual(wiped.notes, {});
assert.equal(wiped.settings.profile.niyyah, '');
assert.equal(wiped.settings.qada.old.fajr, 7, 'остаток старого долга сохранён числом');
assert.equal(wiped.settings.prayer.city, 'Ташкент', 'настройки остались');
assert.equal(wiped.resetAt, RESET);

// 2. Сервер (у него ещё всё есть) не возвращает удалённое
const afterSync = merge(clone(server), wiped);
assert.equal(live(afterSync), 0);
assert.deepEqual(afterSync.logs, {}, 'журналы, включая зикры и каза, не вернулись');
assert.deepEqual(afterSync.notes, {});
assert.equal(afterSync.settings.profile.niyyah, '');
assert.equal(afterSync.resetAt, RESET);
// порядок сторон не важен, второе устройство со старыми данными тоже не возвращает
assert.deepEqual(merge(wiped, clone(server)).logs, {});
console.log('✓ сброс: журналы, зикры, каза и заметки не возвращаются при слиянии');

// 3. Новые отметки после сброса живут
const fresh = clone(afterSync);
fresh.logs.__dhikr = { '2026-11-11': { v: 10, t: LATER, ev: [{ id: 'z2', ts: LATER, d: 10, n: 10, s: 'subhanallah', k: 'dhikr' }] } };
fresh.notes['2026-11-11'] = { text: 'новая', t: LATER };
const m3 = merge(clone(server), fresh);
assert.equal(m3.logs.__dhikr['2026-11-11'].v, 10);
assert.equal(m3.logs.__dhikr['2026-11-10'], undefined);
assert.equal(m3.notes['2026-11-11'].text, 'новая');
console.log('✓ отметки после сброса сохраняются');

// 4. Импорт бэкапа после сброса возвращает всё, и сервер это не отменяет
const restored = merge(wiped, prepareImport(wiped, clone(server), LATER));
assert.equal(live(restored), server.habits.length);
assert.equal(restored.logs.gym['2026-11-10'].v, 1);
assert.equal(restored.logs.__dhikr['2026-11-10'].v, 33);
assert.equal(restored.logs.__qada['2026-11-10'].v, 2);
assert.equal(restored.logs.water['2026-11-09'].v, 3, 'старая запись без событий');
assert.equal(restored.notes['2026-11-10'].text, 'заметка');
assert.equal(restored.settings.profile.niyyah, 'Ради Аллаха');
const again = merge(afterSync, restored); // сервер уже после сброса
assert.equal(again.logs.__dhikr['2026-11-10'].v, 33);
assert.equal(live(again), server.habits.length);
// второе устройство со старыми копиями тех же событий (без пометки r) не «убивает» восстановленные
const other = merge(clone(server), again);
assert.equal(other.logs.gym['2026-11-10'].v, 1);
assert.equal(merge(again, clone(server)).logs.gym['2026-11-10'].v, 1);
console.log('✓ импорт после сброса: привычки, журналы, зикры, заметки и ниййа вернулись и не пропадают при синхронизации');

// 5. Без сброса слияние не изменилось
const plain = merge(clone(server), clone(server));
assert.equal(plain.resetAt, 0);
assert.deepEqual(plain.logs, server.logs);
console.log('✓ без сброса слияние работает как раньше');
