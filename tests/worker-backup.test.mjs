// Еженедельный бэкап data.json в бота и кнопка «Прислать бэкап».
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setNow, tashkent, memoryKV, fakeNet, runCron } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';

const worker = (await import('../worker/index.js')).default;
const net = fakeNet();
const data = typicalData();
data.logs = { namaz: { '2026-11-15': { ev: [{ id: 'a', ts: 1, d: 1, s: 'p-fajr' }, { id: 'b', ts: 2, d: 1, s: 'p-dhuhr' }], t: 2, v: 2 } }, gym: { '2026-11-01': { v: 1, t: 1 } } };
net.remote = JSON.stringify(data);
const KV = memoryKV();
KV.map.set('owner', '777');
const env = { KV, BOT_TOKEN: '1:T', DATA_TOKEN: 'gh', DATA_OWNER: 'me', APP_URL: 'https://x/' };
const docs = () => net.tg.filter((c) => c.method === 'sendDocument');

// суббота 21:00 и воскресенье 20:59 — бэкапа нет
setNow(tashkent(2026, 11, 14, 21, 0));
await runCron(worker, env);
setNow(tashkent(2026, 11, 15, 20, 59));
await runCron(worker, env);
assert.equal(docs().length, 0);

// воскресенье 21:00 — ровно один бэкап, дальше вечером без повторов
for (let m = 0; m < 30; m++) {
  setNow(tashkent(2026, 11, 15, 21, m));
  await runCron(worker, env);
}
assert.equal(docs().length, 1);
const d = docs()[0].body;
assert.equal(d.chat_id, '777');
assert.equal(d.caption, 'Бэкап · 15.11.2026 · 3 события');
assert.equal(d.document.name, 'data-2026-11-15.json');
assert.deepEqual(JSON.parse(await d.document.text()), data, 'в файле — data.json целиком');
assert.equal(JSON.parse(KV.map.get('state')).backup, '2026-11-15');
console.log('✓ воскресенье 21:00: один бэкап документом, подпись с датой и числом событий');

// следующее воскресенье — снова
setNow(tashkent(2026, 11, 22, 22, 10));
await runCron(worker, env);
assert.equal(docs().length, 2);
console.log('✓ через неделю — следующий бэкап (догоняет, если 21:00 пропущено)');

// кнопка в приложении: POST /api/backup только для владельца
const BOT = env.BOT_TOKEN;
function initData(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const call = (user) => worker.fetch(new Request('https://w.dev/api/backup', { method: 'POST', headers: { 'X-Init-Data': initData(user) }, body: '{}' }), env).then(async (r) => [r.status, await r.json()]);
let [s, j] = await call({ id: 999 });
assert.equal(s, 403);
const putsBefore = KV.puts;
[s, j] = await call({ id: 777 });
assert.equal(s, 200);
assert.equal(j.events, 3);
assert.equal(docs().length, 3);
assert.equal(KV.puts, putsBefore, 'ручной бэкап не тратит записи KV');
console.log('✓ /api/backup: только владелец, без записей в KV');
