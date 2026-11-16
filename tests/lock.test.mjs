// Код раздела «Воздержание»: сервер хранит только хеш, лимит попыток на сервере, сброс через бота.
import assert from 'node:assert/strict';
import { setNow, memoryKV, fakeNet, runCron, tashkent, memoryDO } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { LOCK_KEY, afterFail, retryIn, LockStore, makeRecord } from '../worker/lock.js';

const worker = (await import('../worker/index.js')).default;
const net = fakeNet();
const BOT = '1:T';
const enc = new TextEncoder();
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(data)));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
async function initData(id, now) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id }) });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  p.set('hash', hex(await hmac(await hmac('WebAppData', BOT), check)));
  return p.toString();
}

// перехват логов: код не должен туда попасть
const logs = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => (logs.push(a.map(String).join(' ')), k === 'log' ? orig(...a) : undefined);
}

let T = tashkent(2026, 11, 16, 12, 0);
setNow(T);
const KV = memoryKV();
KV.map.set('owner', '7');
const env = { KV, BOT_TOKEN: BOT, DATA_TOKEN: 'gh', DATA_OWNER: 'me', PUSH_KEY: 'k', APP_URL: 'https://x/' };
env.LOCK = memoryDO(LockStore, env);
const stored = () => env.LOCK.get('lock').storage.map.get('rec');
const data = typicalData();
net.remote = JSON.stringify(data);
const OWNER = await initData(7, T);
const STRANGER = await initData(99, T);

async function call(path, body = {}, who = OWNER) {
  const r = await worker.fetch(new Request(`https://w${path}`, { method: 'POST', headers: { 'X-Init-Data': who }, body: JSON.stringify(body) }), env);
  return { status: r.status, ...(await r.json()) };
}
async function hook(update) {
  const { webhookSecret } = await import('../worker/telegram.js');
  return worker.fetch(new Request('https://w/tg', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(BOT) }, body: JSON.stringify(update) }), env);
}

// 1. Задать код
assert.deepEqual(await call('/api/lock/status'), { status: 200, hasCode: false, retryIn: 0 });
assert.equal((await call('/api/lock/set', { code: '12a4' })).reason, 'invalid', 'только 4 цифры');
assert.equal((await call('/api/lock/set', { code: '12345' })).reason, 'invalid');
assert.equal((await call('/api/lock/set', { code: '2580' })).ok, true);
assert.equal((await call('/api/lock/status')).hasCode, true);
const rec = stored();
assert.ok(rec.hash && rec.salt && !JSON.stringify(rec).includes('2580'), 'в хранилище только хеш');
assert.equal(KV.map.get(LOCK_KEY), undefined, 'в KV код больше не пишется');
assert.equal((await call('/api/lock/set', { code: '1111' })).reason, 'wrong', 'смена — только с текущим кодом');
assert.equal((await call('/api/lock/set', { code: '1111', current: '2580' })).ok, true);
assert.equal((await call('/api/lock/set', { code: '2580', current: '1111' })).ok, true);
{
  const { makeRecord, checkCode } = await import('../worker/lock.js');
  const old = { ...(await makeRecord('5555', BOT)), iter: 20000 };
  const { hashCode } = await import('../worker/lock.js');
  old.hash = await hashCode('5555', old.salt, BOT, 1000);
  old.iter = 1000; // запись со старым числом итераций по-прежнему проверяется
  assert.equal((await checkCode(old, '5555', BOT, 0)).ok, true);
}
console.log('✓ код: только 4 цифры, в KV — хеш с солью, смена — с текущим кодом, число итераций — из записи');

// 2. Чужой аккаунт
assert.equal((await call('/api/lock/verify', { code: '2580' }, STRANGER)).code, 'foreign');
assert.equal((await call('/api/lock/clear', {}, STRANGER)).status, 403);
console.log('✓ чужой аккаунт: отказ');

