// Автотест экранов: открывает приложение в Chromium (Playwright) как iPhone, в светлой и тёмной теме,
// проходит по вкладкам и основным листам и проверяет то, что юнит-тесты не видят:
//  • нет ошибок JS и ошибок в консоли;
//  • нет горизонтальной прокрутки;
//  • на месте заголовки и ключевые элементы;
//  • кнопки нажимаются в зоне не меньше 44×44 (минимум iOS).
// Снимки — в tests/e2e/out (в CI — артефакт). Telegram и сервер (Worker) подменены, сеть не нужна.
//
// Запуск: npm i --no-save playwright && npx playwright install chromium && node tests/e2e/screens.mjs
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = process.env.E2E_OUT || join(ROOT, 'tests/e2e/out');
const WORKER = 'https://my-habits-push.mamatkulovasad55.workers.dev';
const NOW = Date.parse('2026-11-16T12:00:00+05:00');

const { typicalData } = await import('../fixtures.mjs');
const { merge } = await import('../../js/store.js');

// ---------- статический сервер ----------
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---------- проверки ----------
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const ok = (cond, msg) => (cond ? console.log(`  ✓ ${msg}`) : fail(msg));

function seed() {
  const d = typicalData();
  // как у созданных в приложении записей: у каждой есть цвет
  d.habits.forEach((h, i) => (h.color = ['#34c759', '#0a84ff', '#ff9f0a', '#af52de'][i % 4]));
  d.abstain.forEach((a) => (a.color = '#ff9f0a'));
  return d;
}

/** home — ответ checkHomeScreenStatus ('missed' | 'unknown' | 'added' | 'unsupported'), days — сколько разных дней открывали приложение. */
/** compass — курс телефона в градусах для замоканного WebApp.DeviceOrientation (absolute); null — датчика нет. */
async function openApp(b, scheme, { locked = false, home = 'unsupported', days = 1, compass = null, tweak = null } = {}) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 740 }, colorScheme: scheme, locale: 'ru-RU', timezoneId: 'Asia/Tashkent' });
  let remote = seed();
  if (locked) remote.settings.privacy = { ...remote.settings.privacy, enabled: true };
  if (tweak) tweak(remote);
  const errors = [];
  const backups = [];
  const codes = []; // коды, ушедшие на /api/lock/verify
  let backupFails = false;
  let backupDelay = 0;
  await ctx.route('https://telegram.org/**', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await ctx.route(`${WORKER}/**`, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const body = JSON.parse(r.request().postData() || '{}');
    if (path === '/api/sync') {
      remote = merge(remote, body.data || {});
      return r.fulfill({ json: { data: remote } });
    }
    if (path === '/api/lock/status') return r.fulfill({ json: { hasCode: locked, retryIn: 0 } });
    if (path === '/api/backup') {
      backups.push(body.reason || '');
      if (backupDelay) await new Promise((res) => setTimeout(res, backupDelay));
      if (backupFails) return r.fulfill({ status: 502, json: { error: 'Telegram не принял файл, попробуй позже' } });
      return r.fulfill({ json: { ok: true, events: 0, at: Date.now() } });
    }
    if (path === '/api/lock/verify') codes.push(body.code);
    if (path === '/api/lock/verify') return r.fulfill({ json: { ok: false, reason: 'wrong', hasCode: true, retryIn: 0, error: 'Неверный код' } });
    return r.fulfill({ json: {} });
  });
  const openDays = Array.from({ length: days }, (_, i) => `2026-11-${String(16 - i).padStart(2, '0')}`).reverse();
  await ctx.addInitScript(`try { const k = 'myhabits:local:v1'; const l = JSON.parse(localStorage.getItem(k) || '{}'); if (!l.seeded) localStorage.setItem(k, JSON.stringify({ ...l, timers: l.timers || {}, openDays: ${JSON.stringify(openDays)}, seeded: true })); } catch {}`);
  await ctx.addInitScript(`window.__home = { status: '${home}', calls: 0, h: {} }; window.Telegram = { WebApp: { initData: 'x=1&hash=a', initDataUnsafe: { user: { first_name: 'Тест' } }, platform: 'ios', colorScheme: '${scheme}',
    isVersionAtLeast: () => true, ready(){}, expand(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(e, fn){ (window.__home.h[e] = window.__home.h[e] || []).push(fn); }, offEvent(e, fn){ window.__home.h[e] = (window.__home.h[e] || []).filter((x) => x !== fn); },
    checkHomeScreenStatus(cb){ setTimeout(() => cb(window.__home.status), 10); },
    addToHomeScreen(){ window.__home.calls++; },
    lockOrientation(){ window.__home.lock = (window.__home.lock || 0) + 1; }, unlockOrientation(){ window.__home.unlock = (window.__home.unlock || 0) + 1; },
    ${compass == null ? '' : `DeviceOrientation: { isStarted: false, absolute: true, alpha: 0, beta: 0, gamma: 0,
      start(p, cb){ this.isStarted = true; this.alpha = ${compass} * Math.PI / 180; window.__home.orient = p; cb && cb(true);
        window.__home.timer = setInterval(() => (window.__home.h.deviceOrientationChanged || []).forEach((fn) => fn()), 50); return this; },
      stop(cb){ this.isStarted = false; clearInterval(window.__home.timer); window.__home.stopped = (window.__home.stopped || 0) + 1; cb && cb(true); return this; } },`}
    BackButton: { show(){}, hide(){}, onClick(){} }, HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } } };`);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await p.goto(BASE);
  await p.waitForSelector('#view > *');
  await p.waitForTimeout(800);
  return { ctx, p, errors, backups, failBackup: (v) => (backupFails = v), slowBackup: (ms) => (backupDelay = ms), remoteSettings: () => remote.settings, remote: () => remote, codes };
}

