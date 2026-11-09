// Cloudflare Worker — сервер трекера My Habits для Telegram Mini App.
//  • /api/*  — API для Mini App: вход по подписи Telegram, синхронизация данных с приватным репозиторием.
//  • /tg     — вебхук бота: отвечает только на /start кнопкой «Открыть трекер».
//  • cron    — раз в минуту проверяет расписание и присылает напоминания сообщением от бота.
import { replaceData, merge } from '../js/store.js';
import { dueReminders } from '../js/schedule.js';
import { stableStringify } from '../js/util.js';
import { verifyInitData, webhookSecret, tg, escHtml, openButton } from './telegram.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
};

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- GitHub (приватный репозиторий с данными) ----------

function contentsUrl(env) {
  const path = (env.DATA_PATH || 'data.json').split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(env.DATA_OWNER)}/${encodeURIComponent(env.DATA_REPO || 'my-habits-data')}/contents/${path}`;
}

const ghHeaders = (env) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${env.DATA_TOKEN}`,
  'User-Agent': 'my-habits-worker',
  'X-GitHub-Api-Version': '2022-11-28',
});

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function getRemote(env) {
  const res = await fetch(contentsUrl(env), { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const j = await res.json();
  // файлы больше 1 МБ API отдаёт без content — тогда читаем через download_url
  if (!j.content && j.download_url) {
    const raw = await fetch(contentsUrl(env), { headers: { ...ghHeaders(env), Accept: 'application/vnd.github.raw+json' } });
    return { sha: j.sha, data: await raw.json() };
  }
  return { sha: j.sha, data: JSON.parse(fromBase64(j.content || '') || '{}') };
}

async function putRemote(env, data, sha) {
  const body = { message: `Обновление данных трекера · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, content: toBase64(stableStringify(data, 1) + '\n') };
  if (sha) body.sha = sha;
  return fetch(contentsUrl(env), { method: 'PUT', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Слить данные клиента с репозиторием и записать результат. */
async function syncData(env, clientData) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await getRemote(env);
    const merged = merge(remote ? remote.data : {}, clientData || {});
    if (remote && stableStringify(merge(remote.data, {})) === stableStringify(merged)) return merged;
    const res = await putRemote(env, merged, remote?.sha);
    if (res.ok) return merged;
    if (res.status === 409 || res.status === 422) continue;
    if (res.status === 403) throw new Error('У токена DATA_TOKEN нет права записи (Contents: Read and write)');
    throw new Error(`GitHub ${res.status}`);
  }
  throw new Error('Конфликт версий, попробуй ещё раз');
}

// ---------- Mini App API ----------

async function auth(req, env) {
  const user = await verifyInitData(req.headers.get('X-Init-Data'), env.BOT_TOKEN);
  if (!user?.id) return { error: json({ error: 'Открой трекер через Telegram', code: 'auth' }, 401) };
  const owner = await env.KV.get('owner');
  return { user, owner };
}

async function api(req, env, path) {
  if (path === '/api/info') {
    let bot = await env.KV.get('bot_username');
    if (!bot && env.BOT_TOKEN) {
      const me = await tg(env.BOT_TOKEN, 'getMe', {});
      bot = me?.result?.username || '';
      if (bot) await env.KV.put('bot_username', bot);
    }
    return json({ bot });
  }
  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  const { user, owner, error } = await auth(req, env);
  if (error) return error;
  let body = {};
  try {
    body = await req.json();
  } catch {
    /* пустое тело */
  }

  if (path === '/api/claim') {
    if (owner && owner !== String(user.id)) return json({ error: 'Этот трекер уже привязан к другому аккаунту', code: 'foreign' }, 403);
    if (!safeEqual(body.key, env.PUSH_KEY)) return json({ error: 'Неверный ключ подключения', code: 'key' }, 403);
    await env.KV.put('owner', String(user.id));
    return json({ ok: true });
  }

  if (!owner) return json({ error: 'Нужно подтвердить владельца', code: 'claim' }, 403);
  if (owner !== String(user.id)) return json({ error: 'Это личный трекер другого человека', code: 'foreign' }, 403);

  if (path === '/api/sync') {
    try {
      return json({ data: await syncData(env, body.data) });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }
  return json({ error: 'Not found' }, 404);
}

// ---------- Бот ----------

async function webhook(req, env) {
  if (!safeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), await webhookSecret(env.BOT_TOKEN))) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => ({}));
  const msg = update.message;
  if (msg?.chat?.type === 'private' && /^\/start\b/.test(msg.text || '')) {
    await tg(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'Привет! Это твой личный трекер привычек 🌱\n\nНажми «Открыть трекер» — всё происходит внутри приложения. Сюда я буду присылать только напоминания.',
      reply_markup: openButton(env.APP_URL),
    });
  }
  return new Response('ok');
}

// ---------- Напоминания ----------

function localNow(tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { date: new Date(+parts.year, +parts.month - 1, +parts.day), min: (+parts.hour % 24) * 60 + +parts.minute };
}

async function tick(env) {
  if (!env.DATA_TOKEN || !env.DATA_OWNER || !env.BOT_TOKEN) return;
  const owner = await env.KV.get('owner');
  if (!owner) return;
  const remote = await getRemote(env);
  if (!remote) return;
  replaceData(remote.data);
  const { date, min } = localNow(remote.data.settings?.tz);
  // окно в 3 минуты на случай задержки cron; повторы отсекаются по ключам
  const due = dueReminders(date, min - 3, min);
  if (!due.length) return;
  const dayKey = `sent:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const sent = new Set((await env.KV.get(dayKey, 'json')) || []);
  const fresh = due.filter((r) => !sent.has(r.key));
  if (!fresh.length) return;
  for (const r of fresh) {
    // Telegram передаёт параметры запуска в #хэше, поэтому экран указываем через ?query
    const url = r.url === './#checkin' ? `${env.APP_URL}?screen=checkin` : env.APP_URL;
    await tg(env.BOT_TOKEN, 'sendMessage', {
      chat_id: Number(owner),
      text: `<b>${escHtml(r.title)}</b>\n${escHtml(r.body)}`,
      parse_mode: 'HTML',
      reply_markup: openButton(url, r.url === './#checkin' ? 'Открыть чек-ин' : 'Открыть трекер'),
    });
    sent.add(r.key);
  }
  await env.KV.put(dayKey, JSON.stringify([...sent]), { expirationTtl: 3 * 86400 });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/tg' && req.method === 'POST') return webhook(req, env);
    if (url.pathname.startsWith('/api/')) return api(req, env, url.pathname);
    if (url.pathname === '/') return json({ ok: true, service: 'my-habits' });
    return json({ error: 'Not found' }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
