// Состояние приложения: локальный кэш в localStorage + слияние для синхронизации.
import { uid } from './util.js';
import { migrate, SCHEMA_VERSION } from './migrate.js';
import { storageGet, storageSet } from './storage.js';
import { materialize, stampChanges, stampAll, mergeSettings, adoptStamps } from './settings-merge.js';

const DATA_KEY = 'myhabits:data:v1';
const LOCAL_KEY = 'myhabits:local:v1'; // данные, привязанные к устройству (запущенные таймеры)

export function defaultSettings() {
  return {
    theme: 'system',
    updatedAt: 0,
    tz: '',
    tzAuto: true, // часовой пояс по городу (иначе — tz, выбранный вручную)
    profile: { niyyah: '' }, // «обо мне»: ниййа (до 300 символов)
    privacy: { enabled: false, relock: 'now' }, // защита раздела «Воздержание»: код — только на сервере
    wakeWd: '07:00',
    sleepWd: '23:00',
    wakeWe: '08:00',
    sleepWe: '23:30',
    quiet: { enabled: true, from: '23:00', to: '07:00' },
    repeatMin: 30,
    checkin: { enabled: true, time: '21:30' },
    prayer: {
      city: 'Ташкент',
      lat: 41.2995,
      lon: 69.2401,
      fajrAngle: 15,
      ishaAngle: 15,
      asr: 'hanafi',
      adj: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
    },
    push: { workerUrl: '' },
    juma: { enabled: true, time: '13:00', lead: 45 },
    qada: { since: '', vitrSince: '', perDay: 2, old: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0, vitr: 0 } },
    hijri: { offsets: [] }, // сдвиги месяцев по объявлению УМУ: [{ y, m, offset }]
    // запретное время для восполнения (минуты): после восхода, до Зухра (зенит), до Магриба (закат)
    forbidden: { sunrise: 15, zenith: 10, sunset: 15 },
    // порядок восполнения (сахиб ат-тартиб); limit/countVitr — уточняются у имама
    tartib: { enabled: false, limit: 6, countOld: false, countVitr: true, asked: false },
    dhikr: { target: 33, haptics: true, last: 'subhanallah', favorites: [] }, // счётчик зикров: цель (0 — без цели), вибрация, последний зикр
    backup: { weekly: true }, // еженедельный бэкап в бота (воскресенье 21:00)
  };
}

export function emptyData() {
  return {
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: 0,
    habits: [],
    logs: {},
    abstain: [],
    notes: {},
    settings: normalizeSettings(undefined), // значения по умолчанию с метками 0
    achievements: [],
    backupLog: {},
  };
}

function normalizeSettings(raw) {
  const d = defaultSettings();
  const s = raw && typeof raw === 'object' ? raw : {};
  // метки полей (settings._t) — см. settings-merge.js
  return materialize(s, {
    ...d,
    ...s,
    quiet: { ...d.quiet, ...(s.quiet || {}) },
    checkin: { ...d.checkin, ...(s.checkin || {}) },
    prayer: { ...d.prayer, ...(s.prayer || {}), adj: { ...d.prayer.adj, ...(s.prayer?.adj || {}) } },
    push: { ...d.push, ...(s.push || {}) },
    juma: { ...d.juma, ...(s.juma || {}) },
    qada: { ...d.qada, ...(s.qada || {}), old: { ...d.qada.old, ...(s.qada?.old || {}) } },
    hijri: { ...d.hijri, ...(s.hijri || {}), offsets: Array.isArray(s.hijri?.offsets) ? s.hijri.offsets : [] },
    forbidden: { ...d.forbidden, ...(s.forbidden || {}) },
    tartib: { ...d.tartib, ...(s.tartib || {}) },
    dhikr: { ...d.dhikr, ...(s.dhikr || {}) },
    profile: { ...d.profile, ...(s.profile || {}) },
    privacy: { ...d.privacy, ...(s.privacy || {}) },
    backup: { ...d.backup, ...(s.backup || {}) },
  }, d);
}

