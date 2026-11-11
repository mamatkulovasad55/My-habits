// Счётчик зикров: чистая логика без DOM (приложение и тесты).
// В журнал пишется подход целиком, а не каждое нажатие: logs.__dhikr[день].ev = [{ id, ts, k: 'dhikr', s: <зикр>, n, d: n }].
// s — id зикра (как у каза — ключ намаза), id — уникальный ключ события для слияния, d = n для суммы дня.

export const DHIKR_LOG = '__dhikr';
export const DHIKR_PENDING_KEY = 'myhabits:dhikr:pending:v1';
export const DHIKR_TARGETS = [33, 100, 0]; // 0 — без цели

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Записи-подходы за день (события с k === 'dhikr'). */
export function dhikrEvents(data, dayKey) {
  const e = data?.logs?.[DHIKR_LOG]?.[dayKey];
  return Array.isArray(e?.ev) ? e.ev.filter((x) => x.k === 'dhikr' && Number(x.n) > 0) : [];
}

/** Итог дня: { byId: { subhanallah: 99, ... }, total }. */
export function dhikrTotals(data, dayKey) {
  const byId = {};
  let total = 0;
  for (const ev of dhikrEvents(data, dayKey)) {
    byId[ev.s] = (byId[ev.s] || 0) + Number(ev.n);
    total += Number(ev.n);
  }
  return { byId, total };
}

/** Суммы по каждому зикру за days дней, заканчивая днём until (включительно). */
export function dhikrSums(data, until, days) {
  const byId = {};
  let total = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(until.getFullYear(), until.getMonth(), until.getDate() - i);
    const t = dhikrTotals(data, keyOf(d));
    for (const [id, n] of Object.entries(t.byId)) byId[id] = (byId[id] || 0) + n;
    total += t.total;
  }
  return { byId, total };
}

/**
 * Состояние подхода. storage — объект с getItem/setItem/removeItem (localStorage),
 * record(dayKey, id, n, ts) — запись подхода в журнал, now() — текущее время.
 * На экране показывается base + n: base — уже записанная в этом сеансе часть (после сворачивания).
 */
export function createCounter({ storage, record, now = () => new Date(), id = 'subhanallah' } = {}) {
  const st = { id, day: keyOf(now()), base: 0, n: 0, startedAt: 0 };
  const save = () => {
    try {
      if (st.n > 0) storage?.setItem(DHIKR_PENDING_KEY, JSON.stringify({ id: st.id, day: st.day, n: st.n, startedAt: st.startedAt }));
      else storage?.removeItem(DHIKR_PENDING_KEY);
    } catch {
      /* хранилище недоступно — счёт останется в памяти */
    }
  };
  const api = {
    get id() {
      return st.id;
    },
    get n() {
      return st.n;
    },
    /** Число на экране. */
    get shown() {
      return st.base + st.n;
    },
    tap() {
      if (!st.n) {
        st.startedAt = now().getTime();
        st.day = keyOf(now());
      }
      st.n++;
      save();
      return st.base + st.n;
    },
    /** Записать подход (если есть нажатия). Число на экране не сбрасывается. */
    commit() {
      if (st.n > 0) record(st.day, st.id, st.n, now().getTime());
      st.base += st.n;
      st.n = 0;
      save();
    },
    /** Перейти к другому зикру: текущий подход записывается, новый начинается с 0. */
    switchTo(nextId) {
      api.commit();
      st.id = nextId;
      st.base = 0;
    },
    /** Сбросить: незаписанные нажатия отбрасываются, экран — 0. */
    reset() {
      st.base = 0;
      st.n = 0;
      save();
    },
    /** Начать заново после закрытия экрана (записанное остаётся в журнале). */
    restart(nextId = st.id) {
      st.id = nextId;
      st.base = 0;
      st.n = 0;
    },
  };
  return api;
}

/** При запуске: незаписанный подход (Telegram закрыли посреди счёта) записать в журнал ровно один раз. */
export function recoverPending(storage, record) {
  let p = null;
  try {
    p = JSON.parse(storage?.getItem(DHIKR_PENDING_KEY) || 'null');
    storage?.removeItem(DHIKR_PENDING_KEY);
  } catch {
    return 0;
  }
  if (!p || !(Number(p.n) > 0) || !p.id || !p.day) return 0;
  record(p.day, p.id, Number(p.n), p.startedAt || Date.now());
  return Number(p.n);
}
