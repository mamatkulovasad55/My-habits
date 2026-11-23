// Порядок удержанием карточки: перестановка видимых не двигает скрытых (js/logic.js mergeVisibleOrder) + tg-обёртки.
import assert from 'node:assert/strict';
import './helpers.mjs';

const { mergeVisibleOrder } = await import('../js/logic.js');
const tg = await import('../js/tg.js');

// видимые a, c, e; скрытые по расписанию b, d остаются на своих индексах
assert.deepEqual(mergeVisibleOrder(['a', 'b', 'c', 'd', 'e'], ['e', 'a', 'c']), ['e', 'b', 'a', 'd', 'c']);
// без перестановки — то же самое
assert.deepEqual(mergeVisibleOrder(['a', 'b', 'c'], ['a', 'c']), ['a', 'b', 'c']);
// все видимы — просто новый порядок
assert.deepEqual(mergeVisibleOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);

// holdVerticalSwipes: свайпы уже выключены — не трогаем; включены — выключаем и возвращаем
const calls = [];
const w = { isVerticalSwipesEnabled: false, disableVerticalSwipes: () => calls.push('off'), enableVerticalSwipes: () => calls.push('on') };
globalThis.window = { Telegram: { WebApp: w } };
tg.holdVerticalSwipes()();
assert.deepEqual(calls, []);
w.isVerticalSwipesEnabled = true;
const restore = tg.holdVerticalSwipes();
assert.deepEqual(calls, ['off']);
restore();
assert.deepEqual(calls, ['off', 'on']);
// selectionChanged
let sel = 0;
w.HapticFeedback = { selectionChanged: () => sel++ };
tg.hapticSelection();
assert.equal(sel, 1);
delete w.HapticFeedback;
tg.hapticSelection(); // без HapticFeedback — без ошибки

console.log('✓ reorder');
