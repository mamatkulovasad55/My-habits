// Слияние настроек по полям: метки settings._t, по каждому полю — более свежее изменение.
import assert from 'node:assert/strict';
import { setNow, memoryKV, fakeNet } from './helpers.mjs';
import { typicalData } from './fixtures.mjs';
import { normalize, merge, replaceData, getData, update, setSetting, resetAll, prepareImport, adoptServerStamps } from '../js/store.js';
import { maxStamp, unitsOf, mergeSettings, clampFuture, FUTURE_SLACK } from '../js/settings-merge.js';
import { stableStringify } from '../js/util.js';

const H = 3600e3;
const T0 = Date.UTC(2026, 10, 11, 8); // общее состояние
const clone = (x) => JSON.parse(JSON.stringify(x));
const S = (d) => d.settings;
const consistent = (s) => assert.equal(s.updatedAt, maxStamp(s._t), 'updatedAt = max(_t)');
const both = (a, b, opts) => {
  const ab = merge(clone(a), clone(b), opts);
  const ba = merge(clone(b), clone(a), opts);
  assert.equal(stableStringify(ab.settings), stableStringify(ba.settings), 'результат не зависит от порядка');
  return ab;
};

/** «Устройство»: свои данные в store, правка через настоящий update(). */
function edit(base, at, fn) {
  setNow(at);
  replaceData(clone(base));
  update((d) => fn(d));
  return clone(getData());
}

// Общая база: старый файл без меток, затем один раз нормализован
const legacy = typicalData();
legacy.settings.updatedAt = T0;
const base = normalize(clone(legacy));

// 3. Старые данные без _t: метки = updatedAt, значения по умолчанию — 0, ничья с умолчаниями не теряет значение
{
  assert.equal(S(base)._t.theme, T0);
  assert.equal(S(base)._t['quiet.from'], T0);
  consistent(S(base));
  const noTheme = clone(legacy);
  delete noTheme.settings.dhikr; // поле, которого не знала старая версия → умолчание с меткой 0
  const n = normalize(noTheme);
  assert.equal(S(n)._t['dhikr.target'], 0);
  const other = edit(base, T0 + 10, (d) => (d.settings.dhikr = { ...d.settings.dhikr, target: 100 }));
  assert.equal(S(both(n, other)).dhikr.target, 100, 'умолчание (0) не затирает настоящее значение');
  // после миграции v3 при updatedAt = 0: значение, отличное от умолчания, побеждает умолчание
  const v3 = normalize({ settings: { tartib: { enabled: true, asked: true }, updatedAt: 0 } });
  assert.equal(S(v3)._t['tartib.enabled'], 1);
  assert.equal(S(v3)._t['tartib.limit'], 0, 'не указано — умолчание');
  assert.equal(S(both(v3, normalize({}))).tartib.enabled, true);
  // значение без метки, равное умолчанию, ничего не сообщает
  assert.equal(S(normalize({ settings: { theme: 'system', updatedAt: 0 } }))._t.theme, 0);
  // идемпотентность
  assert.equal(stableStringify(normalize(clone(base))), stableStringify(base));
  console.log('✓ старые данные без меток: метка = updatedAt, умолчания = 0, нормализация идемпотентна');
}

// 1. Две офлайн-правки разных полей — обе сохраняются
{
  const A = edit(base, T0 + 1 * H, (d) => (d.settings.theme = 'dark'));
  const B = edit(base, T0 + 2 * H, (d) => (d.settings.quiet = { ...d.settings.quiet, from: '22:00' }));
  assert.equal(S(A)._t.theme, T0 + H);
  assert.equal(S(A)._t['quiet.from'], T0, 'нетронутое поле сохранило метку');
  const m = both(A, B);
  assert.equal(S(m).theme, 'dark');
  assert.equal(S(m).quiet.from, '22:00');
  consistent(S(m));
  console.log('✓ две офлайн-правки разных полей: обе сохранились, порядок слияния не важен');
}

