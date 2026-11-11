// Иша: основное напоминание, повтор через 2,5 часа и утренний перед Фаджром — каждое один раз.
import assert from 'node:assert/strict';
import { setNow, tashkent, memoryKV, fakeNet, runCron } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';

const worker = (await import('../worker/index.js')).default;
const net = fakeNet();

/** Прогнать cron поминутно с 11.11 12:00 до 12.11 12:00, вернуть напоминания про Ишу с временем. */
async function run(markIshaAt) {
  const data = typicalData();
  net.remote = JSON.stringify(data);
  net.tg.length = 0;
  const KV = memoryKV();
  KV.map.set('owner', '777');
  const env = { KV, BOT_TOKEN: '1:T', DATA_TOKEN: 'gh', DATA_OWNER: 'me', APP_URL: 'https://x/' };
  const out = [];
  for (let m = 12 * 60; m < 36 * 60; m++) {
    const ts = tashkent(2026, 11, 11, 0, m);
    if (markIshaAt != null && m === markIshaAt) {
      data.logs.namaz = { '2026-11-11': { ev: [{ id: 'i', ts, d: 1, s: 'p-isha' }, { id: 'v', ts, d: 1, s: 'p-vitr' }], t: ts, v: 2 } };
      net.remote = JSON.stringify(data);
    }
    setNow(ts);
    const n = net.tg.length;
    await runCron(worker, env);
    for (const c of net.tg.slice(n)) {
      const t = c.body.text || '';
      if (/Иша/.test(t)) out.push({ at: `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, text: t.split('\n')[0].replace(/<\/?b>/g, '') });
    }
  }
  return { out, puts: KV.puts };
}

// 1. Не отмечено вовсе
let { out, puts } = await run(null);
console.log(out.map((x) => `  ${x.at} ${x.text}`).join('\n'));
assert.equal(out.length, 3, 'три напоминания');
assert.match(out[0].text, /Иша и Витр · 18:26/);
assert.equal(out[1].at, '20:56', 'через 2,5 часа после начала');
assert.match(out[1].text, /Иша и Витр ещё не отмечены/);
assert.match(out[2].text, /^🌅 Иша и Витр ещё не отмечены/);
assert.ok(out[2].at >= '05:00' && out[2].at < '06:00', 'утром перед Фаджром');
assert.ok(puts < 70, `записей KV: ${puts}`);
console.log('✓ не отмечено: основное, через 2,5 часа и утром — по одному разу');

// 2. Отмечено в 19:30 → только основное
({ out } = await run(19 * 60 + 30));
assert.equal(out.length, 1);
console.log('✓ отмечено вечером — повторов нет');

// 3. Отмечено ночью в 01:00 (во вчерашний день) → без утреннего
({ out } = await run(25 * 60));
assert.equal(out.length, 2);
assert.ok(!out.some((x) => x.text.startsWith('🌅')));
console.log('✓ отмечено ночью — утреннего напоминания нет');
