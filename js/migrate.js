// Версия схемы data.json и миграции. Чистая логика без зависимостей:
// выполняется и в приложении, и в Cloudflare Worker (как schedule.js и logic.js).
//
// Правила совместимости:
//  • миграция только добавляет и уточняет, но не удаляет данные и не трогает неизвестные поля;
//  • каждый шаг идемпотентен (повторный запуск ничего не меняет);
//  • данные более новой версии, чем знает этот код, не «понижаются» — остаются как есть.

export const SCHEMA_VERSION = 3;
/** Дата релиза правила «неотмеченный Витр — долг (ваджиб)»: раньше неё Витр в долг не превращается. */
export const VITR_DEBT_RELEASE = '2026-11-11';

/** MIGRATIONS[n] приводит данные версии n-1 к версии n. Получает копию верхнего уровня. */
export const MIGRATIONS = {
  // v0 → v1: до этой версии поля schemaVersion не было; структура не меняется.
  1: (d) => d,
  // v1 → v2: флаг ibadah (главная метрика — сила привычки) для привычек с этапами-намазами.
  // updatedAt не меняется: на всех устройствах результат одинаков, слияние ничего не перезаписывает.
  2: (d) => {
    if (!Array.isArray(d.habits)) return d;
    d.habits = d.habits.map((h) =>
      h && h.ibadah === undefined && Array.isArray(h.stages) && h.stages.some((s) => s?.time?.mode === 'prayer') ? { ...h, ibadah: true } : h,
    );
    return d;
  },
  // v2 → v3: долг Витра — только с даты релиза; у существующего аккаунта с намазами включается тартиб.
  3: (d) => {
    const s = d.settings && typeof d.settings === 'object' ? d.settings : null;
    if (!s) return d;
    const next = { ...s };
    if (s.qada?.since && !s.qada.vitrSince) next.qada = { ...s.qada, vitrSince: VITR_DEBT_RELEASE };
    const hasNamaz = Array.isArray(d.habits) && d.habits.some((h) => h && !h.deleted && Array.isArray(h.stages) && h.stages.some((x) => x?.time?.mode === 'prayer'));
    if (hasNamaz && s.tartib === undefined) next.tartib = { enabled: true, asked: true };
    d.settings = next;
    return d;
  },
};

/** Привести данные любой версии к актуальной. Исходный объект не изменяется. */
export function migrate(input) {
  if (!input || typeof input !== 'object') return input;
  const from = Number(input.schemaVersion) || 0;
  if (from >= SCHEMA_VERSION) return input;
  let d = { ...input };
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    d = MIGRATIONS[v](d) || d;
    d.schemaVersion = v;
  }
  return d;
}
