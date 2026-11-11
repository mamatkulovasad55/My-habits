// Версия схемы data.json и миграции. Чистая логика без зависимостей:
// выполняется и в приложении, и в Cloudflare Worker (как schedule.js и logic.js).
//
// Правила совместимости:
//  • миграция только добавляет и уточняет, но не удаляет данные и не трогает неизвестные поля;
//  • каждый шаг идемпотентен (повторный запуск ничего не меняет);
//  • данные более новой версии, чем знает этот код, не «понижаются» — остаются как есть.

export const SCHEMA_VERSION = 1;

/** MIGRATIONS[n] приводит данные версии n-1 к версии n. Получает копию верхнего уровня. */
export const MIGRATIONS = {
  // v0 → v1: до этой версии поля schemaVersion не было; структура не меняется.
  1: (d) => d,
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
