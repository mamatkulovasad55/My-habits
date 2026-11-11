// Намаз нельзя отметить до наступления его времени.
import assert from 'node:assert/strict';
import { setNow } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { replaceData, findHabit } from '../js/store.js';
import { stagesForDay, prayerNotStarted } from '../js/schedule.js';

const d = typicalData();
d.settings.juma = { enabled: true, time: '13:00', lead: 45 };
replaceData(d);
const h = findHabit('namaz');
const wed = new Date(2026, 10, 11);
const fri = new Date(2026, 10, 13);
const st = (day, id) => stagesForDay(h, day).find((s) => s.id === id);
const at = (day, hh, mm = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
setNow(at(wed, 12).getTime());

assert.ok(prayerNotStarted(wed, st(wed, 'p-fajr'), at(wed, 1, 30)) != null, 'Фаджр в 01:30 — рано');
assert.equal(prayerNotStarted(wed, st(wed, 'p-fajr'), at(wed, 6)), null, 'Фаджр в 06:00 — можно');
assert.ok(prayerNotStarted(wed, st(wed, 'p-vitr'), at(wed, 18)) != null, 'Витр до Иши — рано');
assert.equal(prayerNotStarted(wed, st(wed, 'p-vitr'), at(wed, 19)), null, 'Витр после Иши — можно');
const juma = st(fri, 'p-dhuhr');
assert.ok(juma.juma);
assert.equal(prayerNotStarted(fri, juma, at(fri, 12, 30)), null, 'Джума/Зухр в 12:30 — время Зухра уже наступило');
assert.ok(prayerNotStarted(fri, juma, at(fri, 11, 0)) != null, 'в 11:00 — рано');
assert.equal(prayerNotStarted(wed, st(wed, 'p-isha'), at(new Date(2026, 10, 12), 1)), null, 'вчерашняя Иша после полуночи — можно');
assert.ok(prayerNotStarted(fri, st(fri, 'p-fajr'), at(wed, 12)) != null, 'будущий день — рано');
assert.equal(prayerNotStarted(wed, { id: 'w', time: { mode: 'fixed', at: '23:00' } }, at(wed, 1)), null, 'не намаз — без ограничений');
console.log('✓ ранняя отметка: Фаджр, Витр, Джума, будущий день, прошлый день, не-намаз');