// Поля верхнего уровня, которые этот код понимает. Остальные (разделы из будущих версий) сохраняются как есть.
const KNOWN_KEYS = new Set(['version', 'schemaVersion', 'updatedAt', 'resetAt', 'habits', 'logs', 'abstain', 'notes', 'settings', 'achievements', 'backupLog']);

// ---------- Журнал бэкапов ----------
// data.backupLog = { bot, weekly, export } — время последнего бэкапа каждого вида (мс). Не настройка:
// импорт старого файла не откатывает дату назад, при слиянии по каждому виду берётся самое позднее.
export const BACKUP_KINDS = ['bot', 'weekly', 'export'];

function normalizeBackupLog(raw) {
  const out = {};
  for (const k of BACKUP_KINDS) if (Number(raw?.[k]) > 0) out[k] = Number(raw[k]);
  return out;
}

export function mergeBackupLog(a = {}, b = {}) {
  const out = {};
  for (const k of BACKUP_KINDS) {
    const v = Math.max(Number(a[k]) || 0, Number(b[k]) || 0);
    if (v) out[k] = v;
  }
  return out;
}

/** Самый поздний бэкап: { at, kind } или null. */
export function lastBackup(log) {
  let best = null;
  for (const k of BACKUP_KINDS) if (Number(log?.[k]) > (best?.at || 0)) best = { at: Number(log[k]), kind: k };
  return best;
}

export function normalize(d) {
  const e = emptyData();
  if (!d || typeof d !== 'object' || Array.isArray(d)) return e;
  d = migrate(d);
  return {
    ...d,
    version: 1,
    schemaVersion: Number(d.schemaVersion) || SCHEMA_VERSION,
    updatedAt: Number(d.updatedAt) || 0,
    resetAt: Number(d.resetAt) || 0, // метка «Удалить все данные»: журнал и заметки старше неё отбрасываются при слиянии
    habits: Array.isArray(d.habits) ? d.habits : [],
    logs: d.logs && typeof d.logs === 'object' ? d.logs : {},
    abstain: Array.isArray(d.abstain) ? d.abstain : [],
    notes: d.notes && typeof d.notes === 'object' ? d.notes : {},
    settings: normalizeSettings(d.settings),
    achievements: normalizeAchievements(d.achievements),
    backupLog: normalizeBackupLog(d.backupLog),
  };
}

// ---------- Достижения ----------
// data.achievements = [{ id, earnedAt: 'YYYY-MM-DD', at }] — earnedAt фактическая дата, at — когда запись сделана
// (нужно для «Удалить все данные»: записи старше сброса отбрасываются). Однажды полученное не удаляется.

function normalizeAchievements(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(x.earnedAt)))
    .map((x) => ({ ...x, at: Number(x.at) || 0 }));
}

/** Объединить списки: по id, самая ранняя дата получения, записи старше сброса — прочь. */
export function mergeAchievements(a = [], b = [], resetAt = 0) {
  const map = new Map();
  for (const x of [...a, ...b]) {
    if ((x.at || 0) < resetAt) continue;
    const cur = map.get(x.id);
    if (!cur) map.set(x.id, { ...x });
    else map.set(x.id, { ...cur, ...x, earnedAt: x.earnedAt < cur.earnedAt ? x.earnedAt : cur.earnedAt, at: Math.max(cur.at || 0, x.at || 0) });
  }
  return [...map.values()].sort((x, y) => (x.earnedAt < y.earnedAt ? -1 : x.earnedAt > y.earnedAt ? 1 : x.id < y.id ? -1 : 1));
}

/** Добавить новые значки (уже полученные не трогаются). Возвращает добавленные. */
export function awardAchievements(list, now = Date.now()) {
  const have = new Set(data.achievements.map((x) => x.id));
  const fresh = list.filter((x) => !have.has(x.id)).map((x) => ({ id: x.id, earnedAt: x.earnedAt, at: now }));
  if (fresh.length) update((d) => (d.achievements = mergeAchievements(d.achievements, fresh)));
  return fresh;
}

