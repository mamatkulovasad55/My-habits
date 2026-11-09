// Синхронизация с приватным GitHub-репозиторием через Contents API.
// Схема: скачать data.json → слить с локальными данными → записать, если есть отличия.
import { getData, replaceData, merge } from './store.js';
import { stableStringify } from './util.js';

const CFG_KEY = 'myhabits:sync:v1';
const API = 'https://api.github.com';

let status = { state: 'off', last: 0, error: '' };
const listeners = new Set();
let timer = null;
let running = false;
let pending = false;

export function getConfig() {
  try {
    return { owner: '', repo: 'my-habits-data', path: 'data.json', token: '', ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') };
  } catch {
    return { owner: '', repo: 'my-habits-data', path: 'data.json', token: '' };
  }
}

export function setConfig(cfg) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
  setStatus(isConfigured() ? { state: 'idle', error: '' } : { state: 'off', error: '' });
}

export const isConfigured = () => {
  const c = getConfig();
  return Boolean(c.owner && c.repo && c.token);
};

export const getStatus = () => status;
export const onStatus = (fn) => (listeners.add(fn), () => listeners.delete(fn));

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

// ---------- base64 <-> UTF-8 ----------

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------- GitHub API ----------

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const contentsUrl = (c) =>
  `${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}`;

async function apiError(res) {
  let msg = `${res.status}`;
  try {
    const j = await res.json();
    if (j.message) msg += ` · ${j.message}`;
  } catch {
    /* ignore */
  }
  if (res.status === 401) return 'Токен недействителен или истёк (401)';
  if (res.status === 403) return 'Нет доступа: проверь права токена — Contents: Read and write (403)';
  if (res.status === 404) return 'Репозиторий не найден или токен не имеет к нему доступа (404)';
  return `Ошибка GitHub: ${msg}`;
}

async function fetchRemote(c) {
  const res = await fetch(`${contentsUrl(c)}?t=${Date.now()}`, { headers: headers(c.token), cache: 'no-store' });
  if (res.status === 404) {
    // файла ещё нет — проверим, что сам репозиторий доступен
    const repo = await fetch(`${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, {
      headers: headers(c.token),
      cache: 'no-store',
    });
    if (!repo.ok) throw new Error(await apiError(repo));
    return null;
  }
  if (!res.ok) throw new Error(await apiError(res));
  const j = await res.json();
  return { sha: j.sha, data: JSON.parse(fromBase64(j.content || '') || '{}') };
}

async function putRemote(c, data, sha) {
  const body = {
    message: `Обновление данных трекера · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    content: toBase64(stableStringify(data, 1) + '\n'),
  };
  if (sha) body.sha = sha;
  return fetch(contentsUrl(c), { method: 'PUT', headers: headers(c.token), body: JSON.stringify(body) });
}

/** Проверка подключения (для кнопки в настройках). */
export async function testConnection(c) {
  const res = await fetch(`${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, {
    headers: headers(c.token),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(await apiError(res));
  const j = await res.json();
  return { private: j.private, fullName: j.full_name };
}

// ---------- Основной цикл ----------

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
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setStatus({ state: 'offline' });
    return;
  }
  running = true;
  setStatus({ state: 'syncing', error: '' });
  const c = getConfig();
  try {
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const remote = await fetchRemote(c);
      const merged = remote ? merge(getData(), remote.data) : merge(getData(), {});
      if (remote && stableStringify(merge(remote.data, {})) === stableStringify(merged)) {
        done = true;
      } else {
        const res = await putRemote(c, merged, remote?.sha);
        if (res.ok) done = true;
        else if (res.status === 409 || res.status === 422) continue; // кто-то записал раньше — повторим
        else throw new Error(await apiError(res));
      }
      if (done) {
        // за время запроса пользователь мог что-то изменить — сливаем ещё раз
        const now = getData();
        const final = merge(now, merged);
        const changedLocally = stableStringify(final) !== stableStringify(merged);
        if (stableStringify(final) !== stableStringify(now)) replaceData(final);
        if (changedLocally) pending = true;
      }
    }
    if (!done) throw new Error('Не удалось записать изменения: конфликт версий');
    setStatus({ state: 'idle', last: Date.now(), error: '' });
  } catch (e) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    setStatus({ state: offline ? 'offline' : 'error', error: offline ? '' : e.message || String(e) });
  } finally {
    running = false;
    if (pending) {
      pending = false;
      schedule(800);
    }
  }
}

export function initSync() {
  setStatus({ state: isConfigured() ? 'idle' : 'off' });
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => schedule(200));
  window.addEventListener('offline', () => isConfigured() && setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(200);
  });
  schedule(100);
}
