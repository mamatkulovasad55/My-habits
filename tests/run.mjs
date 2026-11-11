// Запуск всех тестов: node tests/run.mjs (без зависимостей, Node 20+).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = fileURLToPath(new URL('.', import.meta.url));
let failed = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.mjs')).sort()) {
  console.log(`\n▶ ${f}`);
  // каждый файл в своём процессе: модули хранят состояние (данные, подменённые часы)
  const r = spawnSync(process.execPath, [dir + f], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n✗ упало файлов: ${failed}` : '\n✓ все тесты прошли');
process.exit(failed ? 1 : 0);
