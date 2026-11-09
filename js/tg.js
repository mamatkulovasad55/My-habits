// Обёртка над Telegram Mini App API.
const W = () => window.Telegram?.WebApp;

export const inTelegram = () => Boolean(W()?.initData);
export const initData = () => W()?.initData || '';
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
