// Telegram: проверка подписи Mini App (initData) и отправка сообщений ботом.

const enc = new TextEncoder();

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

/** Секрет вебхука, вычисляется из токена бота (тот же алгоритм в workflow). */
export const webhookSecret = async (botToken) => (await sha256hex(botToken)).slice(0, 40);

/**
 * Проверить initData Mini App. Возвращает объект пользователя или null.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function verifyInitData(initData, botToken, maxAgeSec = 7 * 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = await hmac('WebAppData', botToken);
  const sig = hex(await hmac(secret, check));
  if (sig.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff) return null;
  const authDate = Number(params.get('auth_date')) || 0;
  if (Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

export async function tg(botToken, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false }));
}

/** Отправить файл документом (multipart). */
export async function tgDocument(botToken, { chat_id, caption, filename, content, type = 'application/json' }) {
  const fd = new FormData();
  fd.append('chat_id', String(chat_id));
  if (caption) fd.append('caption', caption);
  fd.append('document', new Blob([content], { type }), filename);
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: fd });
  return res.json().catch(() => ({ ok: false }));
}

export const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Кнопка «Открыть трекер» под сообщением. */
export const openButton = (appUrl, text = 'Открыть трекер') => ({ inline_keyboard: [[{ text, web_app: { url: appUrl } }]] });