// 2. Одно поле на двух устройствах — побеждает более свежее; при равных метках — одинаково в обоих порядках
{
  const A = edit(base, T0 + 3 * H, (d) => (d.settings.wakeWd = '05:30'));
  const B = edit(base, T0 + 1 * H, (d) => (d.settings.wakeWd = '06:00'));
  assert.equal(S(both(A, B)).wakeWd, '05:30');
  const A2 = edit(base, T0 + 5 * H, (d) => (d.settings.wakeWd = '05:00'));
  const B2 = edit(base, T0 + 5 * H, (d) => (d.settings.wakeWd = '07:00'));
  both(A2, B2); // проверка порядка внутри
  // группа: город и координаты не смешиваются
  const C = edit(base, T0 + 2 * H, (d) => (d.settings.prayer = { ...d.settings.prayer, city: 'Стамбул', lat: 41.0082, lon: 28.9784 }));
  const D = edit(base, T0 + 1 * H, (d) => (d.settings.prayer = { ...d.settings.prayer, lat: 41.3, lon: 69.3, city: 'Свои координаты' }));
  const p = S(both(C, D)).prayer;
  assert.deepEqual([p.city, p.lat, p.lon], ['Стамбул', 41.0082, 28.9784]);
  console.log('✓ одно поле: побеждает более свежее, ничья детерминирована, город с координатами — одной группой');
}

// 4. Переходный период: старая версия приложения правит настройки без меток полей
{
  const old = clone(base);
  old.settings.theme = 'light';
  old.settings.updatedAt = T0 + 4 * H; // старый код поднял только updatedAt; _t остался прежним
  const B = edit(base, T0 + 2 * H, (d) => (d.settings.wakeWe = '09:00'));
  const m = both(old, B);
  assert.equal(S(m).theme, 'light', 'правка старой версии не потерялась');
  assert.equal(S(m).wakeWe, S(base).wakeWe, 'как раньше: старая версия «позже» — её объект целиком');
  console.log('✓ переходный период: правка старой версии (updatedAt > max(_t)) не теряется');
}

// 5 + уточнение 1. Часы устройства спешат: сервер урезает метки, updatedAt = max(_t), правило переходного периода не срабатывает
{
  const now = T0 + 6 * H;
  const fast = edit(base, now + 2 * H, (d) => (d.settings.theme = 'dark')); // часы +2 ч
  const server = merge(clone(base), clone(fast), { serverNow: now });
  assert.equal(S(server)._t.theme, now, 'метка из будущего урезана до времени сервера');
  consistent(S(server));
  const again = normalize(clone(server));
  assert.equal(S(again)._t.theme, now, 'повторная нормализация не поднимает метки');
  assert.equal(S(again)._t.wakeWd, S(base)._t.wakeWd, 'нетронутые поля не получили свежую метку');
  consistent(S(again));
  // сама clampFuture
  const c = clampFuture({ theme: 'x', _t: { theme: now + FUTURE_SLACK + 1, a: 5 }, updatedAt: now + FUTURE_SLACK + 1 }, now);
  assert.equal(c.updatedAt, now);
  assert.equal(c._t.a, 5);
  // после принятия серверных меток вторая синхронизация ничего не меняет
  const adopted = adoptServerStamps(fast, server);
  const final = merge(adopted, clone(server));
  assert.equal(stableStringify(final), stableStringify(merge(clone(server), {})), 'клиент согласен с сервером — синхронизация не зациклится');
  console.log('✓ спешащие часы: сервер урезал метки, updatedAt = max(_t), повторная нормализация их не поднимает');
}

// 5б. То же через настоящий бот: второй запрос не пишет в GitHub
{
  const worker = (await import('../worker/index.js')).default;
  const net = fakeNet();
  const { verifyInitData } = await import('../worker/telegram.js');
  const env = { KV: memoryKV(), BOT_TOKEN: '1:T', DATA_TOKEN: 'gh', DATA_OWNER: 'me', PUSH_KEY: 'k', APP_URL: 'https://x/' };
  env.KV.map.set('owner', '7');
  // подпись initData, как у Telegram
  const enc = new TextEncoder();
  const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(data)));
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const now = T0 + 7 * H;
  setNow(now);
  const params = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 7 }) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  params.set('hash', hex(await hmac(await hmac('WebAppData', env.BOT_TOKEN), check)));
  assert.ok(await verifyInitData(params.toString(), env.BOT_TOKEN));
  const call = async (data) => {
    const r = await worker.fetch(new Request('https://w/api/sync', { method: 'POST', headers: { 'X-Init-Data': params.toString() }, body: JSON.stringify({ data }) }), env);
    return (await r.json()).data;
  };
  net.remote = JSON.stringify(base);
  const fast = edit(base, now + 2 * H, (d) => (d.settings.theme = 'dark'));
  setNow(now);
  const r1 = await call(fast);
  assert.equal(r1.settings.theme, 'dark');
  assert.equal(r1.settings._t.theme, now);
  consistent(r1.settings);
  const puts = net.ghPuts;
  const final = merge(adoptServerStamps(fast, r1), r1); // как в sync.js
  setNow(now + 60e3);
  await call(final);
  assert.equal(net.ghPuts, puts, 'вторая синхронизация ничего не пишет');
  console.log('✓ бот: метка урезана, вторая синхронизация не пишет в GitHub');
}

