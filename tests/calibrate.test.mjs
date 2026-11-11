// Сверка времени намаза: поправки по эталонам, сезонный разброс, влияние на логику и напоминания.
import assert from 'node:assert/strict';
import { setNow, tashkent, memoryKV, fakeNet, runCron } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { calibrationReport, applyCalibration, withRef, prayerSource, timesFor, CALIB_KEYS } from '../js/calibrate.js';
import { replaceData, findHabit } from '../js/store.js';
import { stagesForDay, stageStatus } from '../js/schedule.js';
const worker = (await import('../worker/index.js')).default;

const base = typicalData();
const shift = (t, d) => Object.fromEntries(CALIB_KEYS.map((k) => [k, t[k] + (d[k] || 0)]));
const S = base.settings;

// 1. Одна дата: эталон = база + сдвиги → после применения совпадает ±1
{
  const ref = shift(timesFor('2026-11-11', S), { fajr: -3, sunrise: 1, maghrib: 4, isha: 3 });
  let prayer = withRef(S.prayer, '2026-11-11', ref);
  const s1 = { ...S, prayer };
  assert.equal(prayerSource(s1).kind, 'formula');
  const before = calibrationReport(s1);
  assert.deepEqual(before.rows[0].items.map((x) => x.delta), [-3, 1, 0, 0, 4, 3]);
  prayer = applyCalibration(s1, '2026-11-11');
  const s2 = { ...S, prayer };
  assert.deepEqual({ ...prayer.adj }, { fajr: -3, sunrise: 1, dhuhr: 0, asr: 0, maghrib: 4, isha: 3 });
  const after = timesFor('2026-11-11', s2, prayer.adj);
  for (const k of CALIB_KEYS) assert.ok(Math.abs(after[k] - ref[k]) <= 1, `${k}: ${after[k]} vs ${ref[k]}`);
  assert.ok(calibrationReport(s2).rows[0].items.every((x) => x.delta === 0), 'после применения Δ = 0');
  assert.deepEqual(prayerSource(s2), { kind: 'calibrated', at: '2026-11-11' });
  const s3 = { ...S, prayer: { ...prayer, adj: { ...prayer.adj, asr: 1 } } };
  assert.equal(prayerSource(s3).kind, 'calibrated+manual');
  // повторное применение ничего не меняет
  assert.deepEqual(applyCalibration(s2, '2026-11-12').adj, prayer.adj);
  console.log('✓ одна дата: поправки −3/+1/+4/+3, после применения совпадение с эталоном, источник «сверено»');
}

// 2. Две даты с разными поправками: среднее и предупреждение о сезоне
{
  let prayer = withRef(S.prayer, '2026-11-11', shift(timesFor('2026-11-11', S), { fajr: -3, asr: 1, maghrib: 4 }));
  prayer = withRef(prayer, '2026-06-21', shift(timesFor('2026-06-21', S), { fajr: -2, asr: 5, maghrib: 4 }));
  prayer = withRef(prayer, '2026-11-11', shift(timesFor('2026-11-11', S), { fajr: -3, asr: 1, maghrib: 4 })); // замена той же даты
  const s = { ...S, prayer };
  assert.equal(prayer.calib.refs.length, 2);
  const { summary } = calibrationReport(s);
  assert.equal(summary.asr.adj, 3);
  assert.equal(summary.asr.spread, 4);
  assert.equal(summary.asr.seasonal, true);
  assert.equal(summary.fajr.adj, -3, 'среднее −2,5 округляется от нуля');
  assert.equal(summary.fajr.seasonal, false);
  assert.equal(summary.maghrib.adj, 4);
  assert.equal(summary.maghrib.seasonal, false);
  console.log('✓ две даты: среднее, разброс по Асру 4 мин → предупреждение о сезоне');
}

// 3. Поправки используются логикой «вовремя/каза» и напоминаниями Worker
{
  const d = typicalData();
  const ref = shift(timesFor('2026-11-11', d.settings), { sunrise: -10, maghrib: 6 });
  d.settings.prayer = applyCalibration({ ...d.settings, prayer: withRef(d.settings.prayer, '2026-11-11', ref) }, '2026-11-11');
  replaceData(d);
  const day = new Date(2026, 10, 11);
  const fajr = stagesForDay(findHabit('namaz'), day).find((s) => s.id === 'p-fajr');
  assert.equal(fajr.end, ref.sunrise, 'конец Фаджра — сверенный восход');
  const at = (m) => new Date(2026, 10, 11, 0, m);
  assert.equal(stageStatus(findHabit('namaz'), day, fajr, at(ref.sunrise - 1)), 'pending');
  assert.equal(stageStatus(findHabit('namaz'), day, fajr, at(ref.sunrise + 1)), 'missed', 'через минуту после сверенного восхода — уже каза');

  // Worker: напоминание о Магрибе в скорректированную минуту
  const net = fakeNet();
  net.remote = JSON.stringify(d);
  const KV = memoryKV();
  KV.map.set('owner', '777');
  const env = { KV, BOT_TOKEN: '1:T', DATA_TOKEN: 'gh', DATA_OWNER: 'me', APP_URL: 'https://x/' };
  let sentAt = null;
  for (let m = ref.maghrib - 10; m <= ref.maghrib + 2; m++) {
    setNow(tashkent(2026, 11, 11, 0, m));
    const n = net.tg.length;
    await runCron(worker, env);
    if (net.tg.slice(n).some((c) => c.body.text.includes('Магриб'))) sentAt = m;
  }
  assert.equal(sentAt, ref.maghrib, 'Worker: Магриб по сверенному времени');
  console.log('✓ сверенное время используется для каза (конец Фаджра) и напоминаний Worker');
}

