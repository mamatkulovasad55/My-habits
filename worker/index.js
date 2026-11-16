// Cloudflare Worker — сервер трекера My Habits для Telegram Mini App.
//  • /api/*  — API для Mini App: вход по подписи Telegram, синхронизация данных с приватным репозиторием.
//  • /tg     — вебхук бота: отвечает только на /start кнопкой «Открыть трекер».
//  • cron    — раз в минуту проверяет расписание и присылает напоминания сообщением от бота.
import { replaceData, merge } from '../js/store.js';
import { dueReminders } from '../js/schedule.js';
import { stableStringify, dkey, addDays, pad, plural } from '../js/util.js';
import { cityTz } from '../js/prayer.js';
export { LockStore } from './lock.js';
import { verifyInitData, webhookSecret, tg, tgDocument, escHtml, openButton } from './telegram.js';

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
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Только чтение данных (для cron): сразу «сырой» JSON, без base64 и без sha — дешевле по CPU. */
async function getRemoteRaw(env) {
  const res = await fetch(contentsUrl(env), { headers: { ...ghHeaders(env), Accept: 'application/vnd.github.raw+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return { data: await res.json() };
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
    // serverNow: метки настроек из будущего (часы устройства спешат) урезаются до времени сервера
    const merged = merge(remote ? remote.data : {}, clientData || {}, { serverNow: Date.now() });
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
  const owner = await getOwner(env);
  if (owner === undefined) return { error: json({ error: 'Хранилище временно недоступно, попробуй позже' }, 503) };
  return { user, owner };
}

async function api(req, env, path) {
  if (path === '/api/info') {
    let bot = await kvGet(env, 'bot_username');
    if (!bot && env.BOT_TOKEN) {
      const me = await tg(env.BOT_TOKEN, 'getMe', {});
      bot = me?.result?.username || '';
      if (bot && (await kvPut(env, 'bot_username', bot))) pendingWrites++;
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
    if (!(await kvPut(env, 'owner', String(user.id)))) return json({ error: 'Не удалось сохранить владельца, попробуй ещё раз' }, 503);
    pendingWrites++;
    ownerCache = String(user.id);
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
  if (path.startsWith('/api/lock/')) return lockApi(env, path, body, owner);
  if (path === '/api/backup') {
    // reason — автобэкап перед опасным действием (подпись в боте); data — текущие данные устройства:
    // сначала сливаются с репозиторием, в бэкап идёт результат (даже если обычная синхронизация не прошла)
    const reason = !body.reason ? '' : Object.hasOwn(BACKUP_REASONS, body.reason) ? BACKUP_REASONS[body.reason] : undefined;
    if (reason === undefined) return json({ error: 'Неизвестная причина бэкапа' }, 400);
    try {
      let data;
      if (body.data && typeof body.data === 'object') data = await syncData(env, body.data);
      else data = (await getRemoteRaw(env))?.data;
      if (!data) return json({ error: 'Данных пока нет' }, 404);
      const r = await sendBackup(env, owner, data, undefined, reason);
      if (!r.ok) return json({ error: 'Telegram не принял файл, попробуй позже' }, 502);
      const at = Date.now();
      await noteBackup(env, 'bot', at);
      return json({ ok: true, events: r.events, at });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }
  return json({ error: 'Not found' }, 404);
}

// ---------- Код раздела «Воздержание» ----------
// Код, счётчик ошибок и ключ сброса живут в Durable Object LockStore (worker/lock.js): строго согласованное
// хранилище, сброс кнопкой бота виден трекеру сразу. Код приходит только в теле запроса и никуда не пишется.

async function lockOp(env, op, extra = {}) {
  if (!env.LOCK) throw new Error('Хранилище кода не настроено');
  const stub = env.LOCK.get(env.LOCK.idFromName('lock'));
  const res = await stub.fetch('https://lock/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, ...extra }) });
  return res.json();
}

const lockJson = ({ httpStatus, nonce, ...out }) => json(out, httpStatus || 200); // ключ сброса клиенту не отдаём

async function lockApi(env, path, body, owner) {
  try {
    const op = path.slice('/api/lock/'.length);
    if (op === 'status') return lockJson(await lockOp(env, 'status'));
    if (op === 'verify') return lockJson(await lockOp(env, 'verify', { code: body.code }));
    if (op === 'set') return lockJson(await lockOp(env, 'set', { code: body.code, current: body.current }));
    if (op === 'clear') return lockJson(await lockOp(env, 'clear'));
    if (op === 'forgot') {
      const r = await lockOp(env, 'forgot');
      if (!r.nonce) return lockJson(r);
      const sent = await sendTg(env, 'sendMessage', {
        chat_id: Number(owner),
        text: 'Сбросить код защищённого раздела трекера? Данные останутся на месте, при следующем входе нужно будет задать новый код.',
        reply_markup: { inline_keyboard: [[{ text: 'Сбросить код', callback_data: `lockreset:${r.nonce}` }]] },
      });
      if (!sent) {
        await lockOp(env, 'forgotAbort', { nonce: r.nonce });
        return json({ ok: false, error: 'Бот не смог отправить сообщение, попробуй позже' }, 502);
      }
      return json({ ok: true, sent: true });
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ ok: false, error: e.message || 'Ошибка сервера' }, 503);
  }
}

/** Нажатие «Сбросить код» в сообщении бота. */
async function lockResetCallback(env, cq) {
  const answer = (text) => sendTg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  const owner = await getOwner(env);
  if (!owner || String(cq.from?.id) !== owner) return answer('Ссылка устарела');
  let r;
  try {
    r = await lockOp(env, 'reset', { nonce: String(cq.data || '').slice('lockreset:'.length) });
  } catch {
    return answer('Не получилось, попробуй ещё раз');
  }
  if (!r.ok) return answer('Ссылка устарела');
  await answer('Код сброшен');
  if (cq.message) {
    await sendTg(env, 'editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: 'Код сброшен. Открой трекер и задай новый — данные на месте.',
      reply_markup: openButton(env.APP_URL),
    });
  }
}

// ---------- Бот ----------

async function webhook(req, env) {
  if (!safeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), await webhookSecret(env.BOT_TOKEN))) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => ({}));
  if (update.callback_query && /^lockreset:/.test(update.callback_query.data || '')) {
    await lockResetCallback(env, update.callback_query);
    return new Response('ok');
  }
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

// ---------- KV: экономные записи и защита от ошибок ----------
// Бесплатный тариф: 1000 записей в сутки (UTC). Всё состояние cron лежит в одном ключе `state`
// и пишется только когда реально что-то отправлено. Счётчик записей едет в той же записи.

const STATE_KEY = 'state';
const KV_WARN_AT = 800;
const utcDay = () => new Date().toISOString().slice(0, 10);
let pendingWrites = 0; // редкие записи вне state (owner, bot_username) — учтутся при следующей записи state
let ownerCache = null; // на случай сбоя чтения KV в «тёплом» экземпляре

async function kvGet(env, key, type) {
  try {
    return await env.KV.get(key, type);
  } catch (e) {
    console.error('KV get failed', key, e?.message);
    return undefined; // undefined = ошибка, null = ключа нет
  }
}

async function kvPut(env, key, value, opts) {
  try {
    await env.KV.put(key, value, opts);
    return true;
  } catch (e) {
    console.error('KV put failed', key, e?.message);
    return false;
  }
}

async function getOwner(env) {
  const v = await kvGet(env, 'owner');
  if (v === undefined) return ownerCache ?? undefined; // undefined — KV недоступно
  ownerCache = v;
  return v;
}

/** Состояние напоминаний: отправленные ключи за сегодня и вчера, счётчик записей KV, дата бэкапа. */
async function loadState(env, day) {
  let raw = await kvGet(env, STATE_KEY, 'json');
  const failed = raw === undefined;
  if (raw == null && !failed) {
    // переход со старого формата `sent:Y-M-D`
    const [y, m, d] = day.split('-').map(Number);
    const legacy = await kvGet(env, `sent:${y}-${m}-${d}`, 'json');
    raw = { day, sent: Array.isArray(legacy) ? legacy : [] };
  }
  raw = raw && typeof raw === 'object' ? raw : {};
  const sameDay = raw.day === day;
  const state = {
    day,
    sent: sameDay && Array.isArray(raw.sent) ? raw.sent : [],
    prev: sameDay ? (Array.isArray(raw.prev) ? raw.prev : []) : Array.isArray(raw.sent) ? raw.sent : [],
    kv: raw.kv && typeof raw.kv === 'object' ? raw.kv : { d: utcDay(), n: 0, warned: false },
    backup: raw.backup || '',
    failed,
  };
  state.has = (k) => state.sent.includes(k) || state.prev.includes(k);
  return state;
}

/** Записать состояние (одна запись KV) и при необходимости предупредить о расходе. */
async function saveState(env, state, owner) {
  if (state.failed) return false; // не смогли прочитать — не затираем настоящее состояние
  const d = utcDay();
  if (state.kv.d !== d) state.kv = { d, n: 0, warned: false };
  state.kv.n += 1 + pendingWrites;
  if (state.kv.n >= KV_WARN_AT && !state.kv.warned && owner) {
    if (await sendTg(env, 'sendMessage', { chat_id: Number(owner), text: `KV: ${KV_WARN_AT}/1000 записей за сутки` })) state.kv.warned = true;
  }
  const { day, sent, prev, kv, backup } = state;
  const ok = await kvPut(env, STATE_KEY, JSON.stringify({ day, sent, prev, kv, backup }));
  if (ok) pendingWrites = 0;
  return ok;
}

/** Вызов Telegram, который никогда не бросает исключение. true — Telegram подтвердил. */
async function sendTg(env, method, body) {
  try {
    const r = await tg(env.BOT_TOKEN, method, body);
    if (!r?.ok) console.error('Telegram', method, r?.error_code, r?.description);
    return !!r?.ok;
  } catch (e) {
    console.error('Telegram', method, e?.message);
    return false;
  }
}

// ---------- Бэкап ----------

const BACKUP_WEEKDAY = 0; // воскресенье
const BACKUP_AT = 21 * 60; // 21:00 по местному времени (settings.tz)
let backupSentDay = ''; // защита от повторов, если запись состояния в KV не удалась

/** Число событий в журнале (старые записи без ev считаются одним событием). */
function countEvents(data) {
  let n = 0;
  for (const days of Object.values(data?.logs || {})) {
    for (const e of Object.values(days || {})) n += Array.isArray(e?.ev) ? e.ev.length : e?.v ? 1 : 0;
  }
  return n;
}

/** Подписи автобэкапа перед опасным действием (другие причины сервер не принимает). */
const BACKUP_REASONS = { reset: 'Перед сбросом прогресса', wipe: 'Перед удалением', import: 'Перед импортом' };

/** Записать время бэкапа в данные (data.backupLog), чтобы его видели все устройства. Ошибка не мешает бэкапу. */
async function noteBackup(env, kind, at) {
  try {
    const remote = await getRemoteRaw(env);
    if (remote) await syncData(env, { ...remote.data, backupLog: { ...(remote.data.backupLog || {}), [kind]: at } });
  } catch (e) {
    console.error('backupLog', e?.message);
  }
}

/** Прислать data.json владельцу документом. date — местная дата для имени и подписи, reason — подпись автобэкапа. */
async function sendBackup(env, owner, data, date = localNow(effectiveTz(data?.settings)).date, reason = '') {
  const events = countEvents(data);
  const day = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  let ok = false;
  try {
    const r = await tgDocument(env.BOT_TOKEN, {
      chat_id: Number(owner),
      caption: `${reason ? `${reason} · ` : ''}Бэкап · ${day} · ${events.toLocaleString('ru-RU')} ${plural(events, ['событие', 'события', 'событий'])}`,
      filename: `data-${dkey(date)}.json`,
      content: stableStringify(data, 1) + '\n',
    });
    ok = !!r?.ok;
    if (!ok) console.error('Telegram sendDocument', r?.error_code, r?.description);
  } catch (e) {
    console.error('Telegram sendDocument', e?.message);
  }
  return { ok, events };
}

// ---------- Напоминания ----------

const NOW_FMT = new Map();

function zoneFormat(tz) {
  if (!NOW_FMT.has(tz)) NOW_FMT.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  return NOW_FMT.get(tz);
}

/**
 * Пояс, по которому считает бот. Если пояс из настроек среде неизвестен (выбран вручную на телефоне с более
 * новым списком поясов, повреждённые данные) — берём пояс города, затем UTC: напоминания не должны пропасть.
 */
function effectiveTz(settings) {
  for (const tz of [settings?.tz, cityTz({ prayer: settings?.prayer })]) {
    if (!tz) continue;
    try {
      zoneFormat(tz);
      return tz;
    } catch {
      console.error('Unknown time zone', tz);
    }
  }
  return 'UTC';
}

/** Местные дата и минута в поясе tz (он уже проверен effectiveTz). */
function localNow(tz) {
  const parts = Object.fromEntries(zoneFormat(tz).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: new Date(+parts.year, +parts.month - 1, +parts.day), min: (+parts.hour % 24) * 60 + +parts.minute };
}

/**
 * Пользователи, которым cron рассылает напоминания. Сейчас — один владелец (owner в KV, data.json из DATA_PATH).
 * Заготовка под нескольких пользователей: хранение не меняется, но рассылка уже идёт циклом.
 */
async function listUsers(env) {
  const owner = await getOwner(env);
  return owner ? [{ chatId: owner, dataPath: env.DATA_PATH || 'data.json' }] : [];
}

async function tick(env) {
  if (!env.DATA_TOKEN || !env.DATA_OWNER || !env.BOT_TOKEN) return;
  for (const user of await listUsers(env)) {
    try {
      await tickUser(env, user);
    } catch (e) {
      console.error('tick failed for user', e?.message); // ошибка одного не мешает остальным
    }
  }
}

async function tickUser(env, user) {
  const owner = user.chatId;
  const remote = await getRemoteRaw(env);
  if (!remote) return;
  // расчёт времени намаза и «сейчас» — в одном и том же поясе (в сам файл данных замена не попадает)
  const st = remote.data.settings;
  const tz = effectiveTz(st);
  replaceData(tz === st?.tz ? remote.data : { ...remote.data, settings: { ...st, tz } });
  const { date, min } = localNow(tz);
  // окно в 3 минуты на случай задержки cron; повторы отсекаются по ключам
  const due = dueReminders(date, min - 3, min);
  // вчерашний день: хвост через полночь и этапы, чьё время длится до утра (утренний повтор про Ишу)
  if (min < 720) due.push(...dueReminders(addDays(date, -1), 1440 + min - 3, 1440 + min));
  // еженедельный бэкап: воскресенье с 21:00 до конца дня (догоняет, если cron пропустил минуту)
  // при включённой защите «Детокса» файл с данными в чат автоматически не отправляется (его нельзя закрыть кодом);
  // выключенный в «Профиле → Данные» еженедельный бэкап — тоже
  const weeklyOn = st?.backup?.weekly !== false && !st?.privacy?.enabled;
  const backupDay = date.getDay() === BACKUP_WEEKDAY && min >= BACKUP_AT && weeklyOn ? dkey(date) : '';
  if (!due.length && !backupDay) return;
  const state = await loadState(env, dkey(date));
  const fresh = due.filter((r) => !state.has(r.key));
  const needBackup = backupDay && state.backup !== backupDay && backupSentDay !== backupDay && !state.failed;
  if (!fresh.length && !needBackup) return;
  let changed = false;
  if (needBackup && (await sendBackup(env, owner, remote.data, date)).ok) {
    state.backup = backupSentDay = backupDay;
    changed = true;
  }
  for (const r of fresh) {
    // Telegram передаёт параметры запуска в #хэше, поэтому экран указываем через ?query
    const url = r.url === './#checkin' ? `${env.APP_URL}?screen=checkin` : env.APP_URL;
    const ok = await sendTg(env, 'sendMessage', {
      chat_id: Number(owner),
      text: `<b>${escHtml(r.title)}</b>\n${escHtml(r.body)}`,
      parse_mode: 'HTML',
      reply_markup: openButton(url, r.url === './#checkin' ? 'Открыть чек-ин' : 'Открыть трекер'),
    });
    if (ok) {
      state.sent.push(r.key);
      changed = true;
    }
  }
  if (changed) await saveState(env, state, owner);
  // время бэкапа — в данные (после записи состояния: зависший GitHub не должен привести к повторной отправке)
  if (state.backup === backupDay && needBackup) await noteBackup(env, 'weekly', Date.now());
}

async function runTick(env) {
  try {
    await tick(env);
  } catch (e) {
    console.error('tick failed', e?.message);
  }
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
    ctx.waitUntil(runTick(env));
  },
};
