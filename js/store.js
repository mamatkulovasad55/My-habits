// Состояние приложения: локальный кэш в localStorage + слияние для синхронизации.
import { uid } from './util.js';

const DATA_KEY = 'myhabits:data:v1';
const LOCAL_KEY = 'myhabits:local:v1'; // данные, привязанные к устройству (запущенные таймеры)

export function emptyData() {
  return {
    version: 1,
    updatedAt: 0,
    habits: [],
    logs: {},
    abstain: [],
    settings: { theme: 'system', updatedAt: 0 },
  };
}

export function normalize(d) {
  const e = emptyData();
  if (!d || typeof d !== 'object') return e;
  return {
    version: 1,
    updatedAt: Number(d.updatedAt) || 0,
    habits: Array.isArray(d.habits) ? d.habits : [],
    logs: d.logs && typeof d.logs === 'object' ? d.logs : {},
    abstain: Array.isArray(d.abstain) ? d.abstain : [],
    settings: { ...e.settings, ...(d.settings || {}) },
  };
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
    for (const day of new Set([...Object.keys(la), ...Object.keys(lb)])) {
      const x = la[day];
      const y = lb[day];
      out[day] = !x ? y : !y ? x : (y.t || 0) > (x.t || 0) ? y : x;
    }
    logs[hid] = out;
  }
  return {
    version: 1,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    habits,
    logs,
    abstain: mergeEntities(a.abstain, b.abstain),
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

export const habitsAll = () => data.habits.filter((h) => !h.deleted);
export const habitsActive = () => habitsAll().filter((h) => !h.archived);
export const abstainAll = () => data.abstain.filter((a) => !a.deleted);
export const findHabit = (id) => data.habits.find((h) => h.id === id && !h.deleted);
export const findAbstain = (id) => data.abstain.find((a) => a.id === id && !a.deleted);

export function getLog(hid, day) {
  const e = data.logs[hid]?.[day];
  return e ? e.v || 0 : 0;
}

export function setLog(hid, day, v) {
  update((d) => {
    d.logs[hid] = d.logs[hid] || {};
    d.logs[hid][day] = { v: Math.max(0, v), t: Date.now() };
  });
}

export function upsertHabit(h) {
  update((d) => {
    const i = d.habits.findIndex((x) => x.id === h.id);
    if (i >= 0) d.habits[i] = touch({ ...d.habits[i], ...h });
    else d.habits.push(touch({ id: uid(), createdAt: Date.now(), archived: false, ...h }));
  });
}

export function upsertAbstain(a) {
  update((d) => {
    const i = d.abstain.findIndex((x) => x.id === a.id);
    if (i >= 0) d.abstain[i] = touch({ ...d.abstain[i], ...a });
    else d.abstain.push(touch({ id: uid(), createdAt: Date.now(), attempts: [], cleanDays: [], ...a }));
  });
}

/** Удаление — «надгробие», чтобы удаление тоже синхронизировалось. */
export function removeHabit(id) {
  update((d) => {
    const h = d.habits.find((x) => x.id === id);
    if (h) {
      for (const k of Object.keys(h)) if (!['id', 'createdAt'].includes(k)) delete h[k];
      h.deleted = true;
      touch(h);
    }
    delete d.logs[id];
  });
}

export function removeAbstain(id) {
  update((d) => {
    const a = d.abstain.find((x) => x.id === id);
    if (a) {
      for (const k of Object.keys(a)) if (!['id', 'createdAt'].includes(k)) delete a[k];
      a.deleted = true;
      touch(a);
    }
  });
}

export function setSetting(key, value) {
  update((d) => {
    d.settings[key] = value;
    d.settings.updatedAt = Date.now();
  });
}
