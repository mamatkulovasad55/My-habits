// Генерирует таблицу длин месяцев Умм аль-Кура (1380–1520 г.х.) из ICU (Intl) для фолбэка в js/hijri.js.
// Запуск: node tests/tools/gen-umq-table.mjs — выводит константы для вставки в hijri.js.
const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const parts = (ms) => Object.fromEntries(fmt.formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, +p.value.replace(/\D.*$/, '')]));
const DAY = 86400000;
const FIRST = 1380, LAST = 1520;
// найти 1 Мухаррама FIRST
let t = Date.UTC(1960, 0, 1, 12);
for (;;) { const p = parts(t); if (p.year === FIRST && p.month === 1 && p.day === 1) break; t += DAY; }
const startJdn = Math.floor(t / DAY) + 2440588; // юлианский день (t — полдень UTC)
let bits = '';
let cur = t;
for (let y = FIRST; y <= LAST; y++) {
  let yb = 0;
  for (let m = 1; m <= 12; m++) {
    let len = 29;
    if (parts(cur + 29 * DAY).day === 30) len = 30;
    if (len === 30) yb |= 1 << (m - 1);
    cur += len * DAY;
  }
  bits += yb.toString(16).padStart(3, '0');
}
console.log(`const UMQ_FIRST = ${FIRST};\nconst UMQ_START_JDN = ${startJdn}; // 1 Мухаррама ${FIRST}\nconst UMQ_BITS = '${bits}';`);
