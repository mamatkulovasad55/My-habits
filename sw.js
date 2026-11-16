// Service worker: офлайн-кэш оболочки приложения.
const VERSION = 'v30';
const CACHE = `my-habits-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/sync.js',
  './js/logic.js',
  './js/ui.js',
  './js/util.js',
  './js/storage.js',
  './js/lock.js',
  './js/achievements.js',
  './js/settings-merge.js',
  './js/prayer.js',
  './js/schedule.js',
  './js/tg.js',
  './js/config.js',
  './js/migrate.js',
  './js/calibrate.js',
  './js/hijri.js',
  './js/dhikr.js',
  './js/backup.js',
  './data/dhikr.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — мимо HTTP-кэша браузера: иначе новая версия могла сохранить старые файлы
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('my-habits-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сначала сеть (чтобы обновления приходили сразу), при офлайне — кэш.
// При плохой связи не ждём сеть дольше NET_TIMEOUT: показываем кэш, а ответ сети обновит его в фоне.
const NET_TIMEOUT = 3000;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const cached = () => caches.match(e.request, { ignoreSearch: true });
  // GitHub Pages отдаёт файлы с max-age=600: обычный fetch брал бы из HTTP-кэша браузера скрипты
  // десятиминутной давности (вкладка уже новая, а экран — старый). no-cache — перепроверка у сервера (304, если не менялось).
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  });
  const slow = new Promise((resolve) => setTimeout(resolve, NET_TIMEOUT)).then(cached);
  e.respondWith(
    Promise.race([network.catch(() => undefined), slow])
      .then((res) => res || network) // кэша нет — всё-таки дождаться сети
      .catch(() => cached().then((r) => r || caches.match('./index.html'))),
  );
  e.waitUntil(network.catch(() => {}));
});
