// Защита раздела «Детокс»: состояние блокировки (только в памяти), повторная блокировка и биометрия.
// Код проверяет сервер (/api/lock/*). Здесь нет ни кода, ни его хеша.
import { getData } from './store.js';
import { storageGet, storageSet, storageRemove } from './storage.js';

const BIO_KEY = 'myhabits:lock:bio:v1'; // «открывать по Face ID» — на этом устройстве
const RELOCK_MS = { now: 0, '1m': 60e3, '5m': 300e3 };

let unlocked = false; // в памяти: закрыли мини-апп — снова заблокировано
let leftAt = 0; // когда ушли с раздела или свернули приложение
const listeners = new Set();

export const protectedOn = () => getData().settings.privacy?.enabled === true;
export const isLocked = () => protectedOn() && !unlocked;
export const onLockChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => fn(isLocked()));

export function unlock() {
  unlocked = true;
  leftAt = 0;
  emit();
}

export function lockNow() {
  if (!unlocked) return;
  unlocked = false;
  leftAt = 0;
  emit();
}

/** Ушли с раздела или свернули приложение: «сразу» — блокируем, иначе запоминаем время. */
export function noteLeave(now = Date.now()) {
  if (!protectedOn() || !unlocked) return;
  const ms = RELOCK_MS[getData().settings.privacy?.relock] ?? 0;
  if (!ms) return lockNow();
  if (!leftAt) leftAt = now;
}

/** Вернулись: если прошло больше заданного — заблокировать. */
export function checkRelock(now = Date.now()) {
  if (!protectedOn() || !unlocked || !leftAt) return;
  const ms = RELOCK_MS[getData().settings.privacy?.relock] ?? 0;
  if (now - leftAt >= ms) lockNow();
}

/** Вернулись на раздел до истечения таймера — отсчёт заново при следующем уходе. */
export const noteReturn = () => (leftAt = 0);

// ---------- Биометрия (только iPhone — решение владельца) ----------

const W = () => window.Telegram?.WebApp;
const BM = () => {
  const w = W();
  try {
    return w?.platform === 'ios' && w?.isVersionAtLeast?.('7.2') && w.BiometricManager ? w.BiometricManager : null;
  } catch {
    return null;
  }
};

let bioState = { inited: false, available: false, type: 'unknown', granted: false, requested: false };
let initPromise = null;

/** Инициализировать BiometricManager один раз. */
export function bioInit() {
  if (initPromise) return initPromise;
  const bm = BM();
  if (!bm) return (initPromise = Promise.resolve(bioState));
  initPromise = new Promise((resolve) => {
    const done = () => {
      bioState = { inited: true, available: Boolean(bm.isBiometricAvailable), type: bm.biometricType || 'unknown', granted: Boolean(bm.isAccessGranted), requested: Boolean(bm.isAccessRequested) };
      resolve(bioState);
    };
    try {
      if (bm.isInited) done();
      else bm.init(done);
    } catch {
      resolve(bioState);
    }
    setTimeout(() => resolve(bioState), 3000); // клиент не ответил — без биометрии
  });
  return initPromise;
}

export const bio = () => bioState;
export const bioLabel = () => (bioState.type === 'face' ? 'Face ID' : bioState.type === 'finger' ? 'отпечаток' : 'биометрию');
export const bioEnabled = () => bioState.available && bioState.granted && storageGet(BIO_KEY) === '1';

export function setBioEnabled(on) {
  if (on) storageSet(BIO_KEY, '1');
  else storageRemove(BIO_KEY);
}

/** Запросить доступ к биометрии. → true, если разрешено. */
export function bioRequestAccess() {
  const bm = BM();
  if (!bm) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      bm.requestAccess({ reason: 'Чтобы открывать раздел «Детокс»' }, (granted) => {
        bioState = { ...bioState, granted: Boolean(granted), requested: true };
        resolve(Boolean(granted));
      });
    } catch {
      resolve(false);
    }
  });
}

/** Подтвердить биометрией. → true при успехе; отмена или ошибка — false. */
export function bioAuthenticate() {
  const bm = BM();
  if (!bm || !bioEnabled()) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      bm.authenticate({ reason: 'Открыть раздел «Детокс»' }, (ok) => resolve(Boolean(ok)));
    } catch {
      resolve(false);
    }
  });
}

/** Настройки биометрии в Telegram — только по нажатию пользователя. */
export function bioOpenSettings() {
  try {
    BM()?.openSettings();
  } catch {
    /* ignore */
  }
}