// 3. Ошибки и паузы
assert.equal((await call('/api/lock/verify', { code: '2580' })).ok, true);
for (let i = 1; i <= 4; i++) {
  const r = await call('/api/lock/verify', { code: '0000' });
  assert.equal(r.reason, 'wrong');
  assert.equal(r.status, 200, 'без HTTP-ошибки (не шумит в консоли)');
  assert.equal(r.retryIn, 0, `ошибка ${i} — без паузы`);
}
let r = await call('/api/lock/verify', { code: '0000' });
assert.equal(r.retryIn, 30, '5-я ошибка → 30 с');
r = await call('/api/lock/verify', { code: '2580' });
assert.equal(r.reason, 'pause', 'во время паузы даже верный код не проверяется');
assert.equal(r.ok, false);
// «перезапуск мини-аппа» — новый запрос статуса видит ту же паузу (она на сервере)
T += 10e3;
setNow(T);
assert.equal((await call('/api/lock/status')).retryIn, 20);
const steps = [];
for (let i = 0; i < 4; i++) {
  T += 16 * 60e3;
  setNow(T);
  steps.push((await call('/api/lock/verify', { code: '0000' })).retryIn);
}
assert.deepEqual(steps, [60, 300, 900, 900], 'затем 1, 5, 15 мин');
T += 16 * 60e3;
setNow(T);
assert.equal((await call('/api/lock/verify', { code: '2580' })).ok, true, 'после паузы верный код');
assert.equal(stored().fails, 0, 'счётчик сброшен');
assert.equal(afterFail({ fails: 3 }, 0).until, 0);
assert.equal(retryIn(afterFail({ fails: 4 }, 0), 0), 30);
console.log('✓ ошибки: 4 без паузы, 5-я → 30 с, затем 1/5/15 мин; пауза на сервере; верный код сбрасывает счётчик');

// 4. «Забыл код»: бот присылает кнопку, сброс только владельцем и только свежим ключом
net.tg.length = 0;
r = await call('/api/lock/forgot');
assert.equal(r.sent, true);
const msg = net.tg.find((x) => x.method === 'sendMessage');
const cb = msg.body.reply_markup.inline_keyboard[0][0].callback_data;
assert.match(cb, /^lockreset:\w+$/);
assert.equal((await call('/api/lock/forgot')).sent, false, 'не чаще раза в минуту');
await hook({ callback_query: { id: 'q1', from: { id: 99 }, data: cb, message: { chat: { id: 99 }, message_id: 1 } } });
assert.equal((await call('/api/lock/status')).hasCode, true, 'чужой пользователь не сбрасывает');
await hook({ callback_query: { id: 'q2', from: { id: 7 }, data: 'lockreset:wrongnonce', message: { chat: { id: 7 }, message_id: 1 } } });
assert.equal((await call('/api/lock/status')).hasCode, true, 'неверный ключ не сбрасывает');
await hook({ callback_query: { id: 'q3', from: { id: 7 }, data: cb, message: { chat: { id: 7 }, message_id: 1 } } });
assert.equal((await call('/api/lock/status')).hasCode, false, 'сброшено — и сразу видно трекеру (тот же объект, без кэша)');
assert.ok(net.tg.some((x) => x.method === 'answerCallbackQuery' && x.body.text === 'Код сброшен'));
assert.equal((await call('/api/lock/set', { code: '4321' })).ok, true, 'новый код без старого');
await hook({ callback_query: { id: 'q4', from: { id: 7 }, data: cb, message: { chat: { id: 7 }, message_id: 1 } } });
assert.equal((await call('/api/lock/status')).hasCode, true, 'повторное нажатие старой кнопки не сбрасывает');
// старая кнопка (истёк срок)
T += 70e3;
setNow(T);
await call('/api/lock/forgot');
const cb2 = net.tg.filter((x) => x.method === 'sendMessage').pop().body.reply_markup.inline_keyboard[0][0].callback_data;
T += 16 * 60e3;
setNow(T);
await hook({ callback_query: { id: 'q5', from: { id: 7 }, data: cb2 } });
assert.equal((await call('/api/lock/status')).hasCode, true, 'просроченная кнопка не сбрасывает');
assert.deepEqual(JSON.parse(net.remote).abstain, data.abstain, 'данные воздержания на месте');
console.log('✓ «Забыл код»: кнопка в боте, сброс только владельцем, свежим и одноразовым ключом; данные на месте');

// 5. Выключение защиты стирает код
assert.equal((await call('/api/lock/clear')).ok, true);
assert.equal((await call('/api/lock/status')).hasCode, false);
console.log('✓ выключение защиты: код удалён с сервера');

