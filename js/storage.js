// Единственное место, где приложение обращается к localStorage.
// Любая ошибка записи (переполнение, приватный режим, запрет доступа) ловится здесь,
// а приложение узнаёт только о смене состояния: «запись перестала работать» / «снова работает».
// Если localStorage нет вовсе (бот на Cloudflare, тесты в Node) — запись тихо пропускается, это не сбой.

let failed = null; // null — сбоя нет; иначе { name, message, at }
const listeners = new Set();

const ls = () => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
  } catch (e) {
    return e; // доступ к хранилищу запрещён (SecurityError) — это сбой записи
  }
};

function setStatus(next) {
  if (Boolean(next) === Boolean(failed)) return;
  failed = next;
  if (next) console.warn('localStorage: запись не удалась —', next.name, next.message);
  listeners.forEach((fn) => {
    try {
      fn(failed);
    } catch (e) {
      console.error(e);
    }
  });
}

/** Выполнить запись; true — получилось (или хранилища нет вовсе). */
function write(op) {
  const s = ls();
  if (s === undefined) return true;
  try {
    if (s instanceof Error) throw s;
    op(s);
    setStatus(null);
    return true;
  } catch (e) {
    setStatus({ name: e?.name || 'Error', message: e?.message || String(e), at: Date.now() });
    return false;
  }
}

/** Прочитать строку; null — нет значения или хранилище недоступно. */
export function storageGet(key) {
  const s = ls();
  if (!s || s instanceof Error) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

export const storageSet = (key, value) => write((s) => s.setItem(key, String(value)));
export const storageRemove = (key) => write((s) => s.removeItem(key));

/** Объект с интерфейсом Storage поверх обёртки (для счётчика зикров). */
export const storage = { getItem: storageGet, setItem: storageSet, removeItem: storageRemove };

/** Текущий сбой записи или null. */
export const storageFailed = () => failed;

/** Подписка на смену состояния: fn(failed | null). Вызывается только при переходе. */
export function onStorageStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
