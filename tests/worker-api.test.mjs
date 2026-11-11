import assert from 'node:assert';
import crypto from 'node:crypto';
// Mini App API и бот: подпись Telegram, привязка владельца, синхронизация, вебхук, напоминание.
const worker = (await import('../worker/index.js')).default;
const { webhookSecret } = await import('../worker/telegram.js');
const { defaultSettings } = await import('../js/store.js');

const BOT = '123456:TEST-token';
function initData(user, botToken = BOT, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAA', user: JSON.stringify(user), signature: 'xyz' });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const kv = new Map();
const env = { KV: { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v) },
  BOT_TOKEN: BOT, PUSH_KEY: 'фраза', DATA_TOKEN: 'gh', DATA_OWNER: 'me', APP_URL: 'https://me.github.io/My-habits/' };

let remote = null, sha = 0, puts = 0; const tgCalls = [];
globalThis.fetch = async (url, o = {}) => {
  url = String(url);
  if (url.startsWith('https://api.github.com/')) {
    if ((o.method || 'GET') === 'GET' && String(o.headers?.Accept).includes('raw')) return new Response(remote); if ((o.method || 'GET') === 'GET') return remote ? new Response(JSON.stringify({ sha: 's' + sha, content: Buffer.from(remote).toString('base64') })) : new Response('{}', { status: 404 });
    const b = JSON.parse(o.body); if (remote && b.sha !== 's' + sha) return new Response('{}', { status: 409 });
    remote = Buffer.from(b.content, 'base64').toString(); sha++; puts++; return new Response('{}', { status: 200 });
  }
  if (url.startsWith('https://api.telegram.org/')) { tgCalls.push({ method: url.split('/').pop(), body: JSON.parse(o.body) }); return new Response(JSON.stringify({ ok: true, result: { username: 'my_habits_bot' } })); }
  throw new Error('unexpected ' + url);
};
const call = (path, body, id) => worker.fetch(new Request('https://w.dev' + path, { method: 'POST', headers: id === undefined ? {} : { 'X-Init-Data': id }, body: JSON.stringify(body || {}) }), env).then(async (r) => [r.status, await r.json()]);
const me = { id: 777, first_name: 'A' }, stranger = { id: 999, first_name: 'B' };

let [s, j] = await call('/api/sync', { data: {} }); assert.equal(s, 401, 'no initData');
[s, j] = await call('/api/sync', { data: {} }, initData(me, 'other:token')); assert.equal(s, 401, 'bad signature');
[s, j] = await call('/api/sync', { data: {} }, initData(me, BOT, 1000)); assert.equal(s, 401, 'expired');
[s, j] = await call('/api/sync', { data: {} }, initData(me)); assert.equal(j.code, 'claim');
[s, j] = await call('/api/claim', { key: 'wrong' }, initData(me)); assert.equal(j.code, 'key');
[s, j] = await call('/api/claim', { key: 'фраза' }, initData(me)); assert.equal(s, 200);
[s, j] = await call('/api/claim', { key: 'фраза' }, initData(stranger)); assert.equal(j.code, 'foreign', 'second user cannot claim');
[s, j] = await call('/api/sync', { data: {} }, initData(stranger)); assert.equal(j.code, 'foreign');
console.log('✓ auth: signature, expiry, one-time owner claim, strangers blocked');

// existing remote data from the old app; empty Mini App must pull it, not overwrite
const S = { ...defaultSettings(), tz: 'Asia/Tashkent', wakeWd: '06:30', updatedAt: 50, quiet: { enabled: false } , checkin: { enabled: false, time: '21:30' } };
const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tashkent', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
remote = JSON.stringify({ settings: S, habits: [{ id: 'g', name: 'Зарядка', emoji: '💪', type: 'check', createdAt: 1, updatedAt: 5, schedule: { kind: 'daily' }, reminders: [{ mode: 'fixed', at: `${p.hour}:${p.minute}` }] }], logs: {} });
[s, j] = await call('/api/sync', { data: { habits: [], logs: {}, settings: defaultSettings() } }, initData(me));
assert.equal(s, 200); assert.equal(j.data.habits.length, 1); assert.equal(j.data.settings.wakeWd, '06:30', 'remote settings kept');
assert.equal(puts, 0, 'nothing to write');
// client adds a log → written
[s, j] = await call('/api/sync', { data: { ...j.data, logs: { g: { '2026-01-01': { ev: [{ id: 'x', ts: 1, d: 1 }], v: 1, t: 2 } } } } }, initData(me));
assert.equal(puts, 1); assert.equal(JSON.parse(remote).logs.g['2026-01-01'].v, 1);
console.log('✓ sync: pulls existing data without overwriting settings, writes new marks');

// webhook /start
let r = await worker.fetch(new Request('https://w.dev/tg', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'nope' }, body: '{}' }), env); assert.equal(r.status, 403);
r = await worker.fetch(new Request('https://w.dev/tg', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(BOT) }, body: JSON.stringify({ message: { chat: { id: 777, type: 'private' }, text: '/start' } }) }), env);
assert.equal(r.status, 200); assert.equal(tgCalls.at(-1).body.reply_markup.inline_keyboard[0][0].web_app.url, env.APP_URL);
const before = tgCalls.length;
await worker.fetch(new Request('https://w.dev/tg', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(BOT) }, body: JSON.stringify({ message: { chat: { id: 777, type: 'private' }, text: 'привет' } }) }), env);
assert.equal(tgCalls.length, before, 'bot stays silent on other messages');
const shaHex = crypto.createHash('sha256').update(BOT).digest('hex').slice(0, 40); assert.equal(await webhookSecret(BOT), shaHex, 'same secret as workflow');
console.log('✓ webhook: secret check, /start with Mini App button, silent otherwise');

// cron reminder → Telegram message
const waits = []; const ctx = { waitUntil: (x) => waits.push(x) };
await worker.scheduled({}, env, ctx); await Promise.all(waits);
const m = tgCalls.filter(c => c.method === 'sendMessage').at(-1);
assert.equal(m.body.chat_id, 777); assert.ok(m.body.text.includes('Зарядка')); console.log('  reminder:', JSON.stringify(m.body.text));
const n = tgCalls.length; waits.length = 0; await worker.scheduled({}, env, ctx); await Promise.all(waits);
assert.equal(tgCalls.length, n, 'no duplicates');
const [, info] = await worker.fetch(new Request('https://w.dev/api/info'), env).then(async r => [r.status, await r.json()]); assert.equal(info.bot, 'my_habits_bot');
console.log('✓ cron: reminder sent by bot to owner, deduplicated; /api/info returns bot username');
