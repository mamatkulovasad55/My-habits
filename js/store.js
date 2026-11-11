// Состояние приложения: локальный кэш в localStorage + слияние для синхронизации.
import { uid } from './util.js';
import { migrate, SCHEMA_VERSION } from './migrate.js';

const DATA_KEY = 'myhabits:data:v1';
const LOCAL_KEY = 'myhabits:local:v1'; // данные, привязанные к устройству (запущенные таймеры)

export function defaultSettings() {
  return {
    theme: 'system',
    updatedAt: 0,
    tz: '',
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
    qada: { since: '', perDay: 2, old: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0, vitr: 0 } },
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
    settings: defaultSettings(),
  };
}

function normalizeSettings(s) {
  const d = defaultSettings();
  s = s && typeof s === 'object' ? s : {};
  return {
    ...d,
    ...s,
    quiet: { ...d.quiet, ...(s.quiet || {}) },
    checkin: { ...d.checkin, ...(s.checkin || {}) },
    prayer: { ...d.prayer, ...(s.prayer || {}), adj: { ...d.prayer.adj, ...(s.prayer?.adj || {}) } },
    push: { ...d.push, ...(s.push || {}) },
    juma: { ...d.juma, ...(s.juma || {}) },
    qada: { ...d.qada, ...(s.qada || {}), old: { ...d.qada.old, ...(s.qada?.old || {}) } },
  };
}

// Поля верхнего уровня, которые этот код понимает. Остальные (разделы из будущих версий) сохраняются как есть.
const KNOWN_KEYS = new Set(['version', 'schemaVersion', 'updatedAt', 'habits', 'logs', 'abstain', 'notes', 'settings']);

export function normalize(d) {
  const e = emptyData();
  if (!d || typeof d !== 'object' || Array.isArray(d)) return e;
  d = migrate(d);
  return {
    ...d,
    version: 1,
    schemaVersion: Number(d.schemaVersion) || SCHEMA_VERSION,
    updatedAt: Number(d.updatedAt) || 0,
    habits: Array.isArray(d.habits) ? d.habits : [],
    logs: d.logs && typeof d.logs === 'object' ? d.logs : {},
    abstain: Array.isArray(d.abstain) ? d.abstain : [],
    notes: d.notes && typeof d.notes === 'object' ? d.notes : {},
    settings: normalizeSettings(d.settings),
  };
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
  for (const ev of [...entryEvents(x), ...entryEvents(y)]) map.set(ev.id, ev);
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

export function merge(a, b) {
  a = normalize(a);
  b = normalize(b);
  const habits = mergeEntities(a.habits, b.habits);
  const deleted = new Set(habits.filter((h) => h.deleted).map((h) => h.id));
  const logs = {};
  for (const hid of new Set([...Object.keys(a.logs), ...Object.keys(b.logs)])) {
    if (deleted.has(hid)) continue;
    const la = a.logs[hid] || {};
    const lb = b.logs[hid] || {};
    const out = {};
    for (const day of new Set([...Object.keys(la), ...Object.keys(lb)])) out[day] = mergeEntry(la[day], lb[day]);
    logs[hid] = out;
  }
  const notes = { ...a.notes };
  for (const [k, n] of Object.entries(b.notes)) if (!notes[k] || (n.t || 0) > (notes[k].t || 0)) notes[k] = n;
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
    habits,
    logs,
    abstain: mergeEntities(a.abstain, b.abstain),
    notes,
    settings: (b.settings.updatedAt || 0) > (a.settings.updatedAt || 0) ? b.settings : a.settings,
  };
}

// ---------- Хранилище ----------

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — работаем в памяти */
  }
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

/** Заменить данные целиком (после синхронизации/импорта). */
export function replaceData(next, { notifySync = false } = {}) {
  data = normalize(next);
  writeJSON(DATA_KEY, data);
  emit();
  if (notifySync && changeHook) changeHook();
}

/** Изменить данные: fn получает черновик и мутирует его. */
export function update(fn) {
  fn(data);
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
export function setStageLog(hid, day, sid, v, k = '') {
  addEvent(hid, day, Math.max(0, v) - getStageLog(hid, day, sid), sid, Date.now(), k);
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
