// Типичные данные: 5 намазов + Витр, вода по режиму (8 этапов), зарядка, чек-ин.
import { defaultSettings } from '../js/store.js';

const PR = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const NAMES = { fajr: 'Фаджр', dhuhr: 'Зухр', asr: 'Аср', maghrib: 'Магриб', isha: 'Иша' };

export function typicalData() {
  const created = Date.UTC(2026, 9, 1);
  const water = ['07:30', '09:00', '10:30', '12:30', '14:30', '16:30', '18:30', '20:30'].map((at, i) => ({ id: 'w' + i, name: `Стакан ${i + 1}`, min: 1, max: 2, time: { mode: 'fixed', at } }));
  return {
    updatedAt: 1,
    settings: { ...defaultSettings(), tz: 'Asia/Tashkent', updatedAt: 1, qada: { ...defaultSettings().qada, since: '2026-10-01' } },
    habits: [
      {
        id: 'namaz', name: 'Намаз', emoji: '🕌', type: 'check', createdAt: created, updatedAt: 1, order: 1, schedule: { kind: 'daily' },
        stages: [
          ...PR.map((k) => ({ id: 'p-' + k, name: NAMES[k], min: 1, max: 1, time: { mode: 'prayer', prayer: k, minutes: 0 } })),
          { id: 'p-vitr', name: 'Витр', role: 'vitr', min: 1, max: 1, remind: false, time: { mode: 'prayer', prayer: 'isha', minutes: 0 } },
        ],
      },
      { id: 'water', name: 'Вода', emoji: '💧', type: 'count', unit: 'стак.', target: 8, createdAt: created, updatedAt: 1, order: 2, schedule: { kind: 'daily' }, stages: water },
      { id: 'gym', name: 'Зарядка', emoji: '💪', type: 'check', createdAt: created, updatedAt: 1, order: 3, schedule: { kind: 'daily' }, reminders: [{ mode: 'fixed', at: '07:15' }] },
    ],
    logs: {},
    abstain: [{ id: 'a1', name: 'Без сигарет', emoji: '🚭', createdAt: created, updatedAt: 1, startedAt: created, cleanDays: [], relapses: [] }],
    notes: {},
  };
}
