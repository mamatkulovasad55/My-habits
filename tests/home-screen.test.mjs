// Иконка на экране «Домой»: обёртка над WebApp.checkHomeScreenStatus / addToHomeScreen (js/tg.js).
import assert from 'node:assert/strict';

const tg = await import('../js/tg.js');

/** Заглушка Telegram.WebApp: version — версия Bot API, status — ответ checkHomeScreenStatus (функция — своё поведение). */
function stub({ version = '8.0', status = 'missed', api = true } = {}) {
  const handlers = {};
  const w = {
    initData: 'x=1',
    isVersionAtLeast: (v) => Number(version) >= Number(v),
    onEvent: (e, fn) => ((handlers[e] = handlers[e] || new Set()).add(fn)),
    offEvent: (e, fn) => handlers[e]?.delete(fn),
    fire: (e) => [...(handlers[e] || [])].forEach((fn) => fn()),
    handlers,
    calls: 0,
  };
  if (api) {
    w.addToHomeScreen = () => w.calls++;
    w.checkHomeScreenStatus = typeof status === 'function' ? status : (cb) => setTimeout(() => cb(status), 5);
  }
  globalThis.window = { Telegram: { WebApp: w } };
  return w;
}

// 1. Каждый статус
for (const s of ['unsupported', 'unknown', 'added', 'missed']) {
  stub({ status: s });
  assert.equal(await tg.homeScreenStatus(), s, s);
}
stub({ status: 'что-то новое' });
assert.equal(await tg.homeScreenStatus(), 'unsupported', 'неизвестное значение');
console.log('✓ статусы: unsupported, unknown, added, missed; неизвестное значение → unsupported');

// 2. Нет API, старая версия, вне Telegram
stub({ api: false });
assert.equal(tg.homeScreenSupported(), false);
assert.equal(await tg.homeScreenStatus(), 'unsupported');
stub({ version: '7.10' });
assert.equal(tg.homeScreenSupported(), false, 'Bot API ниже 8.0');
assert.equal(await tg.homeScreenStatus(), 'unsupported');
globalThis.window = {};
assert.equal(await tg.homeScreenStatus(), 'unsupported', 'вне Telegram');
assert.equal(tg.addToHomeScreen(), false);
console.log('✓ нет API, Bot API < 8.0, вне Telegram → unsupported');

// 3. Исключение и молчание клиента
stub({ status: () => { throw new Error('boom'); } });
assert.equal(await tg.homeScreenStatus(), 'unsupported', 'исключение');
stub({ status: () => {} });
assert.equal(await tg.homeScreenStatus(50), 'unsupported', 'колбэк не пришёл');
console.log('✓ исключение в checkHomeScreenStatus или нет ответа → unsupported');

// 4. addToHomeScreen: вызов метода, событие homeScreenAdded → onAdded, подписки снимаются
{
  const w = stub();
  let added = 0;
  let failed = 0;
  assert.equal(tg.addToHomeScreen({ onAdded: () => added++, onFailed: () => failed++ }), true);
  assert.equal(w.calls, 1);
  w.fire('homeScreenAdded');
  w.fire('homeScreenAdded');
  assert.equal(added, 1, 'один раз');
  assert.equal(w.handlers.homeScreenAdded.size + w.handlers.homeScreenFailed.size, 0, 'подписки сняты');
  tg.addToHomeScreen({ onAdded: () => added++, onFailed: () => failed++ });
  w.fire('homeScreenFailed');
  assert.equal(failed, 1);
  assert.equal(added, 1);
  const bad = stub();
  bad.addToHomeScreen = () => {
    throw new Error('no');
  };
  assert.equal(tg.addToHomeScreen(), false, 'исключение → false');
  console.log('✓ addToHomeScreen: метод вызван, homeScreenAdded/homeScreenFailed → колбэк один раз');
}
