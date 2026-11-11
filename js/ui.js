// UI-примитивы: иконки, кольца, тепловая карта, графики, шторки, тосты.
import { addDays, dkey, esc, startOfWeek, today, MONTHS_SHORT, WEEKDAYS_LETTER } from './util.js';
import * as tg from './tg.js';

export const COLORS = [
  '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#30B0C7',
  '#32ADE6', '#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#A2845E',
];

export const HABIT_EMOJI = [
  '💧', '🏃', '🧘', '📚', '💪', '🚴', '🏊', '🥗', '🍎', '😴', '🛏️', '🌅',
  '✍️', '📝', '🧠', '🎯', '💊', '🦷', '🧴', '🚶', '🧹', '🪴', '🎸', '🎨',
  '💻', '🇬🇧', '🗣️', '🙏', '❤️', '📵', '☀️', '🥛', '🧊', '⏰', '💰', '📖',
];

export const ABSTAIN_EMOJI = [
  '🚭', '🍺', '🍷', '🍬', '🍔', '🍟', '🥤', '☕', '📱', '🎮', '📺', '🎰',
  '💸', '🛒', '🌙', '🤬', '😤', '🍫', '🧂', '🚬', '💨', '🔞', '🛋️', '⏳',
];

// ---------- Иконки (SF-подобные, stroke) ----------

