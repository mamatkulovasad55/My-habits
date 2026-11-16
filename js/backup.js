// Раздел «Данные»: превью импорта, автобэкап перед опасным действием, строка «Последний бэкап».
// Чистые функции без DOM (приложение и тесты).
import { normalize, entryValue, lastBackup, getData, resetProgress } from './store.js';
import { SCHEMA_VERSION } from './migrate.js';
import { qadaDebt, QADA_KEYS } from './schedule.js';
import { addDays, dkey } from './util.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Что внутри файла бэкапа. → { ok: true, data, at, schema, habits, abstain, from, to, achievements }
 * или { ok: false, error } — битый или чужой файл (тогда ничего не меняется).
 */
export function importSummary(text) {
  let raw;
  try {
    raw = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ok: false, error: 'Файл повреждён: это не JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.habits) || (raw.logs != null && (typeof raw.logs !== 'object' || Array.isArray(raw.logs)))) {
    return { ok: false, error: 'Это не бэкап трекера: нет списка привычек' };
  }
  const schema = Number(raw.schemaVersion) || 1;
  if (schema > SCHEMA_VERSION) return { ok: false, error: 'Файл из более новой версии приложения — сначала обнови приложение' };
  let data;
  try {
    data = normalize(raw); // старая схема — через migrate.js
  } catch {
    return { ok: false, error: 'Не удалось разобрать файл' };
  }
  let from = '';
  let to = '';
  for (const days of Object.values(data.logs)) {
    for (const [day, e] of Object.entries(days || {})) {
      if (!DAY_RE.test(day) || !(entryValue(e) > 0)) continue;
      if (!from || day < from) from = day;
      if (!to || day > to) to = day;
    }
  }
  return {
    ok: true,
    data: raw,
    at: Number(raw.updatedAt) > Date.UTC(2020, 0, 1) ? Number(raw.updatedAt) : 0, // 0 — в файле нет настоящей даты
    schema,
    habits: data.habits.filter((h) => !h.deleted).length,
    abstain: data.abstain.filter((a) => !a.deleted).length,
    from,
    to,
    achievements: data.achievements.length,
  };
}

/**
 * Опасное действие только после бэкапа. backup() — отправка в бота (бросает при ошибке);
 * fallback(err) → 'export' | другое — что делать, если бэкап не ушёл; exportFile() — скачать экспорт;
 * run() — само действие. → true, если действие выполнено. Без бэкапа или экспорта действие не выполняется.
 */
export async function withBackup({ backup, fallback, exportFile, run }) {
  try {
    await backup();
  } catch (err) {
    if ((await fallback(err)) !== 'export') return false;
    try {
      await exportFile();
    } catch {
      return false;
    }
  }
  await run();
  return true;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad = (n) => String(n).padStart(2, '0');

/** «Последний бэкап: 15 ноября, 21:00 · в бота» или «Бэкапов ещё не было». now — для года. */
export function lastBackupText(log, now = new Date()) {
  const b = lastBackup(log);
  if (!b) return 'Бэкапов ещё не было';
  const d = new Date(b.at);
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `Последний бэкап: ${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${pad(d.getHours())}:${pad(d.getMinutes())} · ${b.kind === 'export' ? 'экспорт' : 'в бота'}`;
}

/**
 * «Сбросить прогресс» с переносом долга каза: всё, что было в долгу на момент сброса (старый остаток и
 * пропуски по трекеру), записывается в остаток числом, а пропуски по трекеру считаются с завтрашнего дня
 * (сегодняшние отметки стёрты — сегодняшние намазы не превращаются в долг). Импорт бэкапа возвращает и то, и другое.
 */
export function resetProgressNow(now = new Date()) {
  const debt = qadaDebt().byPrayer;
  const q = getData().settings.qada || {};
  const next = dkey(addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), 1));
  resetProgress({
    qada: {
      old: Object.fromEntries(QADA_KEYS.map((k) => [k, debt[k].total])),
      ...(q.since ? { since: next } : {}),
      ...(q.vitrSince ? { vitrSince: next } : {}),
    },
  }, now.getTime(), dkey(now));
}
