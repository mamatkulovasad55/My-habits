// Код раздела «Детокс»: хеш, сравнение и лимит попыток. Чистые функции (тесты и Worker).
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
export async function hashCode(code, salt, botToken, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${code}:${await pepper(botToken)}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64(salt), iterations, hash: 'SHA-256' }, key, 256);
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
  const ok = sameString(await hashCode(code, rec.salt, botToken, Number(rec.iter) || ITERATIONS), rec.hash); // число итераций — из записи
  return { ok, rec: ok ? { ...rec, fails: 0, until: 0 } : afterFail(rec, now) };
}

// ---------- Durable Object: единственное хранилище кода ----------
// Один объект на весь мир (idFromName('lock')) со строго согласованным хранилищем: сброс кнопкой бота
// виден трекеру сразу, где бы ни выполнялся запрос (в KV старое значение могло жить в кэше до 60 с).
// Операции выполняются строго по очереди — параллельные попытки не обходят счётчик ошибок.

const lockState = (rec, now) => ({ hasCode: hasCode(rec), retryIn: hasCode(rec) ? retryIn(rec, now) : 0 });
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export class LockStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async fetch(req) {
    const body = await req.json().catch(() => ({}));
    const run = this.queue.then(() => this.handle(body || {}));
    this.queue = run.catch(() => {});
    const out = await run.catch((e) => ({ ok: false, error: e?.message || 'Ошибка хранилища', httpStatus: 503 }));
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  }

  /** Запись кода; при первом обращении — разовый перенос из KV (там код жил до этой версии). */
  async load() {
    const rec = await this.state.storage.get('rec');
    if (rec !== undefined) return rec || {};
    if (await this.state.storage.get('migrated')) return {};
    let old = null;
    try {
      old = await this.env?.KV?.get(LOCK_KEY, 'json');
    } catch {
      throw new Error('Хранилище временно недоступно, попробуй позже'); // не переносим, пока KV не ответит
    }
    const moved = old && typeof old === 'object' ? clean(old) : {};
    await this.state.storage.put({ rec: moved, migrated: true });
    return moved;
  }

  save(rec) {
    return this.state.storage.put('rec', clean(rec));
  }

  async handle({ op, code, current, nonce }) {
    const now = Date.now();
    const rec = await this.load();
    const bot = this.env?.BOT_TOKEN;
    // проверка текущего кода с лимитом попыток: null — верно, иначе ответ с ошибкой
    const check = async (c) => {
      if (retryIn(rec, now)) return { ok: false, reason: 'pause', ...lockState(rec, now), error: 'Подожди и попробуй снова' };
      const r = await checkCode(rec, c, bot, now);
      await this.save(r.ok ? { ...r.rec, nonce: undefined, nonceExp: undefined } : r.rec);
      return r.ok ? null : { ok: false, reason: 'wrong', ...lockState(r.rec, now), error: 'Неверный код' };
    };
    switch (op) {
      case 'status':
        return lockState(rec, now);
      case 'verify': {
        if (!hasCode(rec)) return { ok: false, reason: 'nocode', hasCode: false, retryIn: 0, error: 'Код не задан' };
        return (await check(code)) || { ok: true, hasCode: true, retryIn: 0 };
      }
      case 'set': {
        if (!validCode(code)) return { ok: false, reason: 'invalid', error: 'Код — 4 цифры' };
        if (hasCode(rec)) {
          const fail = await check(current);
          if (fail) return fail;
        }
        await this.save({ ...(await makeRecord(code, bot)), forgotAt: rec.forgotAt || 0 });
        return { ok: true, hasCode: true, retryIn: 0 };
      }
      case 'clear': {
        // выключение защиты или смена кода по биометрии: клиент уже подтвердил человека (защита на уровне интерфейса)
        if (retryIn(rec, now)) return { ok: false, reason: 'pause', ...lockState(rec, now), error: 'Подожди и попробуй снова' };
        await this.save({ forgotAt: rec.forgotAt || 0 });
        return { ok: true, hasCode: false, retryIn: 0 };
      }
      case 'forgot': {
        if (!hasCode(rec)) return { ok: true, hasCode: false };
        if (now - (Number(rec.forgotAt) || 0) < FORGOT_EVERY) return { ok: true, sent: false, error: 'Сообщение уже отправлено — проверь чат с ботом' };
        const n = randomB64(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
        await this.save({ ...rec, nonce: n, nonceExp: now + NONCE_TTL, forgotAt: now, prevForgotAt: rec.forgotAt || 0 });
        return { ok: true, nonce: n };
      }
      case 'forgotAbort': {
        // бот не смог отправить сообщение — ключ недействителен, лимит «раз в минуту» не расходуется
        if (rec.nonce && sameString(nonce, rec.nonce)) await this.save({ ...rec, nonce: undefined, nonceExp: undefined, forgotAt: rec.prevForgotAt || 0 });
        return { ok: true };
      }
      case 'reset': {
        const valid = rec.nonce && sameString(nonce, rec.nonce) && now < (Number(rec.nonceExp) || 0);
        if (!valid) return { ok: false };
        await this.save({ forgotAt: rec.forgotAt || 0 });
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Неизвестная операция', httpStatus: 400 };
    }
  }
}
