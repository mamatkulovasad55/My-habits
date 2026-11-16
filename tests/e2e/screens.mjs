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

async function openApp(b, scheme, { locked = false } = {}) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 740 }, colorScheme: scheme, locale: 'ru-RU', timezoneId: 'Asia/Tashkent' });
  let remote = seed();
  if (locked) remote.settings.privacy = { ...remote.settings.privacy, enabled: true };
  const errors = [];
  const backups = [];
  let backupFails = false;
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
      if (backupFails) return r.fulfill({ status: 502, json: { error: 'Telegram не принял файл, попробуй позже' } });
      return r.fulfill({ json: { ok: true, events: 0, at: Date.now() } });
    }
    if (path === '/api/lock/verify') return r.fulfill({ json: { ok: false, reason: 'wrong', hasCode: true, retryIn: 0, error: 'Неверный код' } });
    return r.fulfill({ json: {} });
  });
  await ctx.addInitScript(`window.Telegram = { WebApp: { initData: 'x=1&hash=a', initDataUnsafe: { user: { first_name: 'Тест' } }, platform: 'ios', colorScheme: '${scheme}',
    isVersionAtLeast: () => true, ready(){}, expand(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){}, onEvent(){},
    BackButton: { show(){}, hide(){}, onClick(){} }, HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } } };`);
  const p = await ctx.newPage();
  await p.clock.install({ time: NOW });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await p.goto(BASE);
  await p.waitForSelector('#view > *');
  await p.waitForTimeout(800);
  return { ctx, p, errors, backups, failBackup: (v) => (backupFails = v) };
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
  const { ctx, p, errors, backups, failBackup } = await openApp(browser, scheme);

  console.log('Сегодня');
  await go(p, 'today');
  ok((await text(p, '#view h1')) === 'Сегодня', 'заголовок «Сегодня»');
  ok((await p.locator('.summary').count()) === 1, 'сводка дня');
  ok((await p.locator('.hcard').count()) >= 2, 'карточки привычек');
  const smallToday = await smallTargets(p, '.page-head .icon-btn, .hcard .act, .list-tools .link-btn');
  ok(!smallToday.length, `кнопки нажимаются в зоне 44×44${smallToday.length ? `: ${smallToday.join(', ')}` : ''}`);
  ok((await overflowX(p)) <= 0, 'без горизонтальной прокрутки');
  await shot(p, `today-${scheme}`);

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
  await p.click('.sheet [data-c=ok]');
  await p.waitForTimeout(1200);
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
  await p.click('.sheet [data-c=cancel]');
  await p.waitForTimeout(600);
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('myhabits:data:v1')));
  ok(kept.habits.filter((h) => !h.deleted).length >= 2, 'бэкап не ушёл, «Отмена» — данные не удалены');
  failBackup(false);

  console.log('Зикры');
  await go(p, 'today');
  await p.click('.dhikr-btn');
  await p.waitForSelector('.dhikr-col');
  ok((await p.locator('.dhikr-col').count()) === 4, 'четыре раздела зикров');
  await shot(p, `dhikr-${scheme}`);
  await p.click('[data-col=all]');
  await p.waitForTimeout(400);
  const smallStar = await smallTargets(p, '.sheet .dhikr-star');
  ok(!smallStar.length, `звезда «в избранное» — зона 44×44${smallStar.length ? `: ${smallStar.join(', ')}` : ''}`);

  ok(!errors.length, `без ошибок JS${errors.length ? `:\n      ${errors.join('\n      ')}` : ''}`);
  await ctx.close();

  console.log('Экран блокировки');
  const lock = await openApp(browser, scheme, { locked: true });
  await go(lock.p, 'abstain');
  ok((await lock.p.locator('.lock-screen').count()) === 1, 'раздел закрыт');
  ok((await lock.p.locator('#view h1').count()) === 0, 'без заголовка раздела');
  ok((await text(lock.p, '.lock-screen h2')) === 'Раздел защищён', '«Раздел защищён»');
  ok((await lock.p.locator('.pin-key[data-pin]').count()) === 11, 'клавиатура: 10 цифр и «Стереть»');
  await shot(lock.p, `lock-${scheme}`);
  ok(!lock.errors.length, `без ошибок JS${lock.errors.length ? `:\n      ${lock.errors.join('\n      ')}` : ''}`);
  await lock.ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n✗ проверок не прошло: ${failures}` : `\n✓ экраны в порядке (снимки: ${OUT})`);
process.exit(failures ? 1 : 0);