/** Перейти на раздел с чистого листа (открытые шторки закрываются). */
async function go(p, hash) {
  await p.goto(`${BASE}#${hash}`);
  await p.reload();
  await p.waitForSelector('#view > *');
  await p.waitForTimeout(600);
  await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

const shot = async (p, name) => {
  await p.evaluate(() => scrollTo(0, 0)); // проверки зон нажатия прокручивают страницу
  await p.screenshot({ path: join(OUT, `${name}.png`) });
};
const overflowX = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
/** Видимые поля ввода мельче 16px (iOS приближает их при фокусе). */
const smallInputs = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('input:not([type=checkbox]):not([type=file]):not([hidden]), textarea, select')]
      .filter((e) => e.getClientRects().length)
      .map((e) => [e.className || e.type, parseFloat(getComputedStyle(e).fontSize)])
      .filter(([, px]) => px < 16)
      .map(([c, px]) => `${c} ${px}px`),
  );
const text = (p, sel) => p.locator(sel).first().innerText().catch(() => '');

/** Зона нажатия: точки в 3 px за каждым краем элемента попадают в него самого. → список элементов, где не так. */
const smallTargets = (p, sel) =>
  p.evaluate((sel) => {
    const bad = [];
    for (const e of document.querySelectorAll(sel)) {
      e.scrollIntoView({ block: 'center' }); // не под панелью вкладок
      const r = e.getBoundingClientRect();
      if (!r.width) continue;
      // зона не меньше 44×44: проверяем точки на расстоянии половины от 44 от центра
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const pts = [[cx - 21, cy], [cx + 21, cy], [cx, cy - 21], [cx, cy + 21]];
      const miss = pts.filter(([x, y]) => !e.contains(document.elementFromPoint(x, y)));
      if (miss.length) bad.push(`${e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20) || e.className} (${Math.round(r.width)}×${Math.round(r.height)})`);
    }
    return bad;
  }, sel);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const scheme of ['light', 'dark']) {
  console.log(`\n▶ тема: ${scheme}`);
  const { ctx, p, errors, backups, failBackup, slowBackup } = await openApp(browser, scheme);

  console.log('Сегодня');
  await go(p, 'today');
  ok((await text(p, '#view h1')) === 'Сегодня', 'заголовок «Сегодня»');
  ok((await p.locator('.summary').count()) === 1, 'сводка дня');
  ok((await p.locator('.hcard').count()) >= 2, 'карточки привычек');
  const smallToday = await smallTargets(p, '.page-head .icon-btn, .hcard .act, .today-btn');
  ok(!smallToday.length, `кнопки нажимаются в зоне 44×44${smallToday.length ? `: ${smallToday.join(', ')}` : ''}`);
  ok((await overflowX(p)) <= 0, 'без горизонтальной прокрутки');
  await shot(p, `today-${scheme}`);

  console.log('Без масштабирования');
  {
    const vp = await p.evaluate(() => [...document.querySelectorAll('meta[name=viewport]')].map((m) => m.content));
    ok(vp.length === 1 && vp[0] === 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover', 'viewport: один тег, без масштабирования');
    const ta = await p.evaluate(() => ['body', '.tabbar a', '.hcard .act', '.page-head .icon-btn', '.day', '.today-btn'].map((q) => [q, document.querySelector(q) && getComputedStyle(document.querySelector(q)).touchAction]));
    const badTa = ta.filter(([, v]) => v !== 'manipulation');
    ok(!badTa.length, `touch-action: manipulation на «Сегодня»${badTa.length ? `: ${badTa.map((x) => x.join('=')).join(', ')}` : ''}`);
    let small = await smallInputs(p);
    for (const sub of ['reminders', 'routine', 'prayer', 'data', 'city']) {
      await go(p, `profile/${sub}`);
      small = small.concat((await smallInputs(p)).map((x) => `${sub}: ${x}`));
    }
    await go(p, 'today');
    await p.click('.today-btn[data-action=add-habit]');
    await p.waitForSelector('.sheet input');
    await p.waitForTimeout(300);
    const sheetTa = await p.evaluate(() => getComputedStyle(document.querySelector('.sheet .sheet-body button, .sheet .sheet-body input')).touchAction);
    small = small.concat((await smallInputs(p)).map((x) => `редактор: ${x}`));
    ok(!small.length, `поля ввода не мельче 16px${small.length ? `: ${small.join(', ')}` : ''}`);
    ok(sheetTa === 'manipulation', 'внутри прокручиваемой шторки — тоже manipulation');
    await go(p, 'stats');
    const hmTa = await p.evaluate(() => getComputedStyle(document.querySelector('.heatmap-scroll svg') || document.body).touchAction);
    ok(hmTa === 'manipulation', 'карта года (горизонтальная прокрутка) — manipulation');
    await p.mouse.move(195, 400);
    await p.mouse.wheel(0, 600);
    await p.waitForTimeout(300);
    ok((await p.evaluate(() => scrollY)) > 0, 'вертикальная прокрутка работает');
  }

  console.log('Сегодня: меньше текста, нижние кнопки');
  {
    await go(p, 'today');
    const html = await p.evaluate(() => document.getElementById('view').innerText);
    ok(!(await p.locator('#day-note').count()) && !/Заметка дня|Изменить порядок|🌙/i.test(html), 'нет заметки дня, «Изменить порядок» и 🌙');
    ok(!(await p.locator('.page-head [data-action=add-habit]').count()), 'в шапке нет «+»');
    ok((await p.locator('.page-head .head-actions .icon-btn').count()) === 2, 'в шапке — кибла и зикр');
    const btns = await p.evaluate(() => [...document.querySelectorAll('.today-actions .today-btn')].map((b) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return { t: b.textContent.trim(), h: Math.round(r.height), w: Math.round(r.width), radius: parseFloat(cs.borderTopLeftRadius), fs: cs.fontSize, fw: cs.fontWeight };
    }));
    ok(btns.map((b) => b.t).join(' / ') === 'Вечерний чек-ин / Новая привычка', `нижние кнопки: ${btns.map((b) => b.t).join(' / ')}`);
    const listW = await p.evaluate(() => Math.round(document.querySelector('.list').getBoundingClientRect().width));
    ok(btns.every((b) => b.h === 50 && b.w === listW && b.radius >= 25 && b.fs === '17px' && b.fw === '600'), `кнопки 50 px, во всю ширину, капсула, 17 semibold (${JSON.stringify(btns[0])})`);
    const gaps = await p.evaluate(() => {
      const lists = document.querySelectorAll('.list');
      const last = lists[lists.length - 1].getBoundingClientRect();
      const [a, b] = [...document.querySelectorAll('.today-btn')].map((x) => x.getBoundingClientRect());
      return [Math.round(a.top - last.bottom), Math.round(b.top - a.bottom)];
    });
    ok(gaps[0] === 24 && gaps[1] === 12, `отступы 24 / 12 (${gaps})`);
    const bgs = await p.evaluate(() => [...document.querySelectorAll('.today-btn')].map((b) => getComputedStyle(b).backgroundColor));
    ok(bgs[0] !== bgs[1], `«Новая привычка» отличается от «Вечернего чек-ина» (${bgs.join(' / ')})`);
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await p.waitForTimeout(200);
    const clear = await p.evaluate(() => {
      const btns = document.querySelectorAll('.today-btn');
      return document.querySelector('.tabbar').getBoundingClientRect().top - btns[btns.length - 1].getBoundingClientRect().bottom;
    });
    ok(clear >= 16, `последняя кнопка над таб-баром (${Math.round(clear)} px)`);
    await p.click('.today-btn[data-action=checkin]');
    await p.waitForTimeout(400);
    ok((await text(p, '.sheet .sheet-header strong')) === 'Вечерний чек-ин', '«Вечерний чек-ин» открывает чек-ин (заметка дня там)');
    ok((await p.locator('.sheet .note-input').count()) === 1, 'заметка дня — в чек-ине');
    await go(p, 'today');
    await p.click('.today-btn[data-action=add-habit]');
    await p.waitForSelector('.sheet input');
    ok(true, '«Новая привычка» открывает редактор');
    await go(p, 'today');
    await p.click('[data-action=select-day][data-day="2026-11-15"]');
    await p.waitForTimeout(300);
    ok((await p.locator('.today-btn').allInnerTexts()).join() === 'Новая привычка', 'прошлый день: только «Новая привычка»');
  }

  if (scheme === 'light') {
    console.log('Порядок удержанием карточки');
    const app = await openApp(browser, scheme, {
      tweak: (d) => {
        d.habits.push({ id: 'fri', name: 'По пятницам', emoji: '📖', color: '#0a84ff', type: 'check', createdAt: d.habits[0].createdAt, updatedAt: 1, order: 2.5, schedule: { kind: 'weekdays', days: [5] } });
        d.notes = { ...(d.notes || {}), '2026-11-15': { text: 'старая заметка', updatedAt: 1 } };
      },
    });
    const q = app.p;
    await q.setViewportSize({ width: 375, height: 740 });
    await go(q, 'today');
    await q.evaluate(() => {
      window.__hap = [];
      window.Telegram.WebApp.HapticFeedback = { impactOccurred: (k) => __hap.push(k), selectionChanged: () => __hap.push('sel'), notificationOccurred: (k) => __hap.push(k) };
    });
    const cdp = await app.ctx.newCDPSession(q);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
    const order = () => q.evaluate(() => [...document.querySelectorAll('.list:not(.is-dim) .hcard')].map((c) => c.dataset.hid));
    const doneCount = () => q.evaluate(() => document.querySelectorAll('.hcard .is-done, .hcard.is-done').length);
    const center = (sel) => q.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
    }, sel);
    const before = await order();
    const done0 = await doneCount();
    ok(before.length >= 3, `видимые карточки: ${before.join(', ')}`);
    ok((await q.evaluate(() => getComputedStyle(document.querySelector('.hcard')).userSelect)) === 'none', 'текст карточки не выделяется');
    ok(await q.evaluate(() => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.querySelector('.hcard').dispatchEvent(e);
      return e.defaultPrevented;
    }), 'долгое нажатие: системное меню отменено');

    // быстрый свайп (30 px за 100 мс): жест не запускается
    let c = await center(`.hcard[data-hid="${before[0]}"]`);
    await touch('touchStart', c.x, c.y);
    for (let i = 1; i <= 3; i++) await touch('touchMove', c.x, c.y + i * 10);
    await q.waitForTimeout(500);
    ok(!(await q.locator('.hcard.is-lifted').count()), 'быстрая прокрутка не поднимает карточку');
    await touch('touchEnd');
    await q.waitForTimeout(300);
    ok((await order()).join() === before.join(), 'порядок прежний после свайпа');

    // удержание + ведение вниз на одну карточку + отпускание: порядок меняется, отметки нет
    await q.evaluate(() => (__hap.length = 0));
    c = await center(`.hcard[data-hid="${before[0]}"]`);
    const scroll0 = await q.evaluate(() => scrollY);
    const c2 = await center(`.hcard[data-hid="${before[1]}"]`);
    await touch('touchStart', c.x, c.y);
    await q.waitForTimeout(470);
    ok((await q.locator('.hcard.is-lifted').count()) === 1, 'удержание 400 мс поднимает карточку');
    const lifted = await q.evaluate(() => getComputedStyle(document.querySelector('.hcard.is-lifted')).transform);
    ok(/matrix\(1\.03/.test(lifted), `карточка увеличена (${lifted})`);
    await q.screenshot({ path: join(OUT, 'today-drag-light.png') });
    const target = c2.y - c.h / 2 + 10; // нижний край поднятой прошёл середину следующей
    for (let y = c.y; y <= target; y += 12) {
      await touch('touchMove', c.x, y);
      await q.waitForTimeout(16);
    }
    await touch('touchMove', c.x, target);
    await q.waitForTimeout(250);
    const scrolled = await q.evaluate(() => scrollY);
    await touch('touchEnd');
    const sum = await center('.summary');
    await touch('touchStart', sum.x, sum.y); // сразу после отпускания — новое касание (во время анимации)
    await touch('touchEnd');
    await q.waitForTimeout(700);
    const after = await order();
    ok(after[0] === before[1] && after[1] === before[0], `порядок после перетаскивания (и касания сразу после): ${after.join(', ')}`);
    ok((await doneCount()) === done0, 'после перетаскивания ничего не отмечено');
    const hap = await q.evaluate(() => __hap);
    ok(hap[0] === 'medium' && hap.includes('sel') && hap.includes('light'), `вибрация: ${hap.join(', ')}`);
    ok(scrolled === scroll0, `страница стоит при ведении вниз (${scroll0} → ${scrolled})`);
    await q.waitForTimeout(2200); // синхронизация
    const r = app.remote();
    const ord = (id) => r.habits.find((h) => h.id === id).order;
    ok(ord(before[1]) < ord(before[0]), 'новый порядок ушёл на сервер');
    const all = [...r.habits].filter((h) => !h.deleted).sort((a, b) => a.order - b.order).map((h) => h.id);
    ok(all.indexOf('fri') === 2, `привычка не по расписанию на прежнем месте (${all.join(', ')})`);
    ok(r.notes?.['2026-11-15']?.text === 'старая заметка', 'старые заметки на месте');

    // высокая карточка (с этапами) мимо низкой крайней: уходит в начало (или в конец) списка
    {
      const cur = await order();
      const hs = await q.evaluate((ids) => ids.map((id) => document.querySelector(`.hcard[data-hid="${id}"]`).getBoundingClientRect().height), cur);
      const ti = hs.indexOf(Math.max(...hs.slice(1)), 1);
      const up = hs[0] < hs[ti];
      const ti2 = up ? ti : hs.indexOf(Math.max(...hs.slice(0, -1)));
      const tall = cur[ti2];
      const edge = cur[up ? 0 : cur.length - 1];
      ok(up || hs[hs.length - 1] < hs[ti2], `есть высокая карточка и низкая крайняя (${hs.map(Math.round).join(', ')})`);
      const a = await center(`.hcard[data-hid="${tall}"]`);
      const z = await center(`.hcard[data-hid="${edge}"]`);
      await touch('touchStart', a.x, a.y);
      await q.waitForTimeout(470);
      const endY = up ? z.y - z.h : z.y + z.h;
      for (let y = a.y; up ? y >= endY : y <= endY; y += up ? -12 : 12) {
        await touch('touchMove', a.x, y);
        await q.waitForTimeout(16);
      }
      await touch('touchEnd');
      await q.waitForTimeout(900);
      const got = await order();
      ok(got[up ? 0 : got.length - 1] === tall, `высокая карточка обошла низкую: ${got.join(', ')}`);
    }

    // touchcancel посреди жеста: откат, ничего не сохранено
    const mid = await order();
    c = await center(`.hcard[data-hid="${mid[0]}"]`);
    await touch('touchStart', c.x, c.y);
    await q.waitForTimeout(470);
    for (let y = c.y; y <= c.y + c.h * 1.5; y += 12) await touch('touchMove', c.x, y);
    await touch('touchCancel');
    await q.waitForTimeout(500);
    ok((await order()).join() === mid.join() && !(await q.locator('.hcard.is-lifted, .hcard[style*=translate]').count()), 'touchcancel: исходный порядок, стили сняты');

    // сворачивание посреди жеста: откат
    await touch('touchStart', c.x, c.y);
    await q.waitForTimeout(470);
    for (let y = c.y; y <= c.y + c.h * 1.5; y += 12) await touch('touchMove', c.x, y);
    await q.evaluate(() => (window.__home.h.deactivated || []).forEach((fn) => fn()));
    await touch('touchEnd');
    await q.waitForTimeout(500);
    ok((await order()).join() === mid.join(), 'сворачивание Mini App: исходный порядок');

    const sheets = () => q.locator('.sheet').count();
    const gymDone = () => q.locator('.hcard[data-hid="gym"] .act.is-done').count();

    // удержание на ✓ без движения и отпускание: не отмечает, шторка не открывается
    let gym = await center('.hcard[data-hid="gym"] .act');
    await touch('touchStart', gym.x, gym.y);
    await q.waitForTimeout(470);
    await touch('touchEnd');
    await q.waitForTimeout(500);
    ok((await gymDone()) === 0 && (await sheets()) === 0, 'удержание на ✓ и отпускание: не отмечено, ничего не открылось');

    // мышь (Telegram Desktop): удержание + небольшое движение + отпускание — клика нет
    const card = await center('.hcard[data-hid="gym"] .hname');
    await q.mouse.move(card.x, card.y);
    await q.mouse.down();
    await q.waitForTimeout(470);
    ok((await q.locator('.hcard.is-lifted').count()) === 1, 'мышь: удержание поднимает карточку');
    await q.mouse.move(card.x, card.y + 5);
    await q.mouse.up();
    await q.waitForTimeout(500);
    ok((await gymDone()) === 0 && (await sheets()) === 0, 'мышь: после удержания клик не срабатывает');

    // ведение вверх на прокрученной странице: страница не уезжает
    await q.evaluate(() => scrollTo(0, 120));
    await q.waitForTimeout(150);
    const sy0 = await q.evaluate(() => scrollY);
    const cur = await order();
    const last = await center(`.hcard[data-hid="${cur[cur.length - 1]}"]`);
    await touch('touchStart', last.x, last.y);
    await q.waitForTimeout(470);
    for (let y = last.y; y >= last.y - last.h * 0.4; y -= 8) await touch('touchMove', last.x, y);
    await q.waitForTimeout(150);
    const sy1 = await q.evaluate(() => scrollY);
    await touch('touchCancel');
    await q.waitForTimeout(400);
    ok(sy0 > 0 && sy1 === sy0, `страница не прокручивается, пока карточка поднята (${sy0} → ${sy1})`);

    // автопрокрутка: палец у таб-бара — список едет сам
    await q.evaluate(() => scrollTo(0, 0));
    await q.waitForTimeout(150);
    const first = await center(`.hcard[data-hid="${cur[0]}"]`);
    const barTop = await q.evaluate(() => document.querySelector('.tabbar').getBoundingClientRect().top);
    await touch('touchStart', first.x, first.y);
    await q.waitForTimeout(470);
    for (let y = first.y; y <= barTop - 10; y += 16) await touch('touchMove', first.x, y);
    await q.waitForTimeout(400);
    const auto = await q.evaluate(() => scrollY);
    await touch('touchCancel');
    await q.waitForTimeout(400);
    ok(auto > 0, `автопрокрутка у таб-бара (scrollY ${auto})`);
    ok((await order()).join() === cur.join(), 'после отмены порядок прежний');

    // обычный тап по ✓ (тачскрин) работает как раньше
    await q.evaluate(() => scrollTo(0, 0));
    gym = await center('.hcard[data-hid="gym"] .act');
    await q.touchscreen.tap(gym.x, gym.y);
    await q.waitForTimeout(500);
    ok((await gymDone()) === 1, 'тап по ✓ без удержания отмечает');

    // перезапуск — порядок сохранён
    await q.reload();
    await q.waitForSelector('#view > *');
    await q.waitForTimeout(600);
    ok((await order()).join() === mid.join(), 'порядок сохранён после перезапуска');
    ok(!app.errors.length, `без ошибок JS${app.errors.length ? `: ${app.errors.join(' | ')}` : ''}`);
    await app.ctx.close();
  }

  {
    const app = await openApp(browser, scheme, { tweak: (d) => (d.habits = []) });
    await go(app.p, 'today');
    ok((await app.p.locator('.empty').count()) === 1 && !(await app.p.locator('.empty button').count()), 'пустой список: заглушка без своей кнопки');
    ok((await app.p.locator('.today-btn').allInnerTexts()).join(' / ') === 'Вечерний чек-ин / Новая привычка', 'пустой список: обе нижние кнопки видны');
    await app.p.screenshot({ path: join(OUT, `today-empty-${scheme}.png`) });
    await app.ctx.close();
  }

  console.log('Детокс');
  await go(p, 'abstain');
  ok((await text(p, '#view h1')) === 'Детокс', 'заголовок «Детокс»');
  ok((await p.locator('.acard').count()) >= 1, 'плашка детокса');
  ok((await p.locator('.acard-best, .acard-foot').count()) === 0, 'на плашке нет повторов отсчёта');
  ok((await overflowX(p)) <= 0, 'без горизонтальной прокрутки');
  await shot(p, `detox-${scheme}`);

  console.log('Статистика');
  await go(p, 'stats');
  ok((await text(p, '#view h1')) === 'Статистика', 'заголовок «Статистика»');
  const hm = await p.evaluate(() => {
    const el = document.querySelector('.heatmap-scroll');
    const step = Number(el?.querySelector('svg')?.dataset.step) || 0;
    return { aligned: step ? (el.scrollLeft - 2) % step === 0 : false };
  });
  ok(hm.aligned, 'карта года: край прокрутки на границе недели');
  ok((await overflowX(p)) <= 0, 'без горизонтальной прокрутки');
  await shot(p, `stats-${scheme}`);

  console.log('Профиль');
  await go(p, 'profile');
  const rows = await p.locator('.nav-row').count();
  ok(rows >= 10 && (await p.locator('.nav-row .nav-ic svg').count()) === rows, 'у каждой строки — значок-SVG');
  ok((await overflowX(p)) <= 0, 'без горизонтальной прокрутки');
  await shot(p, `profile-${scheme}`);

  await go(p, 'profile/achievements');
  ok((await p.locator('.ach-row').count()) === 5, 'достижения: строка на каждое из 5');
  await shot(p, `achievements-${scheme}`);

  await go(p, 'profile/prayer');
  ok((await p.locator('.adj .round-btn').count()) >= 10, 'время намаза: кнопки ± на месте');
  await shot(p, `prayer-${scheme}`);

  console.log('Данные');
  await go(p, 'profile/data');
  const groups = await p.locator('#view .group-title').allInnerTexts();
  ok(groups.join(' / ').toLowerCase() === 'резервная копия / опасная зона', `группы: ${groups.join(' / ')}`);
  ok((await p.locator('#view [data-s=last-backup]').innerText()).startsWith('Бэкапов ещё не было'), '«Последний бэкап»: ещё не было');
  ok((await p.locator('#view [data-set-bool="backup.weekly"]').isChecked()), 'еженедельный бэкап включён по умолчанию');
  ok((await p.locator('#view .row.is-danger').count()) === 2, 'опасная зона: две красные строки');
  ok((await overflowX(p)) <= 0, 'без горизонтальной прокрутки');
  await shot(p, `data-${scheme}`);
  // импорт: превью файла
  await p.locator('#view [data-s=import]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(seed())) });
  await p.waitForSelector('.import-preview');
  ok((await p.locator('.import-preview .row').count()) === 6, 'превью импорта: 6 строк');
  await p.waitForTimeout(500); // шторка доехала
  await shot(p, `import-${scheme}`);
  await p.click('.sheet [data-c=cancel]');
  await p.waitForTimeout(400);
  await p.locator('#view [data-s=import]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"foo":1}') });
  await p.waitForTimeout(400);
  ok((await text(p, '.sheet .confirm h3')) === 'Файл не подходит', 'чужой файл — ошибка');
  await p.click('.sheet [data-c=ok]');
  await p.waitForTimeout(400);
  // сброс прогресса: кнопка активна только после слова
  await p.click('#view [data-s=reset]');
  await p.waitForSelector('.sheet [data-word]');
  ok(await p.locator('.sheet [data-c=ok]').isDisabled(), 'сброс: кнопка неактивна без слова');
  await p.fill('.sheet [data-word]', 'сбро');
  ok(await p.locator('.sheet [data-c=ok]').isDisabled(), 'сброс: неполное слово не подходит');
  await p.fill('.sheet [data-word]', 'сброс');
  ok(await p.locator('.sheet [data-c=ok]').isEnabled(), 'сброс: после слова «СБРОС» — активна');
  await p.waitForTimeout(300);
  await shot(p, `reset-${scheme}`);
  ok((await p.locator('.sheet .danger-list.is-gone li').count()) >= 3 && (await p.locator('.sheet .danger-list.is-kept li').count()) >= 3, 'сброс: списки «Удалится» и «Останется»');
  // медленный бэкап: шторка ожидания, второй запуск невозможен
  slowBackup(1500);
  await p.press('.sheet [data-word]', 'Enter'); // «Готово» на клавиатуре подтверждает
  await p.waitForSelector('.wait-sheet');
  await p.waitForTimeout(400);
  await shot(p, `backup-wait-${scheme}`);
  const blocked = await p.evaluate(() => {
    const r = document.querySelector('#view [data-s=reset]').getBoundingClientRect();
    return !document.querySelector('#view').contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  ok(blocked, 'пока идёт бэкап, строки под шторкой не нажимаются');
  await p.waitForTimeout(2200);
  slowBackup(0);
  ok(backups.filter((b) => b === 'reset').length === 1 && (await p.locator('.wait-sheet').count()) === 0, 'один бэкап, шторка ожидания закрылась');
  const after = await p.evaluate(() => JSON.parse(localStorage.getItem('myhabits:data:v1')));
  ok(backups.includes('reset'), 'перед сбросом — бэкап с причиной «reset»');
  ok(Object.keys(after.logs).length === 0 && after.habits.filter((h) => !h.deleted).length >= 2, 'сброс: история пуста, привычки на месте');
  ok((await p.locator('#view [data-s=last-backup]').innerText()).startsWith('Последний бэкап:'), '«Последний бэкап» обновился');
  await p.click('#view [data-s=wipe]');
  await p.waitForSelector('.sheet [data-word]');
  ok(await p.locator('.sheet [data-c=ok]').isDisabled(), 'удаление: кнопка неактивна без слова «УДАЛИТЬ»');
  // бэкап не ушёл → шторка «Скачать экспорт и продолжить / Отмена»; отмена ничего не удаляет
  failBackup(true);
  await p.fill('.sheet [data-word]', 'УДАЛИТЬ');
  await p.click('.sheet [data-c=ok]');
  await p.waitForSelector('.sheet .confirm h3:text("Бэкап не отправлен")');
  await p.waitForTimeout(400);
  await shot(p, `backup-failed-${scheme}`);
  // «Скачать экспорт и продолжить» → вопрос «Файл сохранился?»; «Отмена» — ничего не удалено
  const dl = p.waitForEvent('download');
  await p.click('.sheet [data-c=ok]');
  await dl;
  await p.waitForSelector('.sheet .confirm h3:text("Файл сохранился?")');
  await p.waitForTimeout(400);
  await shot(p, `export-saved-${scheme}`);
  await p.click('.sheet [data-c=cancel]');
  await p.waitForTimeout(600);
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('myhabits:data:v1')));
  ok(kept.habits.filter((h) => !h.deleted).length >= 2, 'бэкап не ушёл, файл не подтверждён — данные не удалены');
  failBackup(false);

  console.log('Зикры');
  await go(p, 'today');
  await p.click('[data-action=open-dhikr]');
  await p.waitForSelector('.dhikr-col');
  ok((await p.locator('.dhikr-col').count()) === 4, 'четыре раздела зикров');
  await shot(p, `dhikr-${scheme}`);
  await p.click('[data-col=all]');
  await p.waitForTimeout(400);
  const smallStar = await smallTargets(p, '.sheet .dhikr-star');
  ok(!smallStar.length, `звезда «в избранное» — зона 44×44${smallStar.length ? `: ${smallStar.join(', ')}` : ''}`);

  ok(!errors.length, `без ошибок JS${errors.length ? `:\n      ${errors.join('\n      ')}` : ''}`);
  await ctx.close();

  console.log('Иконка на экране «Домой»');
  {
    // статус missed, 3-й день: строка с «Добавить» и подсказка на «Сегодня»
    const m = await openApp(browser, scheme, { home: 'missed', days: 3 });
    await go(m.p, 'today');
    ok((await m.p.locator('.home-hint').count()) === 1, '3-й день, иконки нет — подсказка на «Сегодня»');
    const smallHint = await smallTargets(m.p, '.home-hint .pill, .home-hint-close');
    ok(!smallHint.length, `подсказка: кнопки 44×44${smallHint.length ? `: ${smallHint.join(', ')}` : ''}`);
    await m.p.evaluate(() => scrollTo(0, 9999));
    await m.p.locator('.home-hint').screenshot({ path: join(OUT, `home-hint-${scheme}.png`) });
    await m.p.click('.home-hint-close');
    await m.p.waitForTimeout(300);
    ok((await m.p.locator('.home-hint').count()) === 0, '✕ — подсказка скрыта');
    await go(m.p, 'today');
    ok((await m.p.locator('.home-hint').count()) === 0, 'после перезапуска подсказка не возвращается');
    ok(m.remoteSettings().homeScreen?.hintDone === true, 'флаг «не показывать» ушёл на сервер (синхронизируется)');
    await go(m.p, 'profile');
    const row = m.p.locator('#view .home-row');
    ok((await row.count()) === 1 && (await row.locator('.pill').innerText()) === 'Добавить', 'Профиль: строка «Иконка на экране «Домой»» с «Добавить»');
    ok((await m.p.locator('#view .list-group').last().locator('.row').first().getAttribute('class')).includes('home-row'), 'строка — первая в группе «Приложение»');
    await m.p.evaluate(() => document.querySelector('#view .home-row').scrollIntoView({ block: 'center' }));
    await row.screenshot({ path: join(OUT, `home-row-missed-${scheme}.png`) });
    // «Добавить» → метод вызван; событие homeScreenAdded → тост и «Добавлено»
    await row.locator('.pill').click();
    ok((await m.p.evaluate(() => window.__home.calls)) === 1, '«Добавить» вызывает addToHomeScreen');
    await m.p.evaluate(() => { window.__home.status = 'added'; (window.__home.h.homeScreenAdded || []).forEach((fn) => fn()); });
    await m.p.waitForTimeout(300);
    ok((await text(m.p, '.toast')) === 'Иконка добавлена', 'тост «Иконка добавлена»');
    ok((await text(m.p, '#view .home-row .home-done')).includes('Добавлено') && (await m.p.locator('#view .home-row .pill').count()) === 0, 'строка → «Добавлено», без кнопки');
    await m.p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await m.p.evaluate(() => document.querySelector('#view .home-row').scrollIntoView({ block: 'center' }));
    await m.p.locator('#view .home-row').screenshot({ path: join(OUT, `home-row-added-${scheme}.png`) });
    ok(!m.errors.length, `без ошибок JS${m.errors.length ? `:\n      ${m.errors.join('\n      ')}` : ''}`);
    await m.ctx.close();
  }
  {
    // 2-й день — подсказки ещё нет; unknown (iOS) — подпись в строке
    const u = await openApp(browser, scheme, { home: 'unknown', days: 2 });
    await go(u.p, 'today');
    ok((await u.p.locator('.home-hint').count()) === 0, '2-й день — подсказки нет');
    await go(u.p, 'profile');
    ok((await text(u.p, '#view .home-row .nav-sub')) === 'Telegram не сообщает, добавлена ли иконка', 'unknown: «Добавить» и подпись');
    await u.p.evaluate(() => document.querySelector('#view .home-row').scrollIntoView({ block: 'center' }));
    await u.p.locator('#view .home-row').screenshot({ path: join(OUT, `home-row-unknown-${scheme}.png`) });
    await u.ctx.close();
    // unsupported (Desktop, Web) — ни строки, ни подсказки
    const d = await openApp(browser, scheme, { home: 'unsupported', days: 3 });
    await go(d.p, 'today');
    const hintNone = (await d.p.locator('.home-hint').count()) === 0;
    await go(d.p, 'profile');
    ok(hintNone && (await d.p.locator('#view .home-row').count()) === 0, 'unsupported: ни строки, ни подсказки');
    ok(!d.errors.length, 'unsupported: без ошибок JS');
    await d.ctx.close();
  }

  console.log('Кибла');
  {
    // без датчика (как Telegram Desktop): азимут, расстояние, город, подсказка по солнцу или компасу телефона
    const n = await openApp(browser, scheme);
    await go(n.p, 'today');
    await n.p.click('[data-action=open-qibla]');
    await n.p.waitForSelector('.qibla-big', { timeout: 5000 });
    ok((await text(n.p, '.qibla-big')) === 'Кибла: 240° от севера', 'без компаса: «Кибла: 240° от севера»');
    ok((await text(n.p, '.qibla-sub')).replace(/\s/g, ' ').startsWith('3 531 км до Каабы · Ташкент'), 'расстояние и город');
    ok(/солнце на азимуте \d+°\. Кибла — на \d+° (правее|левее) солнца|Открой компас телефона/.test(await text(n.p, '.qibla-sun')), 'подсказка по солнцу или компасу телефона');
    await n.p.waitForTimeout(300);
    await n.p.screenshot({ path: join(OUT, `qibla-nocompass-${scheme}.png`) });
    await n.p.click('.sheet [data-q=close]');
    await n.p.waitForTimeout(300);
    await go(n.p, 'profile');
    ok((await text(n.p, '#view [data-nav=qibla] .nav-val')) === '240°', 'Профиль → Намаз: «Кибла · 240°»');
    ok(!n.errors.length, `без ошибок JS${n.errors.length ? `:\n      ${n.errors.join('\n      ')}` : ''}`);
    await n.ctx.close();
    // датчик Telegram (absolute, iPhone, истинный север): курс 240° → «Кибла ✓»
    const c = await openApp(browser, scheme, { compass: 240.3 });
    await go(c.p, 'today');
    await c.p.click('[data-action=open-qibla]');
    await c.p.waitForFunction(() => document.querySelector('.qibla-hint')?.textContent === 'Кибла ✓', null, { timeout: 5000 });
    ok(true, 'датчик: курс 240° → «Кибла ✓»');
    const h = await c.p.evaluate(() => window.__home);
    ok(h.orient?.need_absolute === true && h.orient?.refresh_rate === 50 && h.lock === 1, 'DeviceOrientation.start({ refresh_rate: 50, need_absolute: true }), экран зафиксирован');
    ok((await text(c.p, '.qibla-num')).replace(/\s/g, ' ') === '240° · 3 531 км', 'в центре «240° · 3 531 км»');
    ok((await c.p.locator('.sheet [data-q=truenorth]').count()) === 1, 'iPhone: переключатель «У Telegram есть доступ к геопозиции»');
    await c.p.waitForTimeout(300);
    await c.p.screenshot({ path: join(OUT, `qibla-compass-${scheme}.png`) });
    await c.p.click('.sheet [data-q=close]');
    await c.p.waitForTimeout(300);
    const h2 = await c.p.evaluate(() => window.__home);
    ok(h2.stopped === 1 && h2.unlock === 1, 'закрыли — датчик остановлен, поворот экрана разблокирован');
    ok(!c.errors.length, `без ошибок JS${c.errors.length ? `:\n      ${c.errors.join('\n      ')}` : ''}`);
    await c.ctx.close();
  }

  console.log('Экран блокировки');
  const lock = await openApp(browser, scheme, { locked: true });
  await go(lock.p, 'abstain');
  ok((await lock.p.locator('.lock-screen').count()) === 1, 'раздел закрыт');
  ok((await lock.p.locator('#view h1').count()) === 0, 'без заголовка раздела');
  ok((await text(lock.p, '.lock-screen h2')) === 'Раздел защищён', '«Раздел защищён»');
  ok((await lock.p.locator('.pin-key[data-pin]').count()) === 11, 'клавиатура: 10 цифр и «Стереть»');
  ok((await lock.p.evaluate(() => getComputedStyle(document.querySelector('.pin-key')).touchAction)) === 'manipulation', 'клавиши PIN: touch-action: manipulation');
  // быстрый ввод «1-1-1-1»: тапы подряд без пауз — все четыре цифры
  for (let i = 0; i < 4; i++) await lock.p.tap('.lock-screen .pin-key[data-pin="1"]');
  await lock.p.waitForTimeout(500);
  ok(lock.codes.at(-1) === '1111', `быстрый ввод «1-1-1-1» — ушёл код 1111${lock.codes.length ? ` (${lock.codes.join(', ')})` : ''}`);
  await shot(lock.p, `lock-${scheme}`);
  // «Данные» при защите: переключатель неактивен, опасные действия и импорт — только по коду
  await go(lock.p, 'profile/data');
  const wk = lock.p.locator('#view [data-set-bool="backup.weekly"]');
  ok((await wk.isDisabled()) && (await lock.p.locator('#view .switch-row .muted').first().innerText()).includes('пока включена защита'), 'защита: еженедельный бэкап неактивен, с подписью');
  await shot(lock.p, `data-locked-${scheme}`);
  const before = await lock.p.evaluate(() => localStorage.getItem('myhabits:data:v1'));
  const tryCode = async () => {
    await lock.p.waitForSelector('.sheet .lock-sheet');
    for (const n of ['1', '2', '3', '4']) await lock.p.click(`.sheet .pin-key[data-pin="${n}"]`);
    await lock.p.waitForTimeout(600);
    ok((await text(lock.p, '.sheet .lock-msg')) === 'Неверный код', 'неверный код — отказ');
    await lock.p.click('.sheet [data-a=cancel]');
    await lock.p.waitForTimeout(400);
  };
  for (const s of ['reset', 'wipe']) {
    await lock.p.click(`#view [data-s=${s}]`);
    await lock.p.waitForSelector('.sheet .confirm');
    ok((await lock.p.locator('.sheet [data-word]').count()) === 0, `${s}: при защите — без ввода слова`);
    await lock.p.click('.sheet [data-c=ok]');
    await tryCode();
  }
  await lock.p.locator('#view [data-s=import]').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(seed())) });
  await lock.p.waitForSelector('.import-preview');
  await lock.p.waitForTimeout(400);
  await lock.p.click('.sheet [data-c=ok]');
  await tryCode();
  ok(!lock.backups.length && (await lock.p.evaluate(() => localStorage.getItem('myhabits:data:v1'))) === before, 'без кода: ни бэкапа, ни изменений');
  ok(!lock.errors.length, `без ошибок JS${lock.errors.length ? `:\n      ${lock.errors.join('\n      ')}` : ''}`);
  await lock.ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n✗ проверок не прошло: ${failures}` : `\n✓ экраны в порядке (снимки: ${OUT})`);
process.exit(failures ? 1 : 0);