// 6. Монотонность: правка после получения «будущей» метки побеждает
{
  const future = edit(base, T0 + 30 * H, (d) => (d.settings.theme = 'dark')); // без сервера (офлайн)
  const later = edit(future, T0 + 8 * H, (d) => (d.settings.theme = 'light')); // часы этого устройства верные
  assert.equal(S(later)._t.theme, T0 + 30 * H + 1, 'метка поля не уменьшается');
  assert.equal(S(both(future, later)).theme, 'light');
  console.log('✓ монотонность: правка после «будущей» метки побеждает');
}

// 7 + уточнение 2. Сброс ставит свежие метки: старые настройки с сервера не возвращаются
{
  const serverOld = edit(base, T0 + 9 * H, (d) => {
    d.settings.profile = { niyyah: 'Ради Аллаха' };
    d.settings.theme = 'dark';
  });
  const other = edit(serverOld, T0 + 10 * H, (d) => (d.settings.wakeWd = '04:00')); // офлайн до сброса
  setNow(T0 + 11 * H);
  replaceData(clone(serverOld));
  resetAll(null, T0 + 11 * H);
  const wiped = clone(getData());
  assert.equal(S(wiped)._t.theme, T0 + 11 * H, 'все поля получили метку сброса');
  consistent(S(wiped));
  const m = both(both(serverOld, wiped), other);
  assert.equal(S(m).profile.niyyah, '', 'ниййа не вернулась');
  assert.equal(S(m).theme, 'dark', 'настройки устройства на месте');
  assert.equal(S(m).wakeWd, S(serverOld).wakeWd, 'офлайн-правка до сброса не перебила сброс');
  // импорт бэкапа после сброса возвращает настройки из файла
  const restored = merge(wiped, prepareImport(wiped, clone(serverOld), T0 + 12 * H));
  assert.equal(S(restored).profile.niyyah, 'Ради Аллаха');
  consistent(S(restored));
  assert.equal(S(merge(m, restored)).profile.niyyah, 'Ради Аллаха', 'и сервер это не отменяет');
  console.log('✓ сброс: свежие метки, ниййа и старые настройки не возвращаются; импорт после сброса — возвращает');
}

// 8 + уточнение 3. Удаление ключа тоже получает метку и переносится на другую сторону
{
  const A = edit(base, T0 + 13 * H, (d) => (d.settings.experimental = { beta: true }));
  assert.ok(S(A)._t['experimental.beta']);
  const B = edit(A, T0 + 14 * H, (d) => delete d.settings.experimental);
  assert.equal(S(B)._t['experimental.beta'], T0 + 14 * H, 'удаление получило метку');
  assert.equal(S(both(A, B)).experimental?.beta, undefined, 'ключ удалён и на другой стороне');
  const C = edit(B, T0 + 15 * H, (d) => (d.settings.experimental = { beta: false }));
  assert.equal(S(both(B, C)).experimental.beta, false, 'после удаления можно снова задать');
  console.log('✓ удаление ключа: метка ставится, удаление переносится при слиянии');
}

// 9. update() без реальных изменений не трогает метки, но выравнивает updatedAt
{
  setNow(T0 + 16 * H);
  replaceData(clone(base));
  const before = clone(S(getData())._t);
  update((d) => (d.settings.updatedAt = Date.now())); // как в app.js: «время правки» без правки
  setSetting('theme', S(base).theme); // то же значение
  assert.deepEqual(S(getData())._t, before);
  consistent(S(getData()));
  assert.equal(S(normalize(clone(getData())))._t.wakeWd, before.wakeWd, 'ложного «переходного периода» нет');
  console.log('✓ update() без изменений: метки не меняются, updatedAt = max(_t)');
}

// Единицы: атомарные блоки и группы
{
  const u = unitsOf(S(base));
  assert.ok(u.has('hijri.offsets') && u.has('dhikr.favorites') && u.has('prayer.city') && u.has('tz'));
  assert.ok(!u.has('prayer.lat') && !u.has('tzAuto') && !u.has('_t') && !u.has('updatedAt'));
  const ms = mergeSettings({ a: 1, _t: { a: 5 } }, { a: 2, _t: { a: 5 } });
  assert.equal(ms.a, 2, 'ничья: бо́льшая строка');
  console.log('✓ единицы слияния: массивы и блоки целиком, город и пояс — группами');
}
