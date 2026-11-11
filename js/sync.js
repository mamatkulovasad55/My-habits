// Синхронизация через свой сервер (Cloudflare Worker).
// Сервер проверяет подпись Telegram, сливает данные с приватным репозиторием и возвращает результат.
// На устройстве не хранится ни одного токена.
import { getData, replaceData, merge, adoptServerStamps } from './store.js';
import { stableStringify } from './util.js';
import { WORKER_URL } from './config.js';
import { inTelegram, initData } from './tg.js';

let status = { state: 'off', last: 0, error: '', code: '' };
const listeners = new Set();
let timer = null;
let running = false;
let pending = false;

export const isConfigured = () => inTelegram();
export const getStatus = () => status;
export const onStatus = (fn) => (listeners.add(fn), () => listeners.delete(fn));

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

export async function api(path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Init-Data': initData() },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let j = {};
  try {
    j = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const e = new Error(j.error || `Сервер ответил ${res.status}`);
    e.code = j.code || '';
    throw e;
  }
  return j;
}

export function schedule(delay = 1500) {
  if (!isConfigured()) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export async function syncNow() {
  if (!isConfigured()) return;
  if (running) {
    pending = true;
    return;
  }
  if (navigator.onLine === false) {
    setStatus({ state: 'offline' });
    return;
  }
  running = true;
  setStatus({ state: 'syncing', error: '', code: '' });
  try {
    const sent = getData();
    const { data } = await api('/api/sync', { data: sent });
    // за время запроса могли появиться новые отметки — сливаем ещё раз
    const now = getData();
    // метки настроек, урезанные сервером (часы устройства спешат), — принять серверные, иначе синхронизация зациклится
    const final = merge(adoptServerStamps(now, data), data);
    if (stableStringify(final) !== stableStringify(now)) replaceData(final);
    if (stableStringify(final) !== stableStringify(merge(data, {}))) pending = true;
    setStatus({ state: 'idle', last: Date.now() });
  } catch (e) {
    const offline = navigator.onLine === false;
    setStatus({ state: offline ? 'offline' : 'error', error: offline ? '' : e.message, code: e.code || '' });
  } finally {
    running = false;
    if (pending) {
      pending = false;
      schedule(800);
    }
  }
}

export function initSync() {
  if (!isConfigured()) return;
  setStatus({ state: 'idle' });
  window.addEventListener('online', () => schedule(200));
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(200);
  });
  schedule(50);
}
