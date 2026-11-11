// Профиль: новые поля по умолчанию, часовой пояс по городу, бот считает по выбранному поясу.
import assert from 'node:assert/strict';
import { setNow, memoryKV, fakeNet, runCron } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { normalize, defaultSettings } from '../js/store.js';
import { CITIES, cityTz, autoTz, tzLabel, prayerTimes, tzOffsetHours } from '../js/prayer.js';

// 1. Старые данные без новых полей (импорт старого JSON) → значения по умолчанию, остальное не тронуто
const old = typicalData();
delete old.settings.profile;
delete old.settings.tzAuto;
old.settings.juma = { enabled: false, time: '12:30', lead: 15 };
const n = normalize(JSON.parse(JSON.stringify(old)));
assert.equal(n.settings.profile.niyyah, '');
assert.equal(n.settings.tzAuto, true);
assert.equal(n.settings.tz, 'Asia/Tashkent');
assert.deepEqual(n.settings.juma, old.settings.juma);
assert.deepEqual(n.settings.prayer, old.settings.prayer);
const withNiyyah = normalize({ ...old, settings: { ...old.settings, profile: { niyyah: 'Ради Аллаха' } } });
assert.equal(withNiyyah.settings.profile.niyyah, 'Ради Аллаха');
console.log('✓ ниййа и режим пояса подставляются по умолчанию, старые ключи не меняются');

// 2. Пояс по городу
const st = (city, extra = {}) => ({ ...defaultSettings(), prayer: { ...defaultSettings().prayer, city }, ...extra });
assert.ok(CITIES.every((c) => typeof c[3] === 'string' && c[3].includes('/')), 'у каждого города есть пояс');
assert.equal(cityTz(st('Ташкент')), 'Asia/Tashkent');
assert.equal(cityTz(st('Самарканд')), 'Asia/Tashkent');
assert.equal(cityTz(st('Стамбул')), 'Europe/Istanbul');
assert.equal(cityTz(st('Свои координаты'), 'Asia/Dubai'), 'Asia/Dubai');
assert.equal(autoTz(st('Стамбул')), 'Europe/Istanbul');
assert.equal(autoTz(st('Стамбул', { tzAuto: false, tz: 'Asia/Tashkent' })), null, 'ручной режим не перезаписывается');
assert.equal(tzLabel('Asia/Tashkent'), 'UTC+5');
assert.equal(tzLabel('Europe/Istanbul'), 'UTC+3');
assert.equal(tzLabel('Asia/Kolkata'), 'UTC+5:30');
console.log('✓ пояс по городу: Ташкент → Asia/Tashkent, Стамбул → Europe/Istanbul, свои координаты → устройство');

// 3. Аср для Ташкента: ханафитский по умолчанию, формула не менялась (11.11.2026 — 15:26 без поправок)
const p = defaultSettings().prayer;
assert.equal(p.asr, 'hanafi');
const tash = prayerTimes(2026, 11, 11, p, 5);
const shafi = prayerTimes(2026, 11, 11, { ...p, asr: 'shafi' }, 5);
assert.equal(tash.asr, 15 * 60 + 26);
assert.ok(shafi.asr < tash.asr, 'шафиитский Аср раньше');
console.log(`✓ Аср (Ташкент, ханафи): ${Math.floor(tash.asr / 60)}:${String(tash.asr % 60).padStart(2, '0')}`);

// 4. Бот: напоминание о Зухре по поясу из настроек (Стамбул), затем снова Ташкент
const worker = (await import('../worker/index.js')).default;
const net = fakeNet();

async function zuhrAt(city) {
  const data = typicalData();
  const c = CITIES.find(([x]) => x === city);
  data.settings.prayer = { ...data.settings.prayer, city: c[0], lat: c[1], lon: c[2] };
  data.settings.tz = cityTz(data.settings);
  net.remote = JSON.stringify(data);
  net.tg.length = 0;
  const KV = memoryKV();
  KV.map.set('owner', '777');
  const env = { KV, BOT_TOKEN: '1:T', DATA_TOKEN: 'gh', DATA_OWNER: 'me', APP_URL: 'https://x/' };
  // 11.11.2026, с 06:00 до 12:00 UTC
  for (let m = 6 * 60; m < 12 * 60; m++) {
    setNow(Date.UTC(2026, 10, 11, 0, m));
    const before = net.tg.length;
    await runCron(worker, env);
    if (net.tg.slice(before).some((x) => /Зухр/.test(x.body.text || ''))) return { utc: m, data };
  }
  return { utc: null, data };
}

for (const city of ['Стамбул', 'Ташкент']) {
  const { utc, data } = await zuhrAt(city);
  const off = tzOffsetHours(data.settings.tz, new Date(Date.UTC(2026, 10, 11, 12)));
  const expect = prayerTimes(2026, 11, 11, data.settings.prayer, off).dhuhr - off * 60; // UTC-минуты
  assert.ok(utc != null, `${city}: напоминание о Зухре пришло`);
  assert.ok(Math.abs(utc - expect) <= 1, `${city}: Зухр в ${utc} UTC-мин, ожидалось ${expect}`);
  const local = utc + off * 60;
  console.log(`✓ ${city} (${data.settings.tz}): напоминание о Зухре в ${Math.floor(local / 60)}:${String(local % 60).padStart(2, '0')} по местному времени`);
}

// 5. Экспорт → «Удалить все данные» → импорт возвращает привычки, воздержания и ниййю
{
  const { merge, prepareImport } = await import('../js/store.js');
  const backup = normalize(typicalData());
  backup.settings.profile = { niyyah: 'Ради Аллаха' };
  backup.logs.gym = { '2026-11-10': { v: 1, t: 1, ev: [{ id: 'g1', ts: 1, d: 1 }] } };
  const wiped = JSON.parse(JSON.stringify(backup));
  for (const x of [...wiped.habits, ...wiped.abstain]) {
    for (const k of Object.keys(x)) if (!['id', 'createdAt'].includes(k)) delete x[k];
    Object.assign(x, { deleted: true, updatedAt: Date.UTC(2026, 10, 11) });
  }
  wiped.logs = {};
  const back = merge(wiped, prepareImport(wiped, JSON.parse(JSON.stringify(backup)), Date.UTC(2026, 10, 11, 1)));
  assert.equal(back.habits.filter((h) => !h.deleted).length, backup.habits.length);
  assert.equal(back.abstain.filter((a) => !a.deleted).length, backup.abstain.length);
  assert.equal(back.logs.gym['2026-11-10'].v, 1);
  assert.equal(back.settings.profile.niyyah, 'Ради Аллаха');
  // и сервер со «надгробиями» не перебивает восстановленное
  const synced = merge(wiped, back);
  assert.equal(synced.habits.filter((h) => !h.deleted).length, backup.habits.length);
  console.log('✓ экспорт → удалить всё → импорт: привычки, история и ниййа вернулись');
}
