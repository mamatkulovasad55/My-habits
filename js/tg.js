// Обёртка над Telegram Mini App API.
const W = () => window.Telegram?.WebApp;

export const inTelegram = () => Boolean(W()?.initData);
export const initData = () => W()?.initData || '';
/** Пользователь Telegram из initData (не сохраняется): { first_name, last_name, username, photo_url }. */
export const user = () => W()?.initDataUnsafe?.user || null;
export const colorScheme = () => W()?.colorScheme || null;

export function init({ onBack, onTheme } = {}) {
  const w = W();
  if (!w?.initData) return;
  try {
    w.ready();
    w.expand();
    w.disableVerticalSwipes?.();
    w.BackButton?.onClick(() => onBack?.());
    w.onEvent?.('themeChanged', () => onTheme?.());
    document.documentElement.classList.add('is-tg');
  } catch {
    /* старые версии Telegram */
  }
}

/** Цвета шапки и фона Telegram под тему приложения. */
export function setColors(dark) {
  const w = W();
  if (!w?.initData) return;
  const bg = dark ? '#000000' : '#F2F2F7';
  try {
    w.setHeaderColor?.(bg);
    w.setBackgroundColor?.(bg);
    w.setBottomBarColor?.(dark ? '#161618' : '#F9F9F9');
  } catch {
    /* ignore */
  }
}

export function backButton(visible) {
  const b = W()?.BackButton;
  if (!b) return;
  try {
    visible ? b.show() : b.hide();
  } catch {
    /* ignore */
  }
}

export function haptic(kind = 'light') {
  const h = W()?.HapticFeedback;
  if (!h) return false;
  try {
    if (kind === 'success') h.notificationOccurred('success');
    else if (kind === 'warning') h.notificationOccurred('warning');
    else h.impactOccurred(kind);
    return true;
  } catch {
    return false;
  }
}

/** Экран, с которого открыли приложение (например ?screen=checkin). */
export const startScreen = () => new URLSearchParams(location.search).get('screen') || W()?.initDataUnsafe?.start_param || '';

// ---------- Иконка на экране «Домой» (Bot API 8.0) ----------
// Android сообщает точный статус (added / missed); iOS всегда unknown: «Добавить» открывает Safari, иконку ставит
// сам пользователь, события homeScreenAdded нет. Desktop и Web — unsupported.

const HOME_STATUSES = new Set(['unsupported', 'unknown', 'added', 'missed']);

export function homeScreenSupported() {
  const w = W();
  try {
    return Boolean(w?.initData && typeof w.addToHomeScreen === 'function' && w.isVersionAtLeast?.('8.0'));
  } catch {
    return false;
  }
}

/** Статус иконки: 'unsupported' | 'unknown' | 'added' | 'missed'. Нет API, ошибка или нет ответа за timeout — 'unsupported'. */
export function homeScreenStatus(timeout = 3000) {
  const w = W();
  if (!homeScreenSupported() || typeof w.checkHomeScreenStatus !== 'function') return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('unsupported'), timeout);
    const done = (status) => {
      clearTimeout(timer);
      resolve(HOME_STATUSES.has(status) ? status : 'unsupported');
    };
    try {
      w.checkHomeScreenStatus(done);
    } catch {
      done('unsupported');
    }
  });
}

/**
 * Предложить добавить иконку. Вызывать прямо из обработчика нажатия (Android принимает запрос только в течение
 * 10 с после касания). onAdded — иконка добавлена, onFailed — пользователь отказался. → false, если вызвать не удалось.
 */
export function addToHomeScreen({ onAdded, onFailed } = {}) {
  const w = W();
  if (!homeScreenSupported()) return false;
  let off = () => {};
  try {
    const added = () => {
      off();
      onAdded?.();
    };
    const failed = () => {
      off();
      onFailed?.();
    };
    off = () => {
      w.offEvent?.('homeScreenAdded', added);
      w.offEvent?.('homeScreenFailed', failed);
    };
    w.onEvent?.('homeScreenAdded', added);
    w.onEvent?.('homeScreenFailed', failed);
    w.addToHomeScreen();
    return true;
  } catch {
    off();
    return false;
  }
}
