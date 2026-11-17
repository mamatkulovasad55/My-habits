// Раздел «Данные»: превью импорта, автобэкап перед опасным действием, «Последний бэкап».
import assert from 'node:assert/strict';
import { typicalData } from './fixtures.mjs';
import { merge, normalize, mergeBackupLog, prepareImport } from '../js/store.js';
import { importSummary, withBackup, lastBackupText } from '../js/backup.js';

// 1. Превью импорта
{
  const d = typicalData();
  d.updatedAt = Date.UTC(2026, 10, 15, 16);
  d.habits.push({ id: 'old', deleted: true, createdAt: 1, updatedAt: 2 });
  d.logs = {
    gym: { '2026-11-03': { v: 1, t: 1, ev: [{ id: 'a', ts: 1, d: 1 }] }, '2026-10-20': { v: 0, t: 1, ev: [] } },
    __dhikr: { '2026-11-12': { v: 33, t: 1, ev: [{ id: 'z', ts: 1, d: 33, n: 33, s: 'subhanallah', k: 'dhikr' }] } },
    water: { '2026-10-25': { v: 2, t: 1 } },
  };
  d.achievements = [{ id: 'streak-7', earnedAt: '2026-11-08', at: 1 }];
  const s = importSummary(JSON.stringify(d));
  assert.equal(s.ok, true);
  assert.equal(s.at, d.updatedAt);
  assert.equal(s.habits, typicalData().habits.length, 'удалённые не считаются');
  assert.equal(s.abstain, 1);
  assert.equal(s.from, '2026-10-25', 'пустой день не считается');
  assert.equal(s.to, '2026-11-12');
  assert.equal(s.achievements, 1);
  assert.ok(s.schema >= 1);
  for (const bad of ['{нет', '[]', '{"foo":1}', '{"habits":{}}', '{"habits":[],"logs":[]}', 'null']) {
    const r = importSummary(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error);
  }
  assert.equal(importSummary(JSON.stringify({ habits: [], schemaVersion: 999 })).ok, false, 'файл из будущей версии');
  console.log('✓ превью импорта: дата, схема, привычки, детоксы, период истории, достижения; битый и чужой файл — ошибка');
}

// 2. Автобэкап: без бэкапа или экспорта действие не выполняется
{
  const log = [];
  const mk = (over = {}) => ({
    backup: async () => log.push('backup'),
    fallback: async () => (log.push('ask'), 'cancel'),
    exportFile: async () => log.push('export'),
    confirmSaved: async () => (log.push('saved?'), true),
    run: async () => log.push('run'),
    ...over,
  });
  assert.equal(await withBackup(mk()), true);
  assert.deepEqual(log.splice(0), ['backup', 'run'], 'бэкап → действие');
  const fail = async () => {
    log.push('backup');
    throw new Error('Нет сети');
  };
  assert.equal(await withBackup(mk({ backup: fail })), false);
  assert.deepEqual(log.splice(0), ['backup', 'ask'], 'бэкап не ушёл, «Отмена» — действие не выполнено');
  let err;
  assert.equal(await withBackup(mk({ backup: fail, fallback: async (e) => ((err = e), 'export') })), true);
  assert.deepEqual(log.splice(0), ['backup', 'export', 'saved?', 'run'], '«Скачать экспорт и продолжить» → «Файл сохранился» → действие');
  assert.equal(await withBackup(mk({ backup: fail, fallback: async () => 'export', confirmSaved: async () => false })), false);
  assert.deepEqual(log.splice(0), ['backup', 'export'], 'файл не сохранился — действие не выполнено');
  assert.equal(err.message, 'Нет сети', 'ошибка передана в шторку');
  const exportFail = async () => {
    throw new Error('disk');
  };
  assert.equal(await withBackup(mk({ backup: fail, fallback: async () => 'export', exportFile: exportFail })), false);
  assert.deepEqual(log.splice(0), ['backup'], 'экспорт не удался — действие не выполнено');
  console.log('✓ автобэкап: действие только после бэкапа или экспорта');
}

// 3. «Последний бэкап»: самый поздний из трёх видов, слияние по максимуму
{
  const a = { bot: 100, export: 500 };
  const b = { bot: 300, weekly: 200 };
  assert.deepEqual(mergeBackupLog(a, b), { bot: 300, weekly: 200, export: 500 });
  const da = { ...typicalData(), backupLog: a };
  const db = { ...typicalData(), backupLog: b };
  assert.deepEqual(merge(da, db).backupLog, { bot: 300, weekly: 200, export: 500 });
  assert.deepEqual(normalize({ ...typicalData(), backupLog: { bot: 'x', weekly: -1, foo: 5 } }).backupLog, {});
  // импорт старого файла не откатывает дату назад
  const imported = prepareImport(normalize(da), normalize({ ...typicalData(), backupLog: { bot: 50 } }));
  assert.equal(merge(da, imported).backupLog.bot, 100);
  const now = new Date(2026, 10, 16, 12);
  assert.equal(lastBackupText({}, now), 'Бэкапов ещё не было');
  assert.equal(lastBackupText({ weekly: new Date(2026, 10, 15, 21).getTime(), export: new Date(2026, 10, 10, 9, 5).getTime() }, now), 'Последний бэкап: 15 ноября, 21:00 · в бота');
  assert.equal(lastBackupText({ export: new Date(2026, 10, 16, 9, 5).getTime(), bot: new Date(2026, 10, 1).getTime() }, now), 'Последний бэкап: 16 ноября, 09:05 · экспорт');
  assert.equal(lastBackupText({ bot: new Date(2025, 0, 2, 8).getTime() }, now), 'Последний бэкап: 2 января 2025, 08:00 · в бота');
  console.log('✓ «Последний бэкап»: самый поздний, синхронизируется по максимуму, импорт не откатывает');
}