const svg = (path, size = 24, sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const icon = {
  today: (s) => svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/>', s),
  shield: (s) => svg('<path d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6z"/><path d="m9 12 2 2 4-4"/>', s),
  chart: (s) => svg('<path d="M5 20V11M12 20V5M19 20v-6"/>', s, 2.4),
  person: (s) => svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.8-3.9 3.8-6 7.5-6s6.7 2.1 7.5 6"/>', s),
  gear: (s) => svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>', s),
  plus: (s) => svg('<path d="M12 5v14M5 12h14"/>', s, 2.4),
  minus: (s) => svg('<path d="M5 12h14"/>', s, 2.4),
  check: (s) => svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', s, 2.8),
  play: (s) => `<svg width="${s || 24}" height="${s || 24}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>`,
  pause: (s) => `<svg width="${s || 24}" height="${s || 24}" viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect fill="currentColor" x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>`,
  chevronL: (s) => svg('<path d="m15 18-6-6 6-6"/>', s, 2.4),
  chevronR: (s) => svg('<path d="m9 18 6-6-6-6"/>', s, 2.4),
  close: (s) => svg('<path d="M6 6l12 12M18 6 6 18"/>', s, 2.4),
  cloud: (s) => svg('<path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>', s),
  flame: (s) => svg('<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.4 3.6-8.3.4 2 1.6 3.3 2.9 3.8C12.5 7 13.5 4.5 15.5 3c-.2 3.2 3 5.8 3 10.8 0 4.2-2.7 7.2-6.5 7.2z"/>', s),
  archive: (s) => svg('<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>', s),
  trash: (s) => svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', s),
  pencil: (s) => svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>', s),
  undo: (s) => svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>', s),
};

// ---------- Кольцо прогресса ----------

export function ring(frac, { size = 44, stroke = 5, color = 'var(--accent)', key = '', inner = '', track = 'var(--ring-track)' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac || 0));
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      <circle class="ring-prog" data-ring="${esc(key)}" data-frac="${f}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
        stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}" transform="rotate(-90 ${size / 2} ${size / 2})"
        style="${f === 0 ? 'opacity:0' : ''}"/>
    </svg>
    <div class="ring-inner">${inner}</div>
  </div>`;
}

const prevRing = new Map();
/** Анимирует кольца от предыдущего значения к новому после перерисовки. */
export function animateRings(root = document) {
  root.querySelectorAll('.ring-prog[data-ring]').forEach((el) => {
    const key = el.dataset.ring;
    if (!key) return;
    const to = Number(el.dataset.frac);
    const from = prevRing.has(key) ? prevRing.get(key) : to;
    prevRing.set(key, to);
    if (from === to) return;
    const c = Number(el.getAttribute('stroke-dasharray'));
    el.style.transition = 'none';
    el.style.opacity = from === 0 && to === 0 ? 0 : 1;
    el.style.strokeDashoffset = c * (1 - from);
    el.getBoundingClientRect();
    el.style.transition = '';
    el.style.strokeDashoffset = c * (1 - to);
  });
}

// ---------- Тепловая карта года ----------

export function heatmap(valueFn, color = 'var(--green)', { weeks = 53, cell = 11, gap = 3 } = {}) {
  const t = today();
  const start = addDays(startOfWeek(t), -(weeks - 1) * 7);
  const step = cell + gap;
  const top = 16;
  const w = weeks * step - gap;
  const h = top + 7 * step - gap;
  let cells = '';
  let labels = '';
  let lastMonth = -1;
  for (let wk = 0; wk < weeks; wk++) {
    const ws = addDays(start, wk * 7);
    if (ws.getMonth() !== lastMonth && ws.getDate() <= 7) {
      lastMonth = ws.getMonth();
      if (wk < weeks - 1) labels += `<text x="${wk * step}" y="10" class="hm-label">${MONTHS_SHORT[lastMonth]}</text>`;
    }
    for (let d = 0; d < 7; d++) {
      const date = addDays(ws, d);
      const v = valueFn(date);
      if (v === null || v === undefined) {
        if (date <= t) cells += `<rect x="${wk * step}" y="${top + d * step}" width="${cell}" height="${cell}" rx="3" class="hm-none"/>`;
        continue;
      }
      const op = v <= 0 ? 0 : v < 0.34 ? 0.35 : v < 0.67 ? 0.6 : v < 1 ? 0.8 : 1;
      const today_ = +date === +t ? ' hm-today' : '';
      cells += op
        ? `<rect x="${wk * step}" y="${top + d * step}" width="${cell}" height="${cell}" rx="3" fill="${color}" fill-opacity="${op}" class="hm-cell${today_}"><title>${dkey(date)} · ${Math.round(v * 100)}%</title></rect>`
        : `<rect x="${wk * step}" y="${top + d * step}" width="${cell}" height="${cell}" rx="3" class="hm-empty${today_}"><title>${dkey(date)} · 0%</title></rect>`;
    }
  }
  return `<div class="heatmap-scroll"><svg class="heatmap" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${labels}${cells}</svg></div>`;
}

/** Прокрутить тепловые карты к текущей неделе. */
export function scrollHeatmaps(root = document) {
  root.querySelectorAll('.heatmap-scroll').forEach((el) => (el.scrollLeft = el.scrollWidth));
}

// ---------- Столбчатый график ----------

export function barChart(items, { color = 'var(--accent)', height = 120 } = {}) {
  // items: [{label, value (0..1|null), highlight}]
  const bars = items
    .map((it) => {
      const v = it.value === null ? 0 : Math.max(0, Math.min(1, it.value));
      return `<div class="bar-col${it.highlight ? ' is-hl' : ''}">
        <div class="bar-track" style="height:${height}px">
          <div class="bar-fill" style="height:${Math.max(v * 100, it.value === null ? 0 : 2)}%;background:${color}" title="${it.value === null ? '—' : Math.round(v * 100) + '%'}"></div>
        </div>
        <div class="bar-label">${esc(it.label)}</div>
      </div>`;
    })
    .join('');
  return `<div class="bars">${bars}</div>`;
}

export const weekdayLetter = (d) => WEEKDAYS_LETTER[d.getDay()];

// ---------- Шторки (bottom sheet) ----------

const sheets = [];
// «Назад» без шторок: подэкран внутри вкладки (Профиль → раздел)
let baseBack = () => false;
export const setBaseBack = (fn) => (baseBack = fn);
export const syncBackButton = () => tg.backButton(sheets.length > 0 || Boolean(baseBack()));

/**
 * Открыть шторку. render() возвращает HTML; если live=true —
 * содержимое перерисовывается при изменении данных.
 */
export function openSheet({ render, mount, live = false, className = '', onClose, swipe = true }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const el = document.createElement('div');
  el.className = `sheet ${className}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  backdrop.appendChild(el);
  document.body.appendChild(backdrop);
  document.body.classList.add('has-sheet');

  const api = {
    el,
    live,
    refresh() {
      const scroll = el.querySelector('.sheet-body')?.scrollTop || 0;
      el.innerHTML = `<div class="sheet-grabber"></div>${render(api)}`;
      const body = el.querySelector('.sheet-body');
      if (body) body.scrollTop = scroll;
      mount?.(api);
      animateRings(el);
      scrollHeatmaps(el);
    },
    close() {
      const i = sheets.indexOf(api);
      if (i < 0) return;
      sheets.splice(i, 1);
      try {
        onClose?.();
      } catch (e) {
        console.error(e);
      }
      syncBackButton();
      backdrop.classList.remove('is-open');
      el.classList.add('is-closing');
      setTimeout(() => {
        backdrop.remove();
        if (!sheets.length) document.body.classList.remove('has-sheet');
      }, 280);
    },
  };
  sheets.push(api);
  tg.backButton(true);
  api.refresh();
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) api.close();
  });
  if (swipe) enableSwipeToClose(el, api);
  return api;
}

