// Cloudflare Worker: сервер напоминаний для My Habits.
// Раз в минуту читает data.json из приватного репозитория и отправляет Web Push,
// если наступило время этапа/напоминания и он ещё не отмечен.
import { replaceData } from '../js/store.js';
import { dueReminders } from '../js/schedule.js';
import { generateVapid, sendPush } from './webpush.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

async function getVapid(env) {
  let v = await env.KV.get('vapid', 'json');
  if (!v) {
    v = await generateVapid();
    await env.KV.put('vapid', JSON.stringify(v));
  }
  return v;
}

const getSubs = async (env) => (await env.KV.get('subs', 'json')) || [];
const putSubs = (env, subs) => env.KV.put('subs', JSON.stringify(subs));

async function loadData(env) {
  const path = (env.DATA_PATH || 'data.json').split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(env.DATA_OWNER)}/${encodeURIComponent(env.DATA_REPO || 'my-habits-data')}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${env.DATA_TOKEN}`,
      'User-Agent': 'my-habits-push',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

/** Местные дата и минута в часовом поясе пользователя. */
function localNow(tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { date: new Date(+parts.year, +parts.month - 1, +parts.day), min: (+parts.hour % 24) * 60 + +parts.minute };
}

async function broadcast(env, message) {
  const vapid = await getVapid(env);
  const subs = await getSubs(env);
  let sent = 0;
  const alive = [];
  for (const s of subs) {
    try {
      const status = await sendPush(s.subscription, message, vapid, env.SUBJECT || 'https://github.com');
      if (status === 404 || status === 410) continue; // подписка больше не действует
      if (status < 300) sent++;
      alive.push(s);
    } catch {
      alive.push(s);
    }
  }
  if (alive.length !== subs.length) await putSubs(env, alive);
  return sent;
}

async function tick(env) {
  if (!env.DATA_TOKEN || !env.DATA_OWNER) return;
  const subs = await getSubs(env);
  if (!subs.length) return;
  const data = await loadData(env);
  replaceData(data);
  const { date, min } = localNow(data.settings?.tz);
  // окно в 3 минуты на случай задержки cron; повторы отсекаются по ключам
  const due = dueReminders(date, min - 3, min);
  if (!due.length) return;
  const dayKey = `sent:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const sent = new Set((await env.KV.get(dayKey, 'json')) || []);
  const fresh = due.filter((r) => !sent.has(r.key));
  if (!fresh.length) return;
  for (const r of fresh) {
    await broadcast(env, { title: r.title, body: r.body, url: r.url, tag: r.key });
    sent.add(r.key);
  }
  await env.KV.put(dayKey, JSON.stringify([...sent]), { expirationTtl: 3 * 86400 });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'my-habits-push' });
    if (req.method === 'GET' && url.pathname === '/vapid') return json({ publicKey: (await getVapid(env)).publicKey });
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);

    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Неверный запрос' }, 400);
    }
    if (!safeEqual(body.key, env.PUSH_KEY)) return json({ error: 'Неверный ключ подключения' }, 403);

    if (url.pathname === '/subscribe') {
      const s = body.subscription;
      if (!s?.endpoint?.startsWith('https://') || !s.keys?.p256dh || !s.keys?.auth) return json({ error: 'Неверная подписка' }, 400);
      const subs = (await getSubs(env)).filter((x) => x.subscription.endpoint !== s.endpoint);
      subs.push({ subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, device: String(body.device || '').slice(0, 30), at: Date.now() });
      await putSubs(env, subs.slice(-10));
      return json({ ok: true, devices: subs.length });
    }
    if (url.pathname === '/unsubscribe') {
      const subs = (await getSubs(env)).filter((x) => x.subscription.endpoint !== body.endpoint);
      await putSubs(env, subs);
      return json({ ok: true });
    }
    if (url.pathname === '/test') {
      const sent = await broadcast(env, { title: '✅ My Habits', body: 'Уведомления работают! Напоминания будут приходить в нужное время.', url: './#today', tag: 'test' });
      let data = 'ok';
      try {
        await loadData(env);
      } catch (e) {
        data = e.message;
      }
      return json({ ok: true, sent, data });
    }
    return json({ error: 'Not found' }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
