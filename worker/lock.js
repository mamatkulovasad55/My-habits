// Код раздела «Воздержание»: хеш, сравнение и лимит попыток. Чистые функции (тесты и Worker).
// Код хранится только в KV (ключ `lock`) в виде PBKDF2-хеша с солью и «перцем» из токена бота —
// без токена перебор украденного хеша бесполезен. Сам код нигде не сохраняется и не логируется.

const enc = new TextEncoder();
export const LOCK_KEY = 'lock';
export const ITERATIONS = 20000; // ~3 мс CPU: укладывается в лимит бесплатного тарифа Cloudflare
const PAUSES = [30, 60, 300, 900]; // секунды: 5-я ошибка подряд → 30 с, затем 1, 5, 15 мин (и дальше по 15)
const FREE_TRIES = 4;
export const NONCE_TTL = 15 * 60 * 1000; // кнопка «Сбросить код» действует 15 минут
export const FORGOT_EVERY = 60 * 1000; // не чаще раза в минуту

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const validCode = (code) => typeof code === 'string' && /^\d{4}$/.test(code);

export function randomB64(n = 16) {
  return b64(crypto.getRandomValues(new Uint8Array(n)));
}

async function pepper(botToken) {
  const k = await crypto.subtle.importKey('raw', enc.encode(String(botToken || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('lock-pepper'))));
}

/** PBKDF2-SHA256(code + перец, соль) → base64. */
export async function hashCode(code, salt, botToken) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${code}:${await pepper(botToken)}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return b64(new Uint8Array(bits));
}

/** Сравнение строк за постоянное время. */
export function sameString(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Новая запись с кодом (счётчик ошибок обнулён). */
export async function makeRecord(code, botToken) {
  const salt = randomB64(16);
  return { salt, hash: await hashCode(code, salt, botToken), iter: ITERATIONS, fails: 0, until: 0 };
}

export const hasCode = (rec) => Boolean(rec?.hash && rec?.salt);

/** Сколько секунд осталось до конца паузы (0 — можно вводить). */
export const retryIn = (rec, now) => Math.max(0, Math.ceil(((Number(rec?.until) || 0) - now) / 1000));

/** Неверный код: счётчик и пауза. Возвращает обновлённую запись. */
export function afterFail(rec, now) {
  const fails = (Number(rec.fails) || 0) + 1;
  const step = fails - FREE_TRIES - 1; // 5-я ошибка → 0
  const until = step >= 0 ? now + PAUSES[Math.min(step, PAUSES.length - 1)] * 1000 : 0;
  return { ...rec, fails, until };
}

/** Проверить код. Возвращает { ok, rec } — rec нужно сохранить. */
export async function checkCode(rec, code, botToken, now) {
  if (!hasCode(rec) || !validCode(code)) return { ok: false, rec: hasCode(rec) ? afterFail(rec, now) : rec };
  const ok = sameString(await hashCode(code, rec.salt, botToken), rec.hash);
  return { ok, rec: ok ? { ...rec, fails: 0, until: 0 } : afterFail(rec, now) };
}