// ---------- Журнал отметок ----------
// Запись дня: { v, t, ev: [{ id, ts, d, s, k }] }.
// ev — события (d — изменение значения, s — id этапа, ts — время нажатия, k — вид отметки).
// Событие хранится целиком: неизвестные поля и значения k из новых версий не теряются при слиянии.
// Старые записи без ev хранят только v.

/** События записи; старое значение превращается в одно «наследованное» событие. */
export function entryEvents(e) {
  if (!e) return [];
  if (Array.isArray(e.ev)) return e.ev;
  return e.v ? [{ id: `L${e.t || 0}`, ts: e.t || 0, d: e.v }] : [];
}

export const entryValue = (e) => (!e ? 0 : Array.isArray(e.ev) ? e.ev.reduce((s, x) => s + (x.d || 0), 0) : e.v || 0);

function mergeEntry(x, y) {
  if (!x) return y;
  if (!y) return x;
  if (!Array.isArray(x.ev) && !Array.isArray(y.ev)) return (y.t || 0) > (x.t || 0) ? y : x;
  const map = new Map();
  for (const ev of [...entryEvents(x), ...entryEvents(y)]) {
    const cur = map.get(ev.id);
    // одно и то же событие с двух сторон: оставляем восстановленное из бэкапа (r), иначе оно пропадёт после сброса
    if (!cur || (ev.r || 0) >= (cur.r || 0)) map.set(ev.id, ev);
  }
  const ev = [...map.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  const out = { ev, t: Math.max(x.t || 0, y.t || 0) };
  out.v = entryValue(out);
  return out;
}

// ---------- Слияние двух версий (локальной и из GitHub) ----------

function mergeEntities(a = [], b = []) {
  const map = new Map();
  for (const x of a) map.set(x.id, x);
  for (const y of b) {
    const x = map.get(y.id);
    if (!x || (y.updatedAt || 0) > (x.updatedAt || 0)) map.set(y.id, y);
  }
  return [...map.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
}

// ---------- Детокс: слияние с учётом «Сбросить прогресс» ----------
// История детокса (startedAt, attempts, cleanDays) лежит внутри записи, а запись сливается целиком по updatedAt.
// Сброс прогресса ставит записи pAt (время) и pDay (местный день). Если победила версия, не знающая о более
// позднем сбросе (её правили на отстающем устройстве), её история обрезается до момента сброса.
// rAt — запись восстановлена из бэкапа после сброса: её история не обрезается.

/** История детокса, обрезанная по сбросу (at, day). */
export function clampAbstain(x, at, day) {
  const startedAt = Math.max(Number(x.startedAt) || 0, at);
  const attempts = (Array.isArray(x.attempts) ? x.attempts : []).filter((t) => (t.end || 0) >= at).map((t) => ({ ...t, start: Math.max(t.start || 0, at) }));
  const cleanDays = (Array.isArray(x.cleanDays) ? x.cleanDays : []).filter((d) => d >= day);
  return { ...x, startedAt, attempts, cleanDays, pAt: at, pDay: day };
}

function mergeAbstain(a = [], b = []) {
  const other = new Map();
  for (const x of [...a, ...b]) {
    const cur = other.get(x.id);
    if (!cur || (x.pAt || 0) > (cur.pAt || 0)) other.set(x.id, x);
  }
  return mergeEntities(a, b).map((w) => {
    const latest = other.get(w.id);
    const at = latest?.pAt || 0;
    if (w.deleted || !at || (w.pAt || 0) >= at || (w.rAt || 0) >= at) return w;
    return clampAbstain(w, at, latest.pDay || '');
  });
}

// ---------- Сброс («Удалить все данные») ----------
// data.resetAt — время сброса. Журнал сливается объединением, поэтому простое удаление вернулось бы с сервера:
// вместо этого при слиянии отбрасываются события и заметки старше метки. Событие, восстановленное из бэкапа
// после сброса, получает поле r (время восстановления) и переживает метку.

const eventAlive = (ev, resetAt) => Math.max(ev.ts || 0, ev.r || 0) >= resetAt;

/** Запись дня без событий старше метки сброса (null — ничего не осталось). */
function pruneEntry(e, resetAt) {
  if (!e || !resetAt) return e;
  if (!Array.isArray(e.ev)) return (e.t || 0) >= resetAt ? e : null;
  const ev = e.ev.filter((x) => eventAlive(x, resetAt));
  if (ev.length === e.ev.length) return e;
  if (!ev.length) return null;
  const out = { ...e, ev };
  out.v = entryValue(out);
  return out;
}

/**
 * Импорт из файла поверх текущих данных. Обычное слияние не вернуло бы то, что удалено здесь позже,
 * чем сделан бэкап, поэтому:
 *  • привычки и воздержания с «надгробием» здесь, но живые в файле — восстанавливаются;
 *  • после сброса: события и заметки из файла помечаются как восстановленные, настройки (ниййа) берутся из файла.
 */
export function prepareImport(local, imported, now = Date.now()) {
  const gone = new Set([...(local?.habits || []), ...(local?.abstain || [])].filter((x) => x.deleted).map((x) => x.id));
  const revive = (list) => (Array.isArray(list) ? list.map((x) => (x && gone.has(x.id) && !x.deleted ? { ...x, updatedAt: now } : x)) : list);
  // детокс, прогресс которого здесь сброшен позже бэкапа: история из файла побеждает (rAt — не обрезать)
  const pAt = new Map((local?.abstain || []).filter((x) => x.pAt).map((x) => [x.id, x.pAt]));
  const restore = (list) => (Array.isArray(list) ? list.map((x) => (x && !x.deleted && (pAt.get(x.id) || 0) > (x.pAt || 0) ? { ...x, updatedAt: now, rAt: now } : x)) : list);
  const out = { ...imported, habits: revive(imported.habits), abstain: restore(revive(imported.abstain)) };
  const resetAt = Number(local?.resetAt) || 0;
  if (!resetAt) return out;
  const logs = {};
  for (const [hid, days] of Object.entries(imported.logs || {})) {
    logs[hid] = {};
    for (const [day, e] of Object.entries(days || {})) {
      const ev = entryEvents(e).map((x) => (eventAlive(x, resetAt) ? x : { ...x, r: now }));
      logs[hid][day] = { ...e, ev, t: Math.max(e?.t || 0, now) };
    }
  }
  const notes = {};
  for (const [day, n] of Object.entries(imported.notes || {})) notes[day] = (n?.t || 0) >= resetAt ? n : { ...n, t: now };
  out.logs = logs;
  out.notes = notes;
  out.achievements = (Array.isArray(imported.achievements) ? imported.achievements : []).map((x) => ({ ...x, at: now })); // восстановлены после сброса
  // настройки из файла — новее сброса: свежие метки всем полям
  if (imported.settings && (imported.settings.updatedAt || 0) < resetAt) out.settings = stampAll(normalizeSettings(clone(imported.settings)), now);
  return out;
}

export function merge(a, b, { serverNow } = {}) {
  a = normalize(a);
  b = normalize(b);
  const habits = mergeEntities(a.habits, b.habits);
  const deleted = new Set(habits.filter((h) => h.deleted).map((h) => h.id));
  const resetAt = Math.max(a.resetAt, b.resetAt);
  const logs = {};
  for (const hid of new Set([...Object.keys(a.logs), ...Object.keys(b.logs)])) {
    if (deleted.has(hid)) continue;
    const la = a.logs[hid] || {};
    const lb = b.logs[hid] || {};
    const out = {};
    for (const day of new Set([...Object.keys(la), ...Object.keys(lb)])) {
      const e = pruneEntry(mergeEntry(la[day], lb[day]), resetAt);
      if (e) out[day] = e;
    }
    if (!resetAt || Object.keys(out).length) logs[hid] = out;
  }
  const notes = { ...a.notes };
  for (const [k, n] of Object.entries(b.notes)) if (!notes[k] || (n.t || 0) > (notes[k].t || 0)) notes[k] = n;
  if (resetAt) for (const [k, n] of Object.entries(notes)) if ((n?.t || 0) < resetAt) delete notes[k];
  // неизвестные разделы: целиком от более свежей стороны (их разберёт код той версии, что их создала)
  const extra = {};
  for (const src of a.updatedAt > b.updatedAt ? [b, a] : [a, b]) {
    for (const [k, v] of Object.entries(src)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }
  return {
    ...extra,
    version: 1,
    schemaVersion: Math.max(a.schemaVersion, b.schemaVersion),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    resetAt,
    habits,
    logs,
    abstain: mergeAbstain(a.abstain, b.abstain),
    notes,
    achievements: mergeAchievements(a.achievements, b.achievements, resetAt),
    backupLog: mergeBackupLog(a.backupLog, b.backupLog),
    // по полям: по каждой настройке — более свежее изменение (serverNow — только на сервере)
    settings: normalizeSettings(mergeSettings(a.settings, b.settings, { serverNow })),
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------- Хранилище ----------

function readJSON(key, fallback) {
  try {
    const raw = storageGet(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Запись через обёртку: при сбое данные остаются в памяти, а приложение показывает предупреждение. */
function writeJSON(key, value) {
  return storageSet(key, JSON.stringify(value));
}

let data = normalize(readJSON(DATA_KEY, null));
let local = readJSON(LOCAL_KEY, { timers: {} });
const subscribers = new Set();
let changeHook = null;

export const getData = () => data;
export const getLocal = () => local;

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

const emit = () => subscribers.forEach((fn) => fn(data));

/**
 * После синхронизации: локальные метки, которые сервер урезал (часы устройства спешат), заменить серверными
 * там, где значения совпадают. Возвращает данные для финального слияния.
 */
export function adoptServerStamps(local, server) {
  const l = normalize(local);
  return { ...l, settings: adoptStamps(l.settings, normalize(server).settings) };
}

/** Заменить данные целиком (после синхронизации/импорта). */
export function replaceData(next, { notifySync = false } = {}) {
  data = normalize(next);
  writeJSON(DATA_KEY, data);
  emit();
  if (notifySync && changeHook) changeHook();
}

/** Изменить данные: fn получает черновик и мутирует его. */
export function update(fn) {
  const before = clone(data.settings);
  fn(data);
  // метки изменившимся настройкам; updatedAt настроек = max(_t), даже если код выше выставил его сам
  stampChanges(before, data.settings, Date.now());
  data.updatedAt = Date.now();
  writeJSON(DATA_KEY, data);
  emit();
  if (changeHook) changeHook();
}

export function updateLocal(fn) {
  fn(local);
  writeJSON(LOCAL_KEY, local);
  emit();
}

export const onLocalChange = (fn) => (changeHook = fn);

// ---------- Удобные операции ----------

export const touch = (e) => ((e.updatedAt = Date.now()), e);

const byOrder = (a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0);
export const habitsAll = () => data.habits.filter((h) => !h.deleted).sort(byOrder);
export const habitsActive = () => habitsAll().filter((h) => !h.archived);
export const abstainAll = () => data.abstain.filter((a) => !a.deleted);
export const findHabit = (id) => data.habits.find((h) => h.id === id && !h.deleted);
export const findAbstain = (id) => data.abstain.find((a) => a.id === id && !a.deleted);

export const getLog = (hid, day) => entryValue(data.logs[hid]?.[day]);

/** Значение конкретного этапа за день. */
export function getStageLog(hid, day, sid) {
  return entryEvents(data.logs[hid]?.[day]).reduce((s, x) => s + (x.s === sid ? x.d || 0 : 0), 0);
}

/** События привычки за день (с временем нажатий). */
export const getEvents = (hid, day) => entryEvents(data.logs[hid]?.[day]);

/**
 * Добавить событие (изменение значения на delta, опционально — для этапа).
 * k — вид отметки: 'qada' (восполнение), 'late' (вовремя, отмечено поздно), 'juma', 'dhuhr'.
 */
export function addEvent(hid, day, delta, sid, ts = Date.now(), k = '') {
  if (!delta) return;
  update((d) => {
    d.logs[hid] = d.logs[hid] || {};
    const e = d.logs[hid][day];
    const ev = [...entryEvents(e)];
    const item = { id: uid(), ts, d: delta };
    if (sid) item.s = sid;
    if (k && delta > 0) item.k = k;
    ev.push(item);
    const next = { ev, t: Date.now() };
    next.v = entryValue(next);
    d.logs[hid][day] = next;
  });
}

/** Установить значение дня (записывается как событие-разница). */
export function setLog(hid, day, v) {
  addEvent(hid, day, Math.max(0, v) - getLog(hid, day));
}

/** Установить значение этапа. */
export function setStageLog(hid, day, sid, v, k = '', ts = Date.now()) {
  addEvent(hid, day, Math.max(0, v) - getStageLog(hid, day, sid), sid, ts, k);
}

/** Записать подход зикра одной записью: { k: 'dhikr', s: id зикра, n, d: n }. */
export function addDhikrRecord(day, dhikrId, n, ts = Date.now()) {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return;
  update((d) => {
    d.logs.__dhikr = d.logs.__dhikr || {};
    const e = d.logs.__dhikr[day];
    const ev = [...entryEvents(e), { id: uid(), ts, d: n, s: dhikrId, k: 'dhikr', n }];
    const next = { ev, t: Date.now() };
    next.v = entryValue(next);
    d.logs.__dhikr[day] = next;
  });
}

/** Ключ журнала восполнения старых долгов каза. */
export const QADA_LOG = '__qada';

export function setNote(day, text) {
  update((d) => {
    d.notes[day] = { text, t: Date.now() };
  });
}

export function upsertHabit(h) {
  update((d) => {
    const i = d.habits.findIndex((x) => x.id === h.id);
    if (i >= 0) d.habits[i] = touch({ ...d.habits[i], ...h });
    else d.habits.push(touch({ id: uid(), createdAt: Date.now(), archived: false, order: Date.now(), ...h }));
  });
}

export function upsertAbstain(a) {
  update((d) => {
    const i = d.abstain.findIndex((x) => x.id === a.id);
    if (i >= 0) d.abstain[i] = touch({ ...d.abstain[i], ...a });
    else d.abstain.push(touch({ id: uid(), createdAt: Date.now(), attempts: [], cleanDays: [], ...a }));
  });
}

/** Новый порядок привычек: массив id сверху вниз. */
export function reorderHabits(ids) {
  update((d) => {
    ids.forEach((id, i) => {
      const h = d.habits.find((x) => x.id === id);
      if (h && h.order !== i) touch(Object.assign(h, { order: i }));
    });
  });
}

function tombstone(e) {
  for (const k of Object.keys(e)) if (!['id', 'createdAt'].includes(k)) delete e[k];
  e.deleted = true;
  touch(e);
}

/**
 * «Удалить все данные»: привычки и воздержания — «надгробия», журналы (в т.ч. зикры и восполнение каза) и заметки
 * очищаются и не вернутся с сервера (метка resetAt), ниййа стирается. Настройки остаются.
 * keepOld — остаток старого долга каза по намазам: журнал восполнения стирается, поэтому остаток записывается числом.
 */
export function resetAll(keepOld = null, now = Date.now()) {
  update((d) => {
    for (const x of [...d.habits, ...d.abstain]) if (!x.deleted) tombstone(x);
    d.logs = {};
    d.notes = {};
    d.achievements = [];
    d.resetAt = now;
    d.settings.profile = { ...(d.settings.profile || {}), niyyah: '' };
    if (keepOld) d.settings.qada = { ...d.settings.qada, old: { ...d.settings.qada?.old, ...keepOld } };
    stampAll(d.settings, now); // настройки после сброса — самые новые, старые с сервера их не перебьют
  });
}

/**
 * «Сбросить прогресс»: история обнуляется, структура остаётся. Метка resetAt (как у «Удалить все данные»)
 * отбрасывает при слиянии отметки, заметки и достижения старше сброса; привычки не трогаются.
 * Детоксы: отсчёт с момента сброса, попытки и чистые дни — пусто (pAt/pDay — см. mergeAbstain).
 * qada — { old, since, vitrSince }: долг каза, который был до сброса, записывается в остаток числом,
 * а пропуски по трекеру считаются с since (журнал отметок стирается).
 */
export function resetProgress({ qada = null } = {}, now = Date.now(), day = '') {
  update((d) => {
    d.logs = {};
    d.notes = {};
    d.achievements = [];
    d.resetAt = now;
    for (const a of d.abstain) {
      if (a.deleted) continue;
      Object.assign(a, { startedAt: now, attempts: [], cleanDays: [], pAt: now, pDay: day });
      delete a.rAt;
      a.updatedAt = now;
    }
    if (qada) d.settings.qada = { ...d.settings.qada, ...qada, old: { ...d.settings.qada?.old, ...(qada.old || {}) } };
  });
}

/** Удаление — «надгробие», чтобы удаление тоже синхронизировалось. */
export function removeHabit(id) {
  update((d) => {
    const h = d.habits.find((x) => x.id === id);
    if (h) tombstone(h);
    delete d.logs[id];
  });
}

export function removeAbstain(id) {
  update((d) => {
    const a = d.abstain.find((x) => x.id === id);
    if (a) tombstone(a);
  });
}

/** Настройка по пути: setSetting('prayer.adj.fajr', 2) */
export function setSetting(path, value) {
  update((d) => {
    const keys = path.split('.');
    let o = d.settings;
    for (const k of keys.slice(0, -1)) o = o[k] = { ...(o[k] || {}) };
    o[keys[keys.length - 1]] = value;
    d.settings.updatedAt = Date.now();
  });
}

/** Объединить несколько привычек-намазов в одну с этапами (история переносится). */
export function mergeIntoStaged(newHabit, mapping) {
  // mapping: [{ habitId, stageId }]
  update((d) => {
    const nh = touch({ id: uid(), createdAt: Date.now(), archived: false, order: Date.now(), ...newHabit });
    d.habits.push(nh);
    const logs = {};
    let minOrder = Infinity;
    for (const { habitId, stageId } of mapping) {
      const old = d.habits.find((x) => x.id === habitId);
      if (!old) continue;
      minOrder = Math.min(minOrder, old.order ?? old.createdAt ?? Infinity);
      nh.createdAt = Math.min(nh.createdAt, old.createdAt || nh.createdAt);
      for (const [day, e] of Object.entries(d.logs[habitId] || {})) {
        const v = entryValue(e);
        if (v <= 0) continue;
        const ts = entryEvents(e).find((x) => x.d > 0)?.ts || e.t || Date.now();
        logs[day] = logs[day] || [];
        logs[day].push({ id: `M${habitId}${day}`, ts, d: 1, s: stageId });
      }
      tombstone(old);
      delete d.logs[habitId];
    }
    if (Number.isFinite(minOrder)) nh.order = minOrder;
    d.logs[nh.id] = {};
    for (const [day, ev] of Object.entries(logs)) d.logs[nh.id][day] = { ev, t: Date.now(), v: ev.length };
  });
}