// 6. Нейтральный чек-ин и автобэкап
async function cronAt(d, privacy) {
  const x = typicalData();
  x.settings.privacy = { enabled: privacy, relock: 'now' };
  x.settings.checkin = { enabled: true, time: '21:30' };
  net.remote = JSON.stringify(x);
  net.tg.length = 0;
  const env2 = { ...env, KV: memoryKV() };
  env2.KV.map.set('owner', '7');
  for (let m = 21 * 60; m < 21 * 60 + 35; m++) {
    setNow(tashkent(2026, 11, d, 0, m));
    await runCron(worker, env2);
  }
  return net.tg;
}
let sent = await cronAt(15, false); // воскресенье
const textOf = (s) => s.filter((x) => x.method === 'sendMessage').map((x) => x.body.text).join('\n');
assert.match(textOf(sent), /отметь чистый день: Без сигарет/);
assert.ok(sent.some((x) => x.method === 'sendDocument'), 'без защиты автобэкап уходит');
sent = await cronAt(15, true);
assert.doesNotMatch(textOf(sent), /Без сигарет/, 'при защите — без названия');
assert.match(textOf(sent), /отметь день в приложении/);
assert.ok(!sent.some((x) => x.method === 'sendDocument'), 'при защите автобэкап не отправляется');
console.log('✓ бот: при защите чек-ин без названий, автобэкап не отправляется; без защиты — как раньше');

// 7. Код нигде в открытом виде
const all = [...logs, net.remote, ...[...KV.map.values()], JSON.stringify([...env.LOCK.get('lock').storage.map.values()])].join('\n');
for (const code of ['2580', '1111', '4321']) assert.ok(!all.includes(`"${code}"`) && !logs.some((l) => l.includes(code)), `код ${code} не утёк`);
console.log('✓ код не попадает в логи, data.json и KV');

// 8. Перенос из KV: код, заданный в прошлой версии, продолжает работать
{
  const KV2 = memoryKV();
  KV2.map.set('owner', '7');
  const old = await makeRecord('7777', BOT);
  KV2.map.set(LOCK_KEY, JSON.stringify({ ...old, fails: 2 }));
  const env2 = { ...env, KV: KV2 };
  env2.LOCK = memoryDO(LockStore, env2);
  const c2 = async (path, body = {}) => (await worker.fetch(new Request(`https://w${path}`, { method: 'POST', headers: { 'X-Init-Data': OWNER }, body: JSON.stringify(body) }), env2)).json();
  assert.equal((await c2('/api/lock/status')).hasCode, true);
  assert.equal((await c2('/api/lock/verify', { code: '7777' })).ok, true, 'старый код подходит');
  KV2.map.set(LOCK_KEY, JSON.stringify(await makeRecord('0000', BOT))); // KV больше не читается
  assert.equal((await c2('/api/lock/verify', { code: '7777' })).ok, true, 'перенос — один раз');
  console.log('✓ перенос из KV: код прошлой версии работает, перенос разовый');
}

// 9. Параллельные попытки не обходят счётчик
{
  await call('/api/lock/set', { code: '2580' }).catch(() => {});
  T += 30 * 60e3;
  setNow(T);
  const st0 = await call('/api/lock/status');
  if (!st0.hasCode) await call('/api/lock/set', { code: '2580' });
  assert.equal(stored().fails || 0, 0);
  const res = await Promise.all(Array.from({ length: 10 }, () => call('/api/lock/verify', { code: '0000' })));
  // строго по очереди: 5 неверных (5-я включила паузу), остальные 5 — уже в паузе, без проверки кода
  assert.equal(res.filter((x) => x.reason === 'wrong').length, 5);
  assert.equal(res.filter((x) => x.reason === 'pause').length, 5);
  assert.equal(stored().fails, 5, 'ни одна попытка не потерялась');
  const fails = 5, before = 0;
  console.log(`✓ 10 параллельных неверных попыток: ${fails - before} ошибок по очереди, остальные — пауза`);
}

// 10. Бот не смог отправить «Забыл код» — повторный запрос не упирается в лимит минуты
{
  T += 30 * 60e3;
  setNow(T);
  await call('/api/lock/verify', { code: '2580' });
  net.tgFail = 1;
  const r1 = await call('/api/lock/forgot');
  assert.equal(r1.ok, false);
  const r2 = await call('/api/lock/forgot');
  assert.equal(r2.sent, true, 'после сбоя отправки можно сразу повторить');
  assert.equal(r2.nonce, undefined, 'ключ сброса клиенту не отдаётся');
  console.log('✓ сбой отправки «Забыл код» не расходует лимит; ключ клиенту не отдаётся');
}
