// Подписка на push-уведомления через свой Cloudflare Worker.
const KEY_STORE = 'myhabits:pushkey:v1';

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

function setKey(k) {
  try {
    localStorage.setItem(KEY_STORE, k);
  } catch {
    /* ignore */
  }
}

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function call(url, path, body) {
  const res = await fetch(`${clean(url)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try {
    j = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(j.error || `Сервер ответил ${res.status}`);
  return j;
}

/** Текущее состояние подписки на этом устройстве. */
export async function status() {
  if (!supported()) return { state: 'unsupported' };
  if (isIOS() && !isStandalone()) return { state: 'need-home' };
  if (Notification.permission === 'denied') return { state: 'denied' };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return { state: sub && getKey() ? 'on' : 'off' };
}

/** Подключить уведомления: разрешение → подписка → регистрация на сервере. */
export async function enable(workerUrl, key) {
  if (!supported()) throw new Error('Этот браузер не поддерживает уведомления');
  if (isIOS() && !isStandalone()) throw new Error('На iPhone сначала добавь приложение на экран «Домой» и открой его оттуда');
  if (!workerUrl || !key) throw new Error('Укажи адрес сервера и ключ');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Уведомления не разрешены');
  const { publicKey } = await call(workerUrl, '/vapid');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const appKey = b64ToBytes(publicKey);
  if (sub) {
    // если ключ сервера сменился — переподписываемся
    const cur = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (cur && cur.join() !== appKey.join()) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
  await call(workerUrl, '/subscribe', { key, subscription: sub.toJSON(), device: deviceName() });
  setKey(key);
}

export async function disable(workerUrl) {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    try {
      await call(workerUrl, '/unsubscribe', { key: getKey(), endpoint: sub.endpoint });
    } catch {
      /* сервер мог быть недоступен — всё равно отписываемся локально */
    }
    await sub.unsubscribe();
  }
  setKey('');
}

export const test = (workerUrl) => call(workerUrl, '/test', { key: getKey() });

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Устройство';
}