function enableSwipeToClose(el, api) {
  let startY = null;
  let dy = 0;
  el.addEventListener('touchstart', (e) => {
    const body = el.querySelector('.sheet-body');
    const onHandle = e.target.closest('.sheet-grabber, .sheet-header');
    if (!onHandle && body && body.scrollTop > 0) return;
    if (!onHandle && !e.target.closest('.sheet-grabber')) {
      // разрешаем жест только если тянут за верхнюю часть
      if (e.touches[0].clientY - el.getBoundingClientRect().top > 80) return;
    }
    startY = e.touches[0].clientY;
    dy = 0;
    el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    el.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (startY === null) return;
    el.style.transition = '';
    el.style.transform = '';
    if (dy > 110) api.close();
    startY = null;
  });
}

export const refreshLiveSheets = () => sheets.forEach((s) => s.live && s.refresh());
export const topSheet = () => sheets[sheets.length - 1];

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheets.length) sheets[sheets.length - 1].close();
});

/** Диалог подтверждения в стиле iOS action sheet. */
export function confirmSheet({ title, message = '', confirm = 'Подтвердить', destructive = false, extra = '', onConfirm }) {
  const s = openSheet({
    className: 'sheet-compact',
    render: () => `
      <div class="sheet-body">
        <div class="confirm">
          <h3>${esc(title)}</h3>
          ${message ? `<p>${message}</p>` : ''}
          ${extra}
          <button class="btn btn-block ${destructive ? 'btn-danger' : 'btn-primary'}" data-c="ok">${esc(confirm)}</button>
          <button class="btn btn-block btn-plain" data-c="cancel">Отмена</button>
        </div>
      </div>`,
    mount: (api) => {
      api.el.querySelector('[data-c=cancel]').onclick = () => api.close();
      api.el.querySelector('[data-c=ok]').onclick = () => {
        if (onConfirm?.(api.el) !== false) api.close();
      };
    },
  });
  return s;
}

// ---------- Тосты и тактильный отклик ----------

let toastTimer;
export function toast(text, { action, onAction, ms = 3200 } = {}) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => {
    onAction?.();
    el.classList.remove('is-shown');
  };
  requestAnimationFrame(() => el.classList.add('is-shown'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), ms);
}

export const haptic = (ms = 8) => {
  if (tg.haptic(ms >= 20 ? 'success' : ms >= 12 ? 'medium' : 'light')) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
};

/** Сегментированный контрол iOS. */
export function segmented(name, options, value) {
  return `<div class="segmented" role="tablist" data-seg="${esc(name)}">${options
    .map((o) => `<button type="button" role="tab" class="${o.value === value ? 'is-active' : ''}" data-value="${esc(o.value)}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}
