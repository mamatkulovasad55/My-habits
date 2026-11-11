// Cron Worker: расход записей KV, обработка ошибок KV и Telegram, предупреждение на 800 записях.
import assert from 'node:assert/strict';
import { setNow, tashkent, memoryKV, fakeNet, runCron } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';

const worker = (await import('../worker/index.js')).default;

function makeEnv() {
  const KV = memoryKV();
  KV.map.set('owner', '777');
  return { KV, BOT_TOKEN: '1:T', DATA_TOKEN: 'gh', DATA_OWNER: 'me', APP_URL: 'https://me.github.io/My-habits/' };
}
const net = fakeNet();
net.remote = JSON.stringify(typicalData());
const reminders = () => net.tg.filter((c) => c.method === 'sendMessage');

// 1. Обычные сутки: cron каждую минуту, ничего не отмечено (максимум напоминаний с повторами)
{
  const env = makeEnv();
  let idlePuts = 0;
  for (let m = 0; m < 1440; m++) {
    setNow(tashkent(2026, 11, 11, 0, m));
    const before = env.KV.puts, sentBefore = reminders().length;
    await runCron(worker, env);
    if (reminders().length === sentBefore) idlePuts += env.KV.puts - before;
  }
  const texts = reminders().map((c) => c.body.text);
  assert.equal(idlePuts, 0, 'запуски без отправки не пишут в KV');
  assert.equal(new Set(texts).size, texts.length, 'нет дублей');
  assert.ok(env.KV.puts <= 60, `записей за сутки: ${env.KV.puts}`);
  const st = JSON.parse(env.KV.map.get('state'));
  assert.equal(st.kv.n, env.KV.puts, 'счётчик совпадает с реальными записями');
  console.log(`✓ сутки: ${texts.length} напоминаний, ${env.KV.puts} записей KV, 0 записей в «пустых» запусках`);
}

// 2. Падающий put: напоминание всё равно уходит, cron не падает
{
  net.tg.length = 0;
  const env = makeEnv();
  env.KV.failPut = true;
  setNow(tashkent(2026, 11, 11, 7, 15)); // зарядка 07:15
  await runCron(worker, env);
  assert.ok(reminders().some((c) => c.body.text.includes('Зарядка')), 'отправлено, несмотря на ошибку KV');
  console.log('✓ ошибка записи KV не мешает отправке');
}

// 3. Падающий get: owner из кэша экземпляра, напоминания уходят
{
  net.tg.length = 0;
  const env = makeEnv();
  env.KV.failGet = true;
  setNow(tashkent(2026, 11, 11, 7, 30)); // вода, стакан 1
  await runCron(worker, env);
  assert.ok(reminders().some((c) => c.body.text.includes('Стакан 1')));
  assert.equal(env.KV.puts, 0, 'не затираем состояние, которое не смогли прочитать');
  console.log('✓ ошибка чтения KV не мешает отправке и не затирает состояние');
}

// 4. Telegram ответил ok:false → не помечаем, повтор в следующую минуту
{
  net.tg.length = 0;
  const env = makeEnv();
  net.tgFail = 1;
  setNow(tashkent(2026, 11, 11, 9, 0));
  await runCron(worker, env);
  assert.equal(reminders().length, 0);
  assert.equal(env.KV.puts, 0, 'ничего не отправлено — ничего не пишем');
  setNow(tashkent(2026, 11, 11, 9, 1));
  await runCron(worker, env);
  assert.equal(reminders().filter((c) => c.body.text.includes('Стакан 2')).length, 1, 'дошло со второй попытки');
  setNow(tashkent(2026, 11, 11, 9, 2));
  await runCron(worker, env);
  assert.equal(reminders().filter((c) => c.body.text.includes('Стакан 2')).length, 1, 'без дублей');
  console.log('✓ отказ Telegram: напоминание не теряется, повтор без дублей');
}

// 5. Предупреждение на 800 записях — ровно одно
{
  net.tg.length = 0;
  const env = makeEnv();
  const utc = new Date(tashkent(2026, 11, 11, 12, 30)).toISOString().slice(0, 10);
  env.KV.map.set('state', JSON.stringify({ day: '2026-11-11', sent: [], prev: [], kv: { d: utc, n: 799, warned: false } }));
  setNow(tashkent(2026, 11, 11, 12, 30));
  await runCron(worker, env);
  setNow(tashkent(2026, 11, 11, 14, 30));
  await runCron(worker, env);
  const warns = reminders().filter((c) => c.body.text.startsWith('KV: 800/1000'));
  assert.equal(warns.length, 1);
  assert.equal(JSON.parse(env.KV.map.get('state')).kv.n, 801);
  console.log('✓ на 800 записях — одно предупреждение в бота');
}

// 6. Новые сутки UTC обнуляют счётчик; переход со старого ключа sent:Y-M-D без дублей
{
  net.tg.length = 0;
  const env = makeEnv();
  env.KV.map.set('state', JSON.stringify({ day: '2026-11-10', sent: [], prev: [], kv: { d: '2026-11-10', n: 900, warned: true } }));
  setNow(tashkent(2026, 11, 11, 7, 15));
  await runCron(worker, env);
  assert.equal(JSON.parse(env.KV.map.get('state')).kv.n, 1);
  const env2 = makeEnv();
  env2.KV.map.set('sent:2026-11-11', JSON.stringify(['2026-11-11:gym:r0:1']));
  await runCron(worker, env2);
  assert.ok(!reminders().slice(1).some((c) => c.body.text.includes('Зарядка')), 'старый ключ учтён');
  console.log('✓ сброс счётчика в новые сутки UTC, совместимость со старым ключом');
}
