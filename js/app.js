// Точка входа: экраны, обработчики, живые таймеры.
import {
  getData, getLocal, subscribe, update, updateLocal, replaceData, merge, emptyData, touch,
  habitsActive, habitsAll, abstainAll, findHabit, findAbstain, getLog, setLog,
  getStageLog, setStageLog, getEvents, setNote, addEvent, QADA_LOG, reorderHabits, mergeIntoStaged,
  upsertHabit, upsertAbstain, removeHabit, removeAbstain, setSetting, onLocalChange,
} from './store.js';
import * as sync from './sync.js';
import * as tg from './tg.js';
import { WORKER_URL } from './config.js';
import {
  goalOf, valueOf, progressOf, isDone, isScheduled, firstDay, doneInWeek, scheduleText, goalText,
  currentStreak, bestStreak, streakText, rateOf, totalCompletions, dayStats, rangeRate,
  MILESTONES, abstainElapsed, abstainBest, milestoneInfo, isCleanDay, relapseDays,
  habitHeatValue, overallHeatValue, achievements, hasStages, stageDone,
} from './logic.js';
import { dayContext, stagesForDay, currentStage, timeLabel, timeStats, overallHours, parseHM, stageStatus, stageExpired, stageMark, prayerKeyOf, isNamazHabit, qadaDebt, namazStats, QADA_KEYS, QADA_NAMES } from './schedule.js';
import { PRAYERS, PRAYER_NAME, CITIES, fmtMin } from './prayer.js';
import {
  COLORS, HABIT_EMOJI, ABSTAIN_EMOJI, icon, ring, animateRings, heatmap, scrollHeatmaps, barChart,
  weekdayLetter, openSheet, refreshLiveSheets, confirmSheet, toast, haptic, segmented, topSheet,
} from './ui.js';
import {
  uid, dkey, parseKey, today, todayKey, addDays, startOfWeek, esc, plural, fmtDayLong, fmtDateShort, fmtDateTime,
  fmtClock, fmtDuration, durationParts, pad, clamp, DAY_FORMS, MONTHS, WEEKDAYS_SHORT, stableStringify,
} from './util.js';

const view = document.getElementById('view');
const state = {
  route: 'today',
  day: today(),
  lastTodayKey: todayKey(),
  settingsDraft: null,
};

const ROUTES = ['today', 'abstain', 'stats', 'settings'];
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));
const pct = (r) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);

// ============================================================
// Тема
// ============================================================

function applyTheme() {
  const t = getData().settings.theme || 'system';
  const root = document.documentElement;
  // внутри Telegram «как в системе» = тема Telegram
  const sys = tg.colorScheme() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (t === 'system' && !tg.inTelegram()) delete root.dataset.theme;
  else root.dataset.theme = t === 'system' ? sys : t;
  const dark = t === 'dark' || (t === 'system' && sys === 'dark');
  document.querySelector('meta[name=theme-color]:not([media])')?.setAttribute('content', dark ? '#000000' : '#F2F2F7');
  tg.setColors(dark);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ============================================================
// Рендер
// ============================================================

function render() {
  if (!tg.inTelegram()) return;
  applyTheme();
  const scrollY = window.scrollY;
  const prevRoute = view.dataset.route;
  view.dataset.route = state.route;
  view.innerHTML = { today: viewToday, abstain: viewAbstain, stats: viewStats, settings: viewSettings }[state.route]();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('is-active', a.dataset.route === state.route));
  if (prevRoute === state.route) window.scrollTo(0, scrollY);
  else window.scrollTo(0, 0);
  animateRings(view);
  scrollHeatmaps(view);
  if (state.route === 'settings') mountSettings();
  if (state.route === 'today') {
    mountReorder();
    const note = document.getElementById('day-note');
    if (note) note.onchange = () => setNote(dkey(state.day), note.value.trim());
  }
  refreshLiveSheets();
  tick();
}

function route() {
  const r = location.hash.replace('#', '').split(/[?&]/)[0];
  if (r === 'checkin') {
    history.replaceState(null, '', '#today');
    state.route = 'today';
    state.day = today();
    render();
    return openCheckin();
  }
  state.route = ROUTES.includes(r) ? r : 'today';
  state.reorder = false;
  render();
}

// ============================================================
// Экран «Сегодня»
// ============================================================

function runningValue(h, key) {
  const start = getLocal().timers?.[h.id];
  const base = getLog(h.id, key);
  if (!start || dkey(new Date(start.at)) !== key) return base;
  return base + (Date.now() - start.at) / 1000;
}

function viewToday() {
  const day = state.day;
  const key = dkey(day);
  const isToday = key === todayKey();
  const habits = habitsActive().filter((h) => firstDay(h) <= day || isToday);
  const due = [];
  const other = [];
  for (const h of habits) (isScheduled(h, day) ? due : other).push(h);
  const s = dayStats(day);

  const strip = Array.from({ length: 7 }, (_, i) => addDays(today(), i - 6))
    .map((d) => {
      const st = dayStats(d);
      const k = dkey(d);
      return `<button class="day ${k === key ? 'is-selected' : ''} ${k === todayKey() ? 'is-today' : ''}" data-action="select-day" data-day="${k}">
        <span class="day-letter">${weekdayLetter(d)}</span>
        ${ring(st.ratio ?? 0, { size: 38, stroke: 3.5, key: `strip-${k}`, inner: `<span class="day-num">${d.getDate()}</span>`, color: 'var(--green)' })}
      </button>`;
    })
    .join('');

  const allDone = s.total > 0 && s.done === s.total;
  const summary = habits.length
    ? `<section class="card summary">
        ${ring(s.ratio ?? 0, { size: 92, stroke: 10, key: 'summary', color: 'var(--green)', inner: `<span class="summary-pct">${s.total ? Math.round((s.ratio || 0) * 100) : 0}<small>%</small></span>` })}
        <div class="summary-text">
          <div class="summary-title">${allDone ? 'Все цели выполнены' : s.total ? `Выполнено ${s.done} из ${s.total}` : 'На этот день ничего не запланировано'}</div>
          <div class="summary-sub">${allDone ? 'Отличная работа — так держать 🎉' : s.total ? `Осталось ${s.total - s.done} — ты справишься` : 'Можно отдохнуть'}</div>
        </div>
      </section>`
    : '';

  const abst = abstainAll();
  const abstChips = abst.length && isToday
    ? `<a class="abst-strip" href="#abstain">${abst
        .map((a) => `<span class="abst-chip" style="--c:${a.color}"><span>${esc(a.emoji)}</span><b data-live-abs-short="${a.id}">${fmtDuration(abstainElapsed(a))}</b></span>`)
        .join('')}</a>`
    : '';

  const empty = !habits.length
    ? `<div class="empty">
        <div class="empty-emoji">🌱</div>
        <h2>Начни с одной привычки</h2>
        <p>Маленькие ежедневные шаги складываются в большие перемены.</p>
        <button class="btn btn-primary" data-action="add-habit">${icon.plus(18)} Новая привычка</button>
      </div>`
    : '';

  return `
    <header class="page-head">
      <div>
        <button class="eyebrow eyebrow-btn" data-action="pick-date">${esc(fmtDayLong(day))}</button>
        <h1>${isToday ? 'Сегодня' : esc(day.toLocaleDateString('ru-RU', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase()))}</h1>
      </div>
      <div class="head-actions">
        ${!isToday ? `<button class="pill" data-action="go-today">Сегодня</button>` : ''}
        <button class="icon-btn" data-action="add-habit" aria-label="Новая привычка">${icon.plus(22)}</button>
      </div>
      <input type="date" id="date-picker" class="visually-hidden" max="${todayKey()}" value="${key}" tabindex="-1">
    </header>
    <nav class="week-strip">${strip}</nav>
    ${abstChips}
    ${summary}
    ${namazBanner()}
    ${state.reorder ? reorderList() : `
    ${due.length ? `<section class="list">${due.map((h) => habitCard(h, day)).join('')}</section>` : ''}
    ${other.length ? `<h3 class="section-title">Не по расписанию</h3><section class="list is-dim">${other.map((h) => habitCard(h, day)).join('')}</section>` : ''}
    ${habits.length > 1 ? `<div class="list-tools"><button class="link-btn small" data-action="reorder">Изменить порядок</button>${isToday ? `<button class="link-btn small" data-action="checkin">🌙 Вечерний чек-ин</button>` : ''}</div>` : ''}
    ${habits.length || abst.length ? `
      <div class="group-title">Заметка дня</div>
      <div class="card pad note-card"><textarea class="note-input" id="day-note" rows="2" placeholder="Как прошёл день? Что помогло, что мешало…">${esc(getData().notes[key]?.text || '')}</textarea></div>` : ''}`}
    ${empty}
  `;
}

// ---------- Объединение отдельных намазов ----------

const NAMAZ_ALIASES = {
  fajr: ['фаджр', 'фаджир', 'фajr', 'бомдод', 'утренний', 'сабах', 'fajr'],
  dhuhr: ['зухр', 'зохр', 'пешин', 'обеденный', 'dhuhr', 'zuhr'],
  asr: ['аср', 'asr'],
  maghrib: ['магриб', 'шом', 'вечерний', 'maghrib'],
  isha: ['иша', 'хуфтон', 'ночной', 'isha'],
};

function findNamazHabits() {
  const found = [];
  for (const h of habitsActive()) {
    if (hasStages(h)) continue;
    const n = h.name.toLowerCase().replace(/ё/g, 'е').replace(/намаз/g, '').trim();
    for (const [k, list] of Object.entries(NAMAZ_ALIASES)) if (list.includes(n)) found.push({ h, prayer: k });
  }
  return found;
}

function namazBanner() {
  if (state.reorder || dkey(state.day) !== todayKey()) return '';
  try {
    if (localStorage.getItem('myhabits:namaz-banner') === 'hide') return '';
  } catch {
    /* ignore */
  }
  const found = findNamazHabits();
  if (found.length < 3) return '';
  return `<section class="card pad banner">
    <div class="banner-title">🕌 Объединить намазы в одну привычку?</div>
    <p>Одна карточка «Намаз» с ${found.length === 5 ? '5 этапами' : 'этапами'}: время каждого намаза считается автоматически по твоему городу, напоминания приходят в начале намаза. Вся история сохранится.</p>
    <div class="btn-row"><button class="btn btn-primary" data-action="merge-namaz">Объединить</button><button class="btn btn-secondary" data-action="hide-namaz">Не сейчас</button></div>
  </section>`;
}

const VITR_STAGE = () => ({ id: 'p-vitr', name: 'Витр', role: 'vitr', min: 1, max: 1, remind: false, time: { mode: 'prayer', prayer: 'isha', minutes: 0 } });
const NAMAZ_STAGES = () => [
  ...PRAYERS.map((p) => ({ id: `p-${p.key}`, name: p.name, min: 1, max: 1, remind: true, time: { mode: 'prayer', prayer: p.key, minutes: 0 } })),
  VITR_STAGE(),
];

function mergeNamaz() {
  const found = findNamazHabits();
  const first = found[0]?.h;
  const stages = NAMAZ_STAGES();
  mergeIntoStaged(
    { name: 'Намаз', emoji: first?.emoji || '🕌', color: first?.color || COLORS[3], type: 'check', target: 1, unit: '', step: 1, schedule: { kind: 'daily', days: [1, 2, 3, 4, 5], times: 3 }, stages },
    found.map((x) => ({ habitId: x.h.id, stageId: `p-${x.prayer}` })),
  );
  haptic(20);
  toast('Готово: «Намаз» — 5 намазов и Витр');
}

// ---------- Порядок привычек (перетаскивание) ----------

function reorderList() {
  return `<div class="group-title">Перетащи за ≡, чтобы изменить порядок</div>
    <section class="card list-group reorder" id="reorder">${habitsActive()
      .map((h) => `<div class="row static ro-row" data-hid="${h.id}"><span class="emoji-chip" style="--c:${h.color}">${esc(h.emoji)}</span><div class="row-main"><b>${esc(h.name)}</b></div><span class="handle" aria-label="Перетащить">≡</span></div>`)
      .join('')}</section>
    <button class="btn btn-primary btn-block" data-action="reorder-done">Готово</button>`;
}

function mountReorder() {
  const box = document.getElementById('reorder');
  if (!box) return;
  box.querySelectorAll('.handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const row = handle.closest('.ro-row');
      const rows = [...box.querySelectorAll('.ro-row')];
      const from = rows.indexOf(row);
      const hgt = row.getBoundingClientRect().height;
      const startY = e.clientY;
      let to = from;
      row.classList.add('is-dragging');
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dy = ev.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        to = clamp(from + Math.round(dy / hgt), 0, rows.length - 1);
        rows.forEach((r, i) => {
          if (r === row) return;
          let shift = 0;
          if (from < to && i > from && i <= to) shift = -hgt;
          if (from > to && i < from && i >= to) shift = hgt;
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        rows.forEach((r) => (r.style.transform = ''));
        row.classList.remove('is-dragging');
        if (to !== from) {
          const ids = rows.map((r) => r.dataset.hid);
          ids.splice(to, 0, ids.splice(from, 1)[0]);
          haptic();
          reorderHabits(ids);
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  });
}

// ---------- Вечерний чек-ин ----------

function openCheckin() {
  openSheet({
    live: true,
    render: () => {
      const key = todayKey();
      const t = today();
      const left = habitsActive().filter((h) => isScheduled(h, t) && !isDone(h, key));
      const abst = abstainAll();
      return `
        <header class="sheet-header"><span></span><strong>Вечерний чек-ин</strong><button class="link-btn strong" data-c="close">Готово</button></header>
        <div class="sheet-body">
          <div class="group-title">${left.length ? 'Ещё не выполнено' : 'Привычки'}</div>
          <div class="card list-group">${left.length
            ? left.map((h) => `<button class="row" data-open="${h.id}"><span class="emoji-chip" style="--c:${h.color}">${esc(h.emoji)}</span><div class="row-main"><b>${esc(h.name)}</b><span class="muted">${h.type === 'check' && !hasStages(h) ? 'не отмечено' : `${fmtNum(valueOf(h, key))} из ${goalOf(h, key)}${hasStages(h) && h.type === 'check' ? ' этапов' : ''}`}</span></div>${icon.chevronR(18)}</button>`).join('')
            : `<div class="row static"><span>Всё выполнено — отличный день! 🎉</span></div>`}</div>
          ${abst.length ? `<div class="group-title">Воздержание сегодня</div>
          <div class="card list-group">${abst.map((a) => {
            const clean = isCleanDay(a, key);
            return `<div class="row static"><span class="emoji-chip" style="--c:${a.color}">${esc(a.emoji)}</span><div class="row-main"><b>${esc(a.name)}</b><span class="muted">${esc(fmtDuration(abstainElapsed(a)))} без срыва</span></div><button class="pill ${clean ? 'is-on' : ''}" style="--c:${a.color}" data-clean="${a.id}">${clean ? '✓ Чистый' : 'Чистый день'}</button></div>`;
          }).join('')}</div>` : ''}
          <div class="group-title">Заметка дня</div>
          <div class="card pad"><textarea class="note-input" data-c="note" rows="3" placeholder="Как прошёл день?">${esc(getData().notes[key]?.text || '')}</textarea></div>
        </div>`;
    },
    mount: (api) => {
      api.el.querySelector('[data-c=close]').onclick = () => api.close();
      api.el.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openHabitDetail(b.dataset.open)));
      api.el.querySelectorAll('[data-clean]').forEach((b) => (b.onclick = () => toggleClean(b.dataset.clean)));
      const note = api.el.querySelector('[data-c=note]');
      note.onchange = () => setNote(todayKey(), note.value.trim());
    },
  });
}

const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/** Этап, который отмечает кнопка на карточке. */
function tapStage(h, day) {
  const isToday = dkey(day) === todayKey();
  return currentStage(h, day, isToday ? nowMin() : 1440 * 2, dayContext(day));
}

const STATUS_CLASS = { ontime: 'is-done', late: 'is-done', qada: 'is-qada', missed: 'is-missed' };

function stageDots(h, day) {
  return `<span class="stage-dots">${stagesForDay(h, day)
    .map((s) => `<i class="${STATUS_CLASS[stageStatus(h, day, s)] || ''}" title="${esc(s.name)}"></i>`)
    .join('')}</span>`;
}

// ---------- Отметка намаза: каза / вовремя, Джума / Зухр ----------

function choiceSheet({ title, message = '', options }) {
  openSheet({
    className: 'sheet-compact',
    render: () => `<div class="sheet-body"><div class="confirm">
      <h3>${esc(title)}</h3>${message ? `<p>${message}</p>` : ''}
      ${options.map((o, i) => `<button class="btn btn-block ${o.primary ? 'btn-primary' : 'btn-secondary'} choice" data-i="${i}" ${o.color ? `style="--c:${o.color}"` : ''}>${o.label}</button>`).join('')}
      <button class="btn btn-block btn-plain" data-i="-1">Отмена</button>
    </div></div>`,
    mount: (api) => api.el.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => {
      api.close();
      const o = options[+b.dataset.i];
      if (o) o.run();
    })),
  });
}

/** Отметить этап; для намаза — с вопросами про каза и Джума. */
function markStage(h, date, s, { undo = true } = {}) {
  const key = dkey(date);
  const cur = getStageLog(h.id, key, s.id);
  const done = (k, label) => {
    haptic(k === 'qada' ? 20 : 10);
    setStageLog(h.id, key, s.id, 1, k);
    if (undo) toast(label, { action: 'Отменить', onAction: () => setStageLog(h.id, key, s.id, cur) });
  };
  const isPrayer = Boolean(prayerKeyOf(s));
  const expired = isPrayer && stageExpired(date, s);
  if (expired) {
    const name = s.juma ? 'Джума' : s.name;
    return choiceSheet({
      title: `${name} — время вышло`,
      message: `Время ${s.juma ? 'Зухра' : 'намаза'} закончилось в ${fmtMin(s.end)}${dkey(date) !== todayKey() ? ` (${fmtDateShort(date)})` : ''}. Как отметить?`,
      options: [
        { label: '🕰️ Каза — восполняю', primary: true, run: () => done('qada', `${s.juma ? 'Зухр' : name}: каза засчитан`) },
        { label: 'Читал вовремя, просто не отметил', run: () => done('late', `${name} отмечен`) },
      ],
    });
  }
  if (s.juma) {
    return choiceSheet({
      title: 'Пятничная молитва',
      options: [
        { label: '🕌 Джума', primary: true, run: () => done('juma', 'Джума отмечена') },
        { label: 'Зухр — не успел на Джума', run: () => done('dhuhr', 'Зухр отмечен') },
      ],
    });
  }
  done('', `${s.name} отмечен`);
}

function habitCard(h, day) {
  if (hasStages(h)) return stagedCard(h, day);
  const key = dkey(day);
  const isToday = key === todayKey();
  const running = isToday && getLocal().timers?.[h.id];
  const v = h.type === 'timer' ? runningValue(h, key) : valueOf(h, key);
  const g = goalOf(h, key);
  const done = v >= g;
  const sub = [];
  if (h.type === 'count') sub.push(`${fmtNum(v)} / ${h.target} ${esc(h.unit || '')}`.trim());
  if (h.type === 'timer') sub.push(`<span data-live-timer="${h.id}">${fmtClock(v)}</span> / ${h.target} мин`);
  if (h.schedule?.kind === 'perWeek') sub.push(`${doneInWeek(h, day)}/${h.schedule.times} за неделю`);
  const st = currentStreak(h);
  if (st.value > 0) sub.push(`<span class="streak">${icon.flame(13)} ${streakText(st)}</span>`);
  if (!sub.length) sub.push(esc(scheduleText(h)));

  let action;
  if (h.type === 'timer' && isToday && !done) {
    action = `<button class="act ${running ? 'is-running' : ''}" style="--c:${h.color}" data-action="habit-tap" data-id="${h.id}" aria-label="${running ? 'Пауза' : 'Старт'}">${running ? icon.pause(18) : icon.play(18)}</button>`;
  } else if (h.type === 'count' && !done) {
    action = `<button class="act" style="--c:${h.color}" data-action="habit-tap" data-id="${h.id}" aria-label="Добавить">${icon.plus(18)}</button>`;
  } else {
    action = `<button class="act act-check ${done ? 'is-done' : ''}" style="--c:${h.color}" data-action="habit-tap" data-id="${h.id}" aria-label="${done ? 'Снять отметку' : 'Отметить'}">${icon.check(18)}</button>`;
  }

  return `<article class="hcard ${done ? 'is-done' : ''}" data-action="open-habit" data-id="${h.id}" data-hid="${h.id}" style="--c:${h.color}">
    ${ring(v / g, { size: 46, stroke: 4.5, color: h.color, key: `h-${h.id}-${key}`, inner: `<span class="emoji">${esc(h.emoji)}</span>` })}
    <div class="hmain">
      <div class="hname">${esc(h.name)}</div>
      <div class="hsub">${sub.join('<span class="dot">·</span>')}</div>
    </div>
    ${action}
  </article>`;
}

function stagedCard(h, day) {
  const key = dkey(day);
  const v = valueOf(h, key);
  const g = goalOf(h, key);
  const done = v >= g;
  const ctx = dayContext(day);
  const st = tapStage(h, day);
  const sub = [];
  if (h.type === 'count') sub.push(`${fmtNum(v)} / ${h.target} ${esc(h.unit || '')}`.trim());
  if (st) {
    const t = st.start != null ? fmtMin(st.start) : '';
    const amount = h.type === 'count' ? ` · ${st.max && st.max !== st.min ? `${st.min}–${st.max}` : st.min}` : '';
    sub.push(`<span class="next-stage">${esc(st.name)}${t ? ` ${t}` : ''}${amount}</span>`);
  } else if (!done) {
    sub.push('все этапы отмечены');
  }
  const cs = currentStreak(h);
  if (cs.value > 0) sub.push(`<span class="streak">${icon.flame(13)} ${streakText(cs)}</span>`);
  if (isNamazHabit(h) && dkey(day) === todayKey()) {
    const debt = qadaDebt().total;
    if (debt) sub.push(`<span class="debt">каза ${debt}</span>`);
  }
  void ctx;

  const action = st
    ? `<button class="act ${h.type === 'check' ? 'act-check' : ''}" style="--c:${h.color}" data-action="habit-tap" data-id="${h.id}" aria-label="Отметить: ${esc(st.name)}">${h.type === 'check' ? icon.check(18) : icon.plus(18)}</button>`
    : `<button class="act act-check is-done" style="--c:${h.color}" data-action="open-habit" data-id="${h.id}" aria-label="Подробнее">${icon.check(18)}</button>`;

  return `<article class="hcard ${done ? 'is-done' : ''}" data-action="open-habit" data-id="${h.id}" data-hid="${h.id}" style="--c:${h.color}">
    ${ring(v / g, { size: 46, stroke: 4.5, color: h.color, key: `h-${h.id}-${key}`, inner: `<span class="emoji">${esc(h.emoji)}</span>` })}
    <div class="hmain">
      <div class="hname">${esc(h.name)}</div>
      <div class="hsub">${sub.join('<span class="dot">·</span>')}</div>
      ${stageDots(h, day)}
    </div>
    ${action}
  </article>`;
}

function habitTap(id) {
  const h = findHabit(id);
  if (!h) return;
  const key = dkey(state.day);
  const isToday = key === todayKey();
  const v = valueOf(h, key);
  const g = goalOf(h, key);
  haptic();
  if (hasStages(h)) {
    const st = tapStage(h, state.day);
    if (!st) return openHabitDetail(id);
    const cur = getStageLog(id, key, st.id);
    if (h.type === 'check') return markStage(h, state.day, st);
    return setStageLog(id, key, st.id, cur + (Number(h.step) || 1));
  }
  if (h.type === 'check') {
    if (v >= 1) {
      setLog(id, key, 0);
      return toast('Отметка снята', { action: 'Вернуть', onAction: () => setLog(id, key, 1) });
    }
    return setLog(id, key, 1);
  }
  // выполненную привычку не обнуляем случайным нажатием — открываем карточку
  if (v >= g) return openHabitDetail(id);
  if (h.type === 'count') return setLog(id, key, v + (Number(h.step) || 1));
  if (h.type === 'timer') {
    if (!isToday) return openHabitDetail(id);
    return toggleTimer(id);
  }
}

function toggleTimer(id) {
  if (getLocal().timers?.[id]) stopTimer(id);
  else updateLocal((l) => ((l.timers = l.timers || {}), (l.timers[id] = { at: Date.now() })));
}

function stopTimer(id) {
  const t = getLocal().timers?.[id];
  if (!t) return;
  const key = dkey(new Date(t.at));
  const add = Math.round((Date.now() - t.at) / 1000);
  updateLocal((l) => delete l.timers[id]);
  setLog(id, key, getLog(id, key) + add);
}

// ============================================================
// Карточка привычки (детально)
// ============================================================

function openHabitDetail(id) {
  openSheet({
    live: true,
    render: (api) => {
      const h = findHabit(id);
      if (!h) {
        setTimeout(() => api.close());
        return '';
      }
      const day = state.day;
      const key = dkey(day);
      const isToday = key === todayKey();
      const v = h.type === 'timer' ? runningValue(h, key) : valueOf(h, key);
      const g = goalOf(h, key);
      const running = isToday && getLocal().timers?.[h.id];
      const dayLabel = isToday ? 'Сегодня' : fmtDateShort(day);

      let editor = '';
      if (hasStages(h)) {
        editor = stageEditor(h, day);
      } else if (h.type === 'check') {
        editor = `<button class="btn btn-block ${v >= 1 ? 'btn-tinted' : 'btn-primary'}" style="--c:${h.color}" data-d="toggle">${v >= 1 ? `${icon.check(18)} Выполнено` : 'Отметить выполненной'}</button>`;
      } else if (h.type === 'count') {
        editor = `<div class="stepper-big">
          <button class="round-btn" data-d="dec" aria-label="Меньше">${icon.minus(22)}</button>
          <div class="stepper-val"><input type="number" inputmode="decimal" min="0" value="${fmtNum(v).replace(',', '.')}" data-d="input"><span>из ${h.target} ${esc(h.unit || '')}</span></div>
          <button class="round-btn" style="--c:${h.color}" data-d="inc" aria-label="Больше">${icon.plus(22)}</button>
        </div>`;
      } else {
        editor = `<div class="timer-big">
          <div class="timer-clock" data-live-timer="${h.id}">${fmtClock(v)}</div>
          <div class="timer-goal">цель ${h.target} мин</div>
          <div class="timer-controls">
            <button class="pill" data-d="sub5">−5 мин</button>
            ${isToday ? `<button class="round-btn round-lg ${running ? 'is-running' : ''}" style="--c:${h.color}" data-d="timer">${running ? icon.pause(26) : icon.play(26)}</button>` : ''}
            <button class="pill" data-d="add5">+5 мин</button>
          </div>
          ${v > 0 ? `<button class="link-btn" data-d="reset">Сбросить</button>` : ''}
        </div>`;
      }

      const cur = currentStreak(h);
      const best = bestStreak(h);
      return `
        <header class="sheet-header">
          <button class="link-btn" data-d="close">Закрыть</button>
          <span></span>
          <button class="link-btn" data-d="edit">Изменить</button>
        </header>
        <div class="sheet-body">
          <div class="hero">
            ${ring(v / g, { size: 96, stroke: 9, color: h.color, key: `detail-${h.id}-${key}`, inner: `<span class="emoji-lg">${esc(h.emoji)}</span>` })}
            <h2>${esc(h.name)}</h2>
            <p class="muted">${esc(scheduleText(h))}${goalText(h) ? ` · ${esc(goalText(h))}` : ''}</p>
          </div>
          <div class="group-title">${esc(dayLabel)}</div>
          <div class="card pad">${editor}</div>
          <div class="tiles">
            <div class="tile"><div class="tile-label">Текущая серия</div><div class="tile-val" style="color:${h.color}">${cur.value}<small>${cur.unit === 'weeks' ? ' нед.' : ` ${plural(cur.value, DAY_FORMS)}`}</small></div></div>
            <div class="tile"><div class="tile-label">Рекорд</div><div class="tile-val">${best.value}<small>${best.unit === 'weeks' ? ' нед.' : ` ${plural(best.value, DAY_FORMS)}`}</small></div></div>
            <div class="tile"><div class="tile-label">За 30 дней</div><div class="tile-val">${pct(rateOf(h, 30))}</div></div>
            <div class="tile"><div class="tile-label">Всего раз</div><div class="tile-val">${totalCompletions(h)}</div></div>
          </div>
          <div class="group-title">Последний год</div>
          <div class="card pad">${heatmap(habitHeatValue(h), h.color)}</div>
          ${isNamazHabit(h) ? qadaCard() + namazStatsCard(h) : ''}
          ${timeStatsCard(h)}
          <div class="card list-group">
            <button class="row" data-d="archive">${icon.archive(20)}<span>${h.archived ? 'Вернуть из архива' : 'В архив'}</span></button>
            <button class="row is-danger" data-d="delete">${icon.trash(20)}<span>Удалить привычку</span></button>
          </div>
        </div>`;
    },
    mount: (api) => {
      const h = findHabit(id);
      if (!h) return;
      const key = dkey(state.day);
      const q = (s) => api.el.querySelector(`[data-d=${s}]`);
      q('close').onclick = () => api.close();
      q('edit').onclick = () => openHabitEditor(h);
      const g = goalOf(h, key);
      const v = valueOf(h, key);
      if (q('toggle')) q('toggle').onclick = () => (haptic(), setLog(id, key, v >= 1 ? 0 : 1));
      if (q('inc')) q('inc').onclick = () => (haptic(), setLog(id, key, v + (Number(h.step) || 1)));
      if (q('dec')) q('dec').onclick = () => (haptic(), setLog(id, key, Math.max(0, v - (Number(h.step) || 1))));
      if (q('input')) q('input').onchange = (e) => setLog(id, key, Math.max(0, Number(String(e.target.value).replace(',', '.')) || 0));
      if (q('timer')) q('timer').onclick = () => (haptic(), toggleTimer(id));
      if (q('add5')) q('add5').onclick = () => setLog(id, key, getLog(id, key) + 300);
      if (q('sub5')) q('sub5').onclick = () => setLog(id, key, Math.max(0, getLog(id, key) - 300));
      if (q('reset')) q('reset').onclick = () => (stopTimer(id), setLog(id, key, 0));
      api.el.querySelectorAll('[data-st]').forEach((b) => (b.onclick = () => {
        haptic();
        const sid = b.dataset.st;
        const cur = getStageLog(id, key, sid);
        const step = Number(h.step) || 1;
        if (b.dataset.op === 'inc') setStageLog(id, key, sid, cur + step);
        else if (b.dataset.op === 'dec') setStageLog(id, key, sid, Math.max(0, cur - step));
        else if (cur >= 1) setStageLog(id, key, sid, 0);
        else {
          const s = stagesForDay(h, state.day).find((x) => x.id === sid);
          if (s) markStage(h, state.day, s, { undo: false });
        }
      }));
      api.el.querySelectorAll('[data-repay]').forEach((b) => (b.onclick = () => repayQada(b.dataset.repay)));
      q('archive').onclick = () => {
        upsertHabit({ id, archived: !h.archived });
        if (!h.archived) {
          api.close();
          toast('Привычка перемещена в архив', { action: 'Отменить', onAction: () => upsertHabit({ id, archived: false }) });
        }
      };
      q('delete').onclick = () =>
        confirmSheet({
          title: `Удалить «${h.name}»?`,
          message: 'Вся история этой привычки будет удалена без возможности восстановления. Если хочешь просто скрыть её — отправь в архив.',
          confirm: 'Удалить',
          destructive: true,
          onConfirm: () => {
            stopTimer(id);
            removeHabit(id);
            api.close();
          },
        });
      void g;
    },
  });
}

function stageEditor(h, day) {
  const key = dkey(day);
  const list = stagesForDay(h, day);
  return `<div class="stage-list">${list.map((s) => {
    const val = getStageLog(h.id, key, s.id);
    const ok = stageDone(h, key, s);
    const ev = stageMark(h, key, s);
    const status = stageStatus(h, day, s);
    const at = ev ? fmtMin(new Date(ev.ts).getHours() * 60 + new Date(ev.ts).getMinutes()) : '';
    const window_ = s.start != null ? `${fmtMin(s.start)}${s.end != null && s.time?.mode === 'prayer' ? `–${fmtMin(s.end)}` : ''}` : '';
    const kindLabel = ev?.k === 'juma' ? 'Джума · ' : ev?.k === 'dhuhr' ? 'Зухр вместо Джума · ' : '';
    const when = {
      ontime: `${kindLabel}отмечено в ${at}`,
      late: `${kindLabel}вовремя, отмечено в ${at}`,
      qada: `каза · восполнено в ${at}`,
      missed: `пропущен (${window_}) · долг каза`,
    }[status] || (ok && at ? `отмечено в ${at}` : window_);
    const range = s.max && s.max !== s.min ? `${s.min}–${s.max}` : `${s.min}`;
    const control = h.type === 'count'
      ? `<div class="mini-stepper"><button class="round-btn sm" data-st="${s.id}" data-op="dec" aria-label="Меньше">${icon.minus(14)}</button><span class="${ok ? 'is-ok' : ''}">${fmtNum(val)}<small>/${range}</small></span><button class="round-btn sm" style="--c:${h.color}" data-st="${s.id}" data-op="inc" aria-label="Больше">${icon.plus(14)}</button></div>`
      : `<button class="act act-check ${ok ? 'is-done' : ''}" style="--c:${status === 'qada' ? 'var(--orange)' : h.color}" data-st="${s.id}" aria-label="Отметить">${icon.check(16)}</button>`;
    return `<div class="stage-row ${ok ? 'is-ok' : ''} st-${status}"><div class="row-main"><b>${esc(s.name)}</b><span class="muted">${esc(when)}</span></div>${control}</div>`;
  }).join('')}</div>`;
}

// ---------- Каза ----------

function repayQada(p) {
  const debt = qadaDebt();
  const b = debt.byPrayer[p];
  if (!b || !b.total) return;
  haptic(20);
  if (b.missed.length) {
    // сначала закрываем самый старый пропуск по трекеру
    const m = b.missed[0];
    setStageLog(m.hid, m.day, m.sid, 1, 'qada');
    return toast(`${QADA_NAMES[p]} за ${fmtDateShort(parseKey(m.day))}: каза засчитан`, { action: 'Отменить', onAction: () => setStageLog(m.hid, m.day, m.sid, 0) });
  }
  addEvent(QADA_LOG, todayKey(), 1, p, Date.now(), 'qada');
  toast(`${QADA_NAMES[p]}: −1 из старого долга`, { action: 'Отменить', onAction: () => addEvent(QADA_LOG, todayKey(), -1, p) });
}

function qadaCard() {
  const d = qadaDebt();
  const goal = d.perDay;
  const rows = QADA_KEYS.filter((k) => d.byPrayer[k].total).map((k) => {
    const b = d.byPrayer[k];
    const parts = [];
    if (b.missed.length) parts.push(`по трекеру ${b.missed.length}`);
    if (b.oldLeft) parts.push(`старый долг ${b.oldLeft}`);
    return `<div class="row static"><div class="row-main"><b>${QADA_NAMES[k]} · ${b.total}</b><span class="muted">${parts.join(' · ')}</span></div><button class="pill qada-pill" data-repay="${k}">+ Восполнил</button></div>`;
  }).join('');
  let forecast = '';
  if (d.oldLeft && goal) {
    const days = Math.ceil(d.oldLeft / goal);
    forecast = `При ${goal} в день старый долг будет восполнен примерно к ${fmtDateShort(addDays(today(), days))} (${days} ${plural(days, DAY_FORMS)}).`;
  }
  return `<div class="group-title">Каза${d.total ? ` · долг ${d.total}` : ''}</div>
    ${d.total ? `<div class="card list-group">${rows}</div>` : `<div class="card pad"><p class="hint first center">Долгов каза нет — ма шаа Аллах 🤲</p></div>`}
    ${goal && d.oldLeft ? `<div class="card pad qada-goal"><div class="milestone-row"><span>Сегодня восполнено</span><span><b>${d.repaidToday}</b> из ${goal}</span></div><div class="progress" style="--c:var(--orange)"><div style="width:${Math.min(100, Math.round((d.repaidToday / goal) * 100))}%"></div></div>${forecast ? `<p class="hint">${forecast}</p>` : ''}</div>` : ''}
    <p class="hint">Пропущенные по трекеру намазы появляются здесь автоматически. Старые долги и цель в день — в Настройках → Время намаза.</p>`;
}

function namazStatsCard(h) {
  const s = namazStats(h, 30);
  const all = s.ontime + s.late + s.qada + s.missed;
  if (!all) return '';
  const pctOf = (n) => `${Math.round((n / all) * 100)}%`;
  return `<div class="group-title">Намазы · 30 дней</div>
    <div class="tiles">
      <div class="tile"><div class="tile-label">Вовремя</div><div class="tile-val" style="color:var(--green)">${pctOf(s.ontime + s.late)}</div></div>
      <div class="tile"><div class="tile-label">Каза</div><div class="tile-val" style="color:var(--orange)">${s.qada}</div></div>
      <div class="tile"><div class="tile-label">Пропущено</div><div class="tile-val" style="color:${s.missed ? 'var(--red)' : 'inherit'}">${s.missed}</div></div>
      <div class="tile"><div class="tile-label">Джума</div><div class="tile-val">${s.juma}<small> из ${s.fridays}</small></div></div>
    </div>
    ${s.late ? `<p class="hint">Отмечено с опозданием (но прочитано вовремя): ${s.late}.</p>` : ''}`;
}

function hoursChart(hours, color) {
  const max = Math.max(1, ...hours);
  return `<div class="hours">${barChart(hours.map((v, i) => ({ label: i % 6 === 0 ? String(i) : '', value: v ? v / max : null })), { color, height: 64 })}</div>`;
}

function timeStatsCard(h) {
  const t = timeStats(h, 60);
  if (!t.total) return '';
  const rows = t.stages.filter((s) => s.count).map((s) => {
    const all = s.onTime + s.late;
    return `<div class="row static"><div class="row-main"><b>${esc(s.name)}</b><span class="muted">обычно в ${fmtMin(s.median)} · отмечено ${s.count} ${plural(s.count, ['раз', 'раза', 'раз'])}</span></div>${all ? `<span class="row-val ${s.onTime / all >= 0.7 ? 'good' : ''}">${Math.round((s.onTime / all) * 100)}% вовремя</span>` : ''}</div>`;
  }).join('');
  return `<div class="group-title">Когда ты отмечаешь · 60 дней</div>
    <div class="card pad">${hoursChart(t.hours, h.color)}${t.median != null ? `<p class="hint center">Обычно выполняешь около <b>${fmtMin(t.median)}</b></p>` : ''}</div>
    ${rows ? `<div class="card list-group">${rows}</div>` : ''}`;
}

// ============================================================
// Редактор привычки
// ============================================================

function openHabitEditor(existing) {
  const isNew = !existing;
  const f = existing
    ? JSON.parse(JSON.stringify(existing))
    : { name: '', emoji: '💧', color: COLORS[7], type: 'check', target: 8, unit: '', step: 1, schedule: { kind: 'daily', days: [1, 2, 3, 4, 5], times: 3 } };
  f.schedule = { kind: 'daily', days: [1, 2, 3, 4, 5], times: 3, ...(f.schedule || {}) };
  if (f.type === 'timer' && !existing) f.target = 30;
  f.stages = Array.isArray(f.stages) ? f.stages : [];
  f.useStages = f.stages.length > 0;
  f.reminders = Array.isArray(f.reminders) ? f.reminders : [];

  openSheet({
    render: () => `
      <header class="sheet-header">
        <button class="link-btn" data-e="cancel">Отмена</button>
        <strong>${isNew ? 'Новая привычка' : 'Изменить'}</strong>
        <button class="link-btn strong" data-e="save" ${f.name.trim() ? '' : 'disabled'}>Готово</button>
      </header>
      <div class="sheet-body">
        <div class="hero-input" style="--c:${f.color}">
          <div class="emoji-badge">${esc(f.emoji)}</div>
          <input class="name-input" data-e="name" placeholder="Например, пить воду" value="${esc(f.name)}" maxlength="40" autocomplete="off">
        </div>

        <div class="group-title">Цвет</div>
        <div class="card pad"><div class="swatches">${COLORS.map((c) => `<button class="swatch ${c === f.color ? 'is-active' : ''}" style="--c:${c}" data-color="${c}" aria-label="Цвет"></button>`).join('')}</div></div>

        <div class="group-title">Иконка</div>
        <div class="card pad">
          <div class="emoji-grid">${HABIT_EMOJI.map((e) => `<button class="emoji-opt ${e === f.emoji ? 'is-active' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>
          <input class="field mt" data-e="emoji" placeholder="Или вставь свой эмодзи" value="" maxlength="8">
        </div>

        <div class="group-title">Тип</div>
        <div class="card pad">
          ${segmented('type', [{ value: 'check', label: 'Галочка' }, { value: 'count', label: 'Количество' }, { value: 'timer', label: 'Таймер' }], f.type)}
          ${f.type === 'count' ? `
            <div class="form-grid">
              <label><span>Цель в день</span><input class="field" type="number" min="1" inputmode="decimal" data-e="target" value="${esc(f.target)}"></label>
              <label><span>Единица</span><input class="field" data-e="unit" placeholder="стаканов" value="${esc(f.unit)}" maxlength="16"></label>
              <label><span>Шаг кнопки +</span><input class="field" type="number" min="0.1" step="any" inputmode="decimal" data-e="step" value="${esc(f.step || 1)}"></label>
            </div>` : ''}
          ${f.type === 'timer' ? `
            <div class="form-grid">
              <label><span>Минут в день</span><input class="field" type="number" min="1" inputmode="numeric" data-e="target" value="${esc(f.target)}"></label>
            </div>` : ''}
          <p class="hint">${{ check: 'Просто отмечай, что сделал.', count: 'Например: 8 стаканов воды, 20 страниц, 10 000 шагов.', timer: 'Встроенный секундомер копит время за день.' }[f.type]}</p>
        </div>

        <div class="group-title">Расписание</div>
        <div class="card pad">
          ${segmented('sched', [{ value: 'daily', label: 'Каждый день' }, { value: 'weekdays', label: 'Дни недели' }, { value: 'perWeek', label: 'N в неделю' }], f.schedule.kind)}
          ${f.schedule.kind === 'weekdays' ? `<div class="chips">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button class="chip ${f.schedule.days.includes(d) ? 'is-active' : ''}" style="--c:${f.color}" data-wd="${d}">${WEEKDAYS_SHORT[d]}</button>`).join('')}</div>` : ''}
          ${f.schedule.kind === 'perWeek' ? `<div class="inline-stepper"><button class="round-btn sm" data-e="tm">${icon.minus(16)}</button><span><b>${f.schedule.times}</b> ${plural(f.schedule.times, ['раз', 'раза', 'раз'])} в неделю</span><button class="round-btn sm" data-e="tp">${icon.plus(16)}</button></div>` : ''}
        </div>
        ${stagesSection(f)}
      </div>`,
    mount: (api) => {
      const el = api.el;
      const q = (s) => el.querySelector(`[data-e=${s}]`);
      const saveBtn = q('save');
      q('cancel').onclick = () => api.close();
      q('name').oninput = (e) => {
        f.name = e.target.value;
        saveBtn.disabled = !f.name.trim();
      };
      q('emoji').oninput = (e) => {
        const v = e.target.value.trim();
        if (v) {
          f.emoji = [...v].slice(0, 2).join('');
          el.querySelector('.emoji-badge').textContent = f.emoji;
          el.querySelectorAll('.emoji-opt').forEach((b) => b.classList.remove('is-active'));
        }
      };
      ['target', 'unit', 'step'].forEach((k) => {
        if (q(k)) q(k).oninput = (e) => (f[k] = e.target.value);
      });
      el.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => ((f.color = b.dataset.color), api.refresh())));
      el.querySelectorAll('[data-emoji]').forEach((b) => (b.onclick = () => ((f.emoji = b.dataset.emoji), api.refresh())));
      el.querySelectorAll('[data-seg=type] button').forEach((b) => (b.onclick = () => {
        f.type = b.dataset.value;
        if (f.type === 'timer' && (!f.target || Number(f.target) === 8)) f.target = 30;
        if (f.type === 'count' && Number(f.target) === 30) f.target = 8;
        api.refresh();
      }));
      el.querySelectorAll('[data-seg=sched] button').forEach((b) => (b.onclick = () => ((f.schedule.kind = b.dataset.value), api.refresh())));
      el.querySelectorAll('[data-wd]').forEach((b) => (b.onclick = () => {
        const d = Number(b.dataset.wd);
        const s = new Set(f.schedule.days);
        s.has(d) ? s.delete(d) : s.add(d);
        if (s.size) f.schedule.days = [...s];
        api.refresh();
      }));
      mountStagesSection(el, f, api);
      if (q('tm')) q('tm').onclick = () => ((f.schedule.times = clamp(f.schedule.times - 1, 1, 6)), api.refresh());
      if (q('tp')) q('tp').onclick = () => ((f.schedule.times = clamp(f.schedule.times + 1, 1, 6)), api.refresh());
      saveBtn.onclick = () => {
        if (!f.name.trim()) return;
        const out = {
          name: f.name.trim(),
          emoji: f.emoji || '✅',
          color: f.color,
          type: f.type,
          target: f.type === 'check' ? 1 : Math.max(f.type === 'timer' ? 1 : 0.1, Number(String(f.target).replace(',', '.')) || 1),
          unit: f.type === 'count' ? String(f.unit || '').trim() : '',
          step: f.type === 'count' ? Math.max(0.1, Number(String(f.step).replace(',', '.')) || 1) : 1,
          schedule: { kind: f.schedule.kind, days: [...f.schedule.days].sort(), times: f.schedule.times },
          stages: f.type !== 'timer' && f.useStages ? f.stages.filter((x) => x.name.trim()).map((x) => ({
            id: x.id || uid(),
            role: x.role,
            since: x.since,
            name: x.name.trim(),
            min: f.type === 'count' ? Math.max(1, Number(x.min) || 1) : 1,
            max: f.type === 'count' ? Math.max(Number(x.min) || 1, Number(x.max) || Number(x.min) || 1) : 1,
            remind: x.remind !== false,
            time: x.time,
          })) : [],
          reminders: f.useStages && f.type !== 'timer' ? [] : f.reminders,
        };
        if (existing) out.id = existing.id;
        upsertHabit(out);
        haptic(12);
        api.close();
      };
      if (isNew && !f.name) setTimeout(() => q('name')?.focus(), 320);
    },
  });
}

// ---------- Этапы и напоминания в редакторе ----------

const MODE_OPTS = [
  ['fixed', 'Точное время'],
  ['afterWake', 'После подъёма'],
  ['beforeSleep', 'До сна'],
  ['prayer', 'Время намаза'],
];

function timePicker(t, path) {
  const mode = t.mode || 'fixed';
  let extra = '';
  if (mode === 'fixed') extra = `<input class="field" type="time" data-tp="${path}" data-tf="at" value="${esc(t.at || '09:00')}">`;
  else if (mode === 'prayer') {
    extra = `<select class="field" data-tp="${path}" data-tf="prayer">${PRAYERS.map((p) => `<option value="${p.key}" ${t.prayer === p.key ? 'selected' : ''}>${p.name}</option>`).join('')}</select>
      <label class="unit-field"><input class="field" type="number" inputmode="numeric" data-tp="${path}" data-tf="minutes" value="${esc(t.minutes || 0)}"><span>мин</span></label>`;
  } else {
    extra = `<label class="unit-field"><input class="field" type="number" min="0" inputmode="numeric" data-tp="${path}" data-tf="minutes" value="${esc(t.minutes || 0)}"><span>${mode === 'afterWake' ? 'мин после' : 'мин до'}</span></label>`;
  }
  return `<div class="time-picker"><select class="field" data-tp="${path}" data-tf="mode">${MODE_OPTS.map(([v, l]) => `<option value="${v}" ${v === mode ? 'selected' : ''}>${l}</option>`).join('')}</select>${extra}</div>`;
}

const WATER_TEMPLATE = [
  ['После пробуждения', 1, 2, { mode: 'afterWake', minutes: 10 }],
  ['Завтрак', 1, 1, { mode: 'afterWake', minutes: 45 }],
  ['Середина утра', 1, 1, { mode: 'afterWake', minutes: 180 }],
  ['Обед', 1, 1, { mode: 'fixed', at: '13:00' }],
  ['День', 1, 2, { mode: 'fixed', at: '16:00' }],
  ['Вечер', 1, 2, { mode: 'beforeSleep', minutes: 90 }],
];

function stagesSection(f) {
  if (f.type === 'timer') return remindersSection(f);
  const stages = f.stages
    .map((st, i) => `<div class="stage-edit">
      <div class="stage-edit-top">
        <input class="field" data-si="${i}" data-sf="name" value="${esc(st.name)}" placeholder="Название этапа" maxlength="30">
        <button class="icon-btn sm danger" data-sdel="${i}" aria-label="Удалить этап">${icon.close(16)}</button>
      </div>
      ${f.type === 'count' ? `<div class="minmax"><label><span>мин.</span><input class="field" type="number" min="1" inputmode="numeric" data-si="${i}" data-sf="min" value="${esc(st.min ?? 1)}"></label><label><span>макс.</span><input class="field" type="number" min="1" inputmode="numeric" data-si="${i}" data-sf="max" value="${esc(st.max ?? st.min ?? 1)}"></label><span class="muted small">${esc(f.unit || '')}</span></div>` : ''}
      ${timePicker(st.time || {}, `s${i}`)}
      <label class="switch-row"><span>Напоминать</span><input type="checkbox" class="switch" data-si="${i}" data-sf="remind" ${st.remind !== false ? 'checked' : ''}></label>
    </div>`)
    .join('');
  return `
    <div class="group-title">Этапы в течение дня</div>
    <div class="card pad">
      <label class="switch-row"><span><b>Разбить на этапы</b><br><span class="muted small">Например, 5 намазов или вода: утро, обед, вечер</span></span><input type="checkbox" class="switch" data-e="useStages" ${f.useStages ? 'checked' : ''}></label>
      ${f.useStages ? `
        ${stages}
        <div class="btn-row">
          <button class="btn btn-secondary" data-e="addStage">${icon.plus(16)} Этап</button>
          ${f.type === 'check' ? `<button class="btn btn-secondary" data-e="tplNamaz">🕌 Намазы + Витр</button>` : `<button class="btn btn-secondary" data-e="tplWater">💧 Вода по режиму</button>`}
        </div>
        <p class="hint">${f.type === 'count' ? 'Этап засчитан, когда выполнен минимум; всё сверх — в общий счёт дня.' : 'Привычка выполнена, когда отмечены все этапы.'} Время «после подъёма» и «до сна» берётся из Настроек → Режим дня.</p>` : ''}
    </div>
    ${f.useStages ? '' : remindersSection(f)}`;
}

function remindersSection(f) {
  return `
    <div class="group-title">Напоминания</div>
    <div class="card pad">
      ${f.reminders.map((r, i) => `<div class="reminder-row">${timePicker(r, `r${i}`)}<button class="icon-btn sm danger" data-rdel="${i}" aria-label="Удалить">${icon.close(16)}</button></div>`).join('')}
      <button class="btn btn-secondary" data-e="addReminder">${icon.plus(16)} Напоминание</button>
      <p class="hint">Не приходят, если привычка уже выполнена. Нужно подключить уведомления в Настройках.</p>
    </div>`;
}

function mountStagesSection(el, f, api) {
  const target = (path) => (path[0] === 's' ? (f.stages[+path.slice(1)].time = f.stages[+path.slice(1)].time || { mode: 'fixed', at: '09:00' }) : f.reminders[+path.slice(1)]);
  el.querySelectorAll('[data-tp]').forEach((inp) => {
    inp.onchange = () => {
      const t = target(inp.dataset.tp);
      const field = inp.dataset.tf;
      t[field] = field === 'minutes' ? Number(inp.value) || 0 : inp.value;
      if (field === 'mode') {
        if (t.mode === 'prayer' && !t.prayer) t.prayer = 'fajr';
        if (t.mode === 'fixed' && !t.at) t.at = '09:00';
        api.refresh();
      }
    };
  });
  el.querySelectorAll('[data-sf]').forEach((inp) => {
    const st = f.stages[+inp.dataset.si];
    const field = inp.dataset.sf;
    if (field === 'remind') inp.onchange = () => (st.remind = inp.checked);
    else inp.oninput = () => (st[field] = field === 'name' ? inp.value : Number(inp.value) || 1);
  });
  el.querySelectorAll('[data-sdel]').forEach((b) => (b.onclick = () => (f.stages.splice(+b.dataset.sdel, 1), api.refresh())));
  el.querySelectorAll('[data-rdel]').forEach((b) => (b.onclick = () => (f.reminders.splice(+b.dataset.rdel, 1), api.refresh())));
  const q = (s) => el.querySelector(`[data-e=${s}]`);
  if (q('useStages')) q('useStages').onchange = (e) => {
    f.useStages = e.target.checked;
    if (f.useStages && !f.stages.length) f.stages.push({ id: uid(), name: 'Утро', min: 1, max: 1, remind: true, time: { mode: 'afterWake', minutes: 0 } });
    api.refresh();
  };
  if (q('addStage')) q('addStage').onclick = () => (f.stages.push({ id: uid(), name: '', min: 1, max: 1, remind: true, time: { mode: 'fixed', at: '12:00' } }), api.refresh());
  if (q('addReminder')) q('addReminder').onclick = () => (f.reminders.push({ mode: 'fixed', at: '09:00' }), api.refresh());
  if (q('tplNamaz')) q('tplNamaz').onclick = () => {
    f.stages = NAMAZ_STAGES();
    if (!f.name.trim()) f.name = 'Намаз';
    api.refresh();
  };
  if (q('tplWater')) q('tplWater').onclick = () => {
    f.stages = WATER_TEMPLATE.map(([name, min, max, time]) => ({ id: uid(), name, min, max, remind: true, time: { ...time } }));
    if (!f.unit) f.unit = 'стаканов';
    if (!f.name.trim()) f.name = 'Вода';
    api.refresh();
  };
}

// ============================================================
// Экран «Воздержание»
// ============================================================

function timerHTML(ms) {
  const p = durationParts(ms);
  return `${p.d ? `<span>${p.d}<small>${plural(p.d, ['день', 'дня', 'дней'])}</small></span>` : ''}<span>${pad(p.h)}<small>ч</small></span><span>${pad(p.m)}<small>мин</small></span><span>${pad(p.s)}<small>сек</small></span>`;
}

function viewAbstain() {
  const list = abstainAll();
  const tk = todayKey();
  const cards = list
    .map((a) => {
      const el = abstainElapsed(a);
      const mi = milestoneInfo(el);
      const clean = isCleanDay(a, tk);
      return `<article class="acard" style="--c:${a.color}" data-action="open-abstain" data-id="${a.id}">
        <div class="acard-top">
          <div class="acard-title"><span class="emoji-chip">${esc(a.emoji)}</span><span>${esc(a.name)}</span></div>
          <div class="acard-best">Рекорд · ${fmtDuration(abstainBest(a))}</div>
        </div>
        <div class="atimer" data-live-abs="${a.id}">${timerHTML(el)}</div>
        <div class="milestone">
          <div class="milestone-row"><span>${mi.reached ? `✓ ${mi.reached.label}` : 'Первая веха'}</span><span>${mi.next ? `далее: ${mi.next.label}` : 'Все вехи пройдены 👑'}</span></div>
          <div class="progress"><div style="width:${Math.round(mi.progress * 100)}%" data-live-abs-progress="${a.id}"></div></div>
        </div>
        <div class="acard-actions">
          <button class="btn ${clean ? 'btn-tinted' : 'btn-primary'}" data-action="clean-today" data-id="${a.id}">${clean ? `${icon.check(17)} Чистый день` : 'Отметить чистый день'}</button>
          <button class="btn btn-ghost-danger" data-action="relapse" data-id="${a.id}">Срыв</button>
        </div>
        <div class="acard-foot">${(a.cleanDays || []).length} ${plural((a.cleanDays || []).length, ['чистый день', 'чистых дня', 'чистых дней'])} · ${(a.attempts || []).length + 1}-я попытка</div>
      </article>`;
    })
    .join('');

  return `
    <header class="page-head">
      <div><div class="eyebrow">Сила воли</div><h1>Воздержание</h1></div>
      <div class="head-actions"><button class="icon-btn" data-action="add-abstain" aria-label="Добавить">${icon.plus(22)}</button></div>
    </header>
    ${cards ? `<section class="stack">${cards}</section>` : `
      <div class="empty">
        <div class="empty-emoji">🛡️</div>
        <h2>От чего хочешь отказаться?</h2>
        <p>Курение, алкоголь, сладкое, соцсети — добавь привычку, и таймер начнёт отсчёт времени без срыва.</p>
        <button class="btn btn-primary" data-action="add-abstain">${icon.plus(18)} Добавить</button>
      </div>`}
  `;
}

function toggleClean(id, key = todayKey()) {
  const a = findAbstain(id);
  if (!a) return;
  haptic();
  const set = new Set(a.cleanDays || []);
  set.has(key) ? set.delete(key) : set.add(key);
  upsertAbstain({ id, cleanDays: [...set].sort() });
}

function relapse(id) {
  const a = findAbstain(id);
  if (!a) return;
  const el = abstainElapsed(a);
  confirmSheet({
    title: 'Записать срыв?',
    message: `Эта попытка длилась <b>${fmtDuration(el)}</b>. Рекорд, история и чистые дни сохранятся — срыв не обнуляет пройденный путь.`,
    extra: `<textarea class="field" rows="3" data-note placeholder="Что спровоцировало? (необязательно)"></textarea>`,
    confirm: 'Записать срыв',
    destructive: true,
    onConfirm: (root) => {
      const note = root.querySelector('[data-note]').value.trim();
      const snapshot = JSON.parse(JSON.stringify(a));
      const now = Date.now();
      upsertAbstain({
        id,
        attempts: [...(a.attempts || []), { start: a.startedAt, end: now, note }],
        startedAt: now,
        cleanDays: (a.cleanDays || []).filter((d) => d !== todayKey()),
      });
      haptic(20);
      toast('Новая попытка началась. Ты справишься 💪', { action: 'Отменить', onAction: () => upsertAbstain(snapshot) });
    },
  });
}

function openAbstainEditor(existing) {
  const isNew = !existing;
  const f = existing ? { ...existing } : { name: '', emoji: '🚭', color: COLORS[3], startedAt: Date.now() };
  const toLocalInput = (ts) => {
    const d = new Date(ts);
    return `${dkey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  openSheet({
    render: () => `
      <header class="sheet-header">
        <button class="link-btn" data-e="cancel">Отмена</button>
        <strong>${isNew ? 'Отказ от привычки' : 'Изменить'}</strong>
        <button class="link-btn strong" data-e="save" ${f.name.trim() ? '' : 'disabled'}>Готово</button>
      </header>
      <div class="sheet-body">
        <div class="hero-input" style="--c:${f.color}">
          <div class="emoji-badge">${esc(f.emoji)}</div>
          <input class="name-input" data-e="name" placeholder="Например, курение" value="${esc(f.name)}" maxlength="40" autocomplete="off">
        </div>
        <div class="group-title">Начало воздержания</div>
        <div class="card pad">
          <input class="field" type="datetime-local" data-e="start" value="${toLocalInput(f.startedAt)}" max="${toLocalInput(Date.now())}">
          <p class="hint">Если ты уже держишься какое-то время — укажи, с какого момента.</p>
        </div>
        <div class="group-title">Цвет</div>
        <div class="card pad"><div class="swatches">${COLORS.map((c) => `<button class="swatch ${c === f.color ? 'is-active' : ''}" style="--c:${c}" data-color="${c}" aria-label="Цвет"></button>`).join('')}</div></div>
        <div class="group-title">Иконка</div>
        <div class="card pad">
          <div class="emoji-grid">${ABSTAIN_EMOJI.map((e) => `<button class="emoji-opt ${e === f.emoji ? 'is-active' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>
          <input class="field mt" data-e="emoji" placeholder="Или вставь свой эмодзи" maxlength="8">
        </div>
      </div>`,
    mount: (api) => {
      const el = api.el;
      const q = (s) => el.querySelector(`[data-e=${s}]`);
      const saveBtn = q('save');
      q('cancel').onclick = () => api.close();
      q('name').oninput = (e) => {
        f.name = e.target.value;
        saveBtn.disabled = !f.name.trim();
      };
      q('start').onchange = (e) => {
        const ts = new Date(e.target.value).getTime();
        if (!Number.isNaN(ts)) f.startedAt = Math.min(ts, Date.now());
      };
      q('emoji').oninput = (e) => {
        const v = e.target.value.trim();
        if (v) {
          f.emoji = [...v].slice(0, 2).join('');
          el.querySelector('.emoji-badge').textContent = f.emoji;
        }
      };
      el.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => ((f.color = b.dataset.color), api.refresh())));
      el.querySelectorAll('[data-emoji]').forEach((b) => (b.onclick = () => ((f.emoji = b.dataset.emoji), api.refresh())));
      saveBtn.onclick = () => {
        if (!f.name.trim()) return;
        upsertAbstain({ ...(existing ? { id: existing.id } : {}), name: f.name.trim(), emoji: f.emoji, color: f.color, startedAt: f.startedAt });
        haptic(12);
        api.close();
      };
      if (isNew && !f.name) setTimeout(() => q('name')?.focus(), 320);
    },
  });
}

function openAbstainDetail(id) {
  let month = new Date(today().getFullYear(), today().getMonth(), 1);
  openSheet({
    live: true,
    render: (api) => {
      const a = findAbstain(id);
      if (!a) {
        setTimeout(() => api.close());
        return '';
      }
      const el = abstainElapsed(a);
      const best = abstainBest(a);
      const attempts = [...(a.attempts || [])].reverse();
      const relapses = relapseDays(a);
      const days = el / 86400000;
      const bestDays = best / 86400000;

      // календарь месяца
      const first = startOfWeek(month);
      const tk = todayKey();
      let cal = WEEKDAYS_SHORT.slice(1).concat(WEEKDAYS_SHORT[0]).map((d) => `<div class="cal-h">${d}</div>`).join('');
      for (let i = 0; i < 42; i++) {
        const d = addDays(first, i);
        if (i >= 35 && d.getMonth() !== month.getMonth()) break;
        const k = dkey(d);
        const inMonth = d.getMonth() === month.getMonth();
        const future = k > tk;
        const cls = [
          'cal-d',
          inMonth ? '' : 'is-out',
          isCleanDay(a, k) ? 'is-clean' : '',
          relapses.has(k) ? 'is-relapse' : '',
          k === tk ? 'is-today' : '',
          future ? 'is-future' : '',
        ].join(' ');
        cal += `<button class="${cls}" ${future ? 'disabled' : ''} data-cal="${k}">${d.getDate()}</button>`;
      }

      return `
        <header class="sheet-header">
          <button class="link-btn" data-d="close">Закрыть</button>
          <span></span>
          <button class="link-btn" data-d="edit">Изменить</button>
        </header>
        <div class="sheet-body">
          <div class="hero" style="--c:${a.color}">
            <div class="emoji-xl">${esc(a.emoji)}</div>
            <h2>${esc(a.name)}</h2>
            <div class="atimer atimer-lg" data-live-abs="${a.id}">${timerHTML(el)}</div>
            <p class="muted">без срыва с ${esc(fmtDateTime(a.startedAt))}</p>
          </div>
          <div class="tiles">
            <div class="tile"><div class="tile-label">Рекорд</div><div class="tile-val" style="color:${a.color}">${esc(fmtDuration(best))}</div></div>
            <div class="tile"><div class="tile-label">Чистых дней</div><div class="tile-val">${(a.cleanDays || []).length}</div></div>
            <div class="tile"><div class="tile-label">Попытка</div><div class="tile-val">${(a.attempts || []).length + 1}-я</div></div>
            <div class="tile"><div class="tile-label">Срывов</div><div class="tile-val">${(a.attempts || []).length}</div></div>
          </div>

          <div class="group-title">Вехи</div>
          <div class="card pad"><div class="milestones">${MILESTONES.map((m) => {
            const now = days >= m.days;
            const ever = bestDays >= m.days;
            return `<div class="ms ${now ? 'is-now' : ever ? 'is-ever' : ''}" style="--c:${a.color}"><span class="ms-dot">${now || ever ? icon.check(12) : ''}</span>${m.label}</div>`;
          }).join('')}</div>
          <p class="hint">Цветные — пройдены в текущей попытке, обведённые — в рекордной.</p></div>

          <div class="group-title">Календарь</div>
          <div class="card pad">
            <div class="cal-nav">
              <button class="icon-btn sm" data-d="prev" aria-label="Предыдущий месяц">${icon.chevronL(18)}</button>
              <strong>${MONTHS[month.getMonth()].replace(/^./, (c) => c.toUpperCase())} ${month.getFullYear()}</strong>
              <button class="icon-btn sm" data-d="next" aria-label="Следующий месяц" ${month.getFullYear() === today().getFullYear() && month.getMonth() === today().getMonth() ? 'disabled' : ''}>${icon.chevronR(18)}</button>
            </div>
            <div class="cal" style="--c:${a.color}">${cal}</div>
            <div class="legend"><span><i class="lg-clean" style="--c:${a.color}"></i>чистый день</span><span><i class="lg-relapse"></i>срыв</span></div>
            <p class="hint">Нажми на день, чтобы отметить или снять «чистый день».</p>
          </div>

          <div class="group-title">История попыток</div>
          <div class="card list-group">
            <div class="row static"><div class="row-main"><b>Текущая · ${esc(fmtDuration(el))}</b><span class="muted">с ${esc(fmtDateTime(a.startedAt))}</span></div></div>
            ${attempts.map((t) => `<div class="row static"><div class="row-main"><b>${esc(fmtDuration(t.end - t.start))}</b><span class="muted">${esc(fmtDateShort(new Date(t.start)))} — ${esc(fmtDateShort(new Date(t.end)))}</span>${t.note ? `<span class="note">«${esc(t.note)}»</span>` : ''}</div>${t.end - t.start >= best - 1 ? '<span class="badge">рекорд</span>' : ''}</div>`).join('')}
          </div>

          <div class="card list-group">
            <button class="row is-danger" data-d="delete">${icon.trash(20)}<span>Удалить</span></button>
          </div>
        </div>`;
    },
    mount: (api) => {
      const a = findAbstain(id);
      if (!a) return;
      const q = (s) => api.el.querySelector(`[data-d=${s}]`);
      q('close').onclick = () => api.close();
      q('edit').onclick = () => openAbstainEditor(a);
      q('prev').onclick = () => ((month = new Date(month.getFullYear(), month.getMonth() - 1, 1)), api.refresh());
      q('next').onclick = () => ((month = new Date(month.getFullYear(), month.getMonth() + 1, 1)), api.refresh());
      api.el.querySelectorAll('[data-cal]').forEach((b) => (b.onclick = () => toggleClean(id, b.dataset.cal)));
      q('delete').onclick = () =>
        confirmSheet({
          title: `Удалить «${a.name}»?`,
          message: 'Таймер, история попыток и чистые дни будут удалены.',
          confirm: 'Удалить',
          destructive: true,
          onConfirm: () => {
            removeAbstain(id);
            api.close();
          },
        });
    },
  });
}

// ============================================================
// Экран «Статистика»
// ============================================================

function viewStats() {
  const habits = habitsActive();
  const abst = abstainAll();
  if (!habits.length && !abst.length) {
    return `
      <header class="page-head"><div><div class="eyebrow">Обзор</div><h1>Статистика</h1></div></header>
      <div class="empty"><div class="empty-emoji">📊</div><h2>Пока нет данных</h2><p>Добавь привычки — здесь появятся серии, проценты, тепловая карта и достижения.</p></div>`;
  }
  const t = today();
  const ach = achievements();
  const bars = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(t, i - 13);
    return { label: weekdayLetter(d), value: dayStats(d).ratio, highlight: i === 13 };
  });
  const td = dayStats(t);
  let bestCur = 0;
  for (const h of habits) {
    const c = currentStreak(h);
    bestCur = Math.max(bestCur, c.unit === 'weeks' ? c.value * 7 : c.value);
  }

  const habitRows = habits
    .map((h) => {
      const cur = currentStreak(h);
      const best = bestStreak(h);
      const r = rateOf(h, 30);
      return `<button class="row" data-action="open-habit" data-id="${h.id}">
        ${ring(r ?? 0, { size: 36, stroke: 3.5, color: h.color, key: `st-${h.id}`, inner: `<span class="emoji-sm">${esc(h.emoji)}</span>` })}
        <div class="row-main"><b>${esc(h.name)}</b><span class="muted">${icon.flame(12)} ${streakText(cur)} · рекорд ${streakText(best)}</span></div>
        <span class="row-val">${pct(r)}</span>
      </button>`;
    })
    .join('');

  const abstRows = abst
    .map((a) => `<button class="row" data-action="open-abstain" data-id="${a.id}">
        <span class="emoji-chip" style="--c:${a.color}">${esc(a.emoji)}</span>
        <div class="row-main"><b>${esc(a.name)}</b><span class="muted">рекорд ${esc(fmtDuration(abstainBest(a)))} · ${(a.cleanDays || []).length} ${plural((a.cleanDays || []).length, ['чистый день', 'чистых дня', 'чистых дней'])}</span></div>
        <span class="row-val" data-live-abs-short="${a.id}">${esc(fmtDuration(abstainElapsed(a)))}</span>
      </button>`)
    .join('');

  const unlocked = ach.list.filter((x) => x.ok).length;

  return `
    <header class="page-head"><div><div class="eyebrow">Обзор</div><h1>Статистика</h1></div></header>
    ${habits.length ? `
    <div class="tiles">
      <div class="tile"><div class="tile-label">Сегодня</div><div class="tile-val" style="color:var(--green)">${pct(td.ratio)}</div></div>
      <div class="tile"><div class="tile-label">7 дней</div><div class="tile-val">${pct(rangeRate(7))}</div></div>
      <div class="tile"><div class="tile-label">30 дней</div><div class="tile-val">${pct(rangeRate(30))}</div></div>
      <div class="tile"><div class="tile-label">Лучшая текущая серия</div><div class="tile-val" style="color:var(--orange)">${bestCur}<small> ${plural(bestCur, DAY_FORMS)}</small></div></div>
    </div>
    <div class="group-title">Последние 14 дней</div>
    <div class="card pad">${barChart(bars, { color: 'var(--green)' })}</div>
    <div class="group-title">Год</div>
    <div class="card pad">${heatmap(overallHeatValue(), 'var(--green)')}</div>
    ${hoursOverview()}
    <div class="group-title">Привычки · за 30 дней</div>
    <div class="card list-group">${habitRows}</div>` : ''}
    ${abst.length ? `<div class="group-title">Воздержание</div><div class="card list-group">${abstRows}</div>` : ''}
    <div class="group-title">Достижения · ${unlocked} из ${ach.list.length}</div>
    <div class="ach-grid">${ach.list.map((x) => `<div class="ach ${x.ok ? 'is-ok' : ''}"><div class="ach-emoji">${x.emoji}</div><b>${esc(x.title)}</b><span>${esc(x.desc)}</span></div>`).join('')}</div>
  `;
}

function hoursOverview() {
  const hours = overallHours(30);
  const total = hours.reduce((a, b) => a + b, 0);
  if (!total) return '';
  const peak = hours.indexOf(Math.max(...hours));
  const morning = hours.slice(5, 12).reduce((a, b) => a + b, 0);
  const evening = hours.slice(18, 24).reduce((a, b) => a + b, 0);
  return `<div class="group-title">Когда ты отмечаешь · 30 дней</div>
    <div class="card pad">${hoursChart(hours, 'var(--accent)')}
      <p class="hint center">Чаще всего — с ${pad(peak)}:00 до ${pad((peak + 1) % 24)}:00 · утром ${Math.round((morning / total) * 100)}%, вечером ${Math.round((evening / total) * 100)}%</p></div>`;
}

// ============================================================
// Экран «Настройки»
// ============================================================

function syncStatusHTML() {
  const s = sync.getStatus();
  const map = {
    off: ['gray', 'Подключаюсь…'],
    idle: ['green', s.last ? `Синхронизировано · ${new Date(s.last).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Подключено'],
    syncing: ['blue', 'Синхронизация…'],
    offline: ['orange', 'Нет сети — изменения сохранятся и отправятся позже'],
    error: ['red', s.error || 'Ошибка синхронизации'],
  };
  const [c, text] = map[s.state] || map.off;
  return `<span class="status-dot" style="background:var(--${c})"></span><span>${esc(text)}</span>`;
}

function viewSettings() {
  const theme = getData().settings.theme || 'system';
  const archived = habitsAll().filter((h) => h.archived);
  return `
    <header class="page-head"><div><div class="eyebrow">My Habits</div><h1>Настройки</h1></div></header>

    <div class="group-title">Данные</div>
    <div class="card pad">
      <div class="sync-status" id="sync-status">${syncStatusHTML()}</div>
      <button class="btn btn-secondary btn-block mt" data-s="now">${icon.cloud(17)} Синхронизировать сейчас</button>
      <p class="hint">Данные хранятся в твоём приватном репозитории <b>my-habits-data</b>. Запись идёт через твой сервер, вход подтверждается твоим аккаунтом Telegram — на устройстве нет ни одного ключа.</p>
    </div>

    ${notificationsSection()}
    ${routineSection()}
    ${prayerSection()}

    <div class="group-title">Оформление</div>
    <div class="card pad">${segmented('theme', [{ value: 'system', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }], theme)}</div>

    <div class="group-title">Архив привычек</div>
    <div class="card list-group">
      ${archived.length ? archived.map((h) => `<div class="row static">
          <span class="emoji-chip" style="--c:${h.color}">${esc(h.emoji)}</span>
          <div class="row-main"><b>${esc(h.name)}</b><span class="muted">${esc(scheduleText(h))}</span></div>
          <button class="pill" data-restore="${h.id}">Вернуть</button>
        </div>`).join('') : `<div class="row static"><span class="muted">Архив пуст</span></div>`}
    </div>

    <div class="group-title">Резервная копия</div>
    <div class="card list-group">
      <button class="row" data-s="export">${icon.archive(20)}<span>Экспорт в JSON</span></button>
      <label class="row">${icon.undo(20)}<span>Импорт из JSON</span><input type="file" accept="application/json,.json" data-s="import" hidden></label>
      <button class="row is-danger" data-s="wipe">${icon.trash(20)}<span>Удалить все данные</span></button>
    </div>
    <p class="footnote">My Habits · данные принадлежат только тебе</p>
  `;
}

// ---------- Настройки: уведомления, режим дня, намаз ----------

function notificationsSection() {
  const st = getData().settings;
  return `
    <div class="group-title">Напоминания</div>
    <div class="card pad">
      <p class="hint first">Приходят сообщением от бота в Telegram — в начале каждого этапа и по расписанию привычки. Если уже отмечено, напоминания не будет.</p>
      <div class="settings-rows">
        <label class="switch-row"><span>Повторять, если не отмечено</span>
          <select class="field compact" data-set="repeatMin" data-num>${[0, 15, 30, 45, 60, 90].map((m) => `<option value="${m}" ${Number(st.repeatMin) === m ? 'selected' : ''}>${m ? `через ${m} мин` : 'нет'}</option>`).join('')}</select></label>
        <label class="switch-row"><span>Вечерний чек-ин</span><span class="inline"><input type="time" class="field compact" data-set="checkin.time" value="${esc(st.checkin.time)}"><input type="checkbox" class="switch" data-set-bool="checkin.enabled" ${st.checkin.enabled ? 'checked' : ''}></span></label>
      </div>
      <p class="hint">Для намаза повтор приходит за 25 минут до конца его времени. Напоминания для привычек настраиваются в редакторе привычки.</p>
    </div>`;
}

function routineSection() {
  const st = getData().settings;
  const t = (label, path) => `<label><span>${label}</span><input class="field" type="time" data-set="${path}" value="${esc(path.split('.').reduce((o, k) => o?.[k], st) || '')}"></label>`;
  return `
    <div class="group-title">Режим дня</div>
    <div class="card pad">
      <div class="form-grid">
        ${t('Подъём · будни', 'wakeWd')}${t('Сон · будни', 'sleepWd')}
        ${t('Подъём · выходные', 'wakeWe')}${t('Сон · выходные', 'sleepWe')}
      </div>
      <label class="switch-row mt"><span>Тихие часы<br><span class="muted small">Ночью приходят только напоминания о намазе</span></span><input type="checkbox" class="switch" data-set-bool="quiet.enabled" ${st.quiet.enabled ? 'checked' : ''}></label>
      ${st.quiet.enabled ? `<div class="form-grid">${t('С', 'quiet.from')}${t('До', 'quiet.to')}</div>` : ''}
      <p class="hint">Часовой пояс: ${esc(st.tz || '—')}. Этапы «после подъёма» и «до сна» считаются от этих времён.</p>
    </div>`;
}

function prayerSection() {
  const st = getData().settings;
  const p = st.prayer;
  const ctx = dayContext(today());
  const known = CITIES.some(([n]) => n === p.city);
  const rows = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']
    .map((k) => `<div class="prayer-row ${k === 'sunrise' ? 'is-sub' : ''}"><span>${PRAYER_NAME[k]}</span><b>${fmtMin(ctx.prayers[k])}</b>
      <span class="adj"><button class="round-btn sm" data-adj="${k}" data-delta="-1" aria-label="Раньше">${icon.minus(14)}</button><span>${(p.adj?.[k] || 0) > 0 ? '+' : ''}${p.adj?.[k] || 0}</span><button class="round-btn sm" data-adj="${k}" data-delta="1" aria-label="Позже">${icon.plus(14)}</button></span></div>`)
    .join('');
  return `
    <div class="group-title">Время намаза</div>
    <div class="card pad">
      <div class="inline-fields">
        <select class="field" data-pr="city">${CITIES.map(([n]) => `<option ${n === p.city ? 'selected' : ''}>${n}</option>`).join('')}<option value="__custom" ${known ? '' : 'selected'}>${known ? 'Свои координаты' : esc(p.city || 'Свои координаты')}</option></select>
        <button class="btn btn-secondary" data-pr="geo">📍 Где я</button>
      </div>
      ${known ? '' : `<div class="form-grid"><label><span>Широта</span><input class="field" type="number" step="any" data-set="prayer.lat" data-num value="${esc(p.lat)}"></label><label><span>Долгота</span><input class="field" type="number" step="any" data-set="prayer.lon" data-num value="${esc(p.lon)}"></label></div>`}
      <div class="prayer-table">${rows}</div>
      <p class="hint">Сегодня, ${esc(p.city || '')}. Кнопки ± сдвигают время на минуту — сверь с расписанием своей мечети или namozvaqti.uz.</p>
      <details class="advanced"><summary>Метод расчёта</summary>
        <div class="form-grid">
          <label><span>Угол Фаджра, °</span><input class="field" type="number" step="0.5" data-set="prayer.fajrAngle" data-num value="${esc(p.fajrAngle)}"></label>
          <label><span>Угол Иши, °</span><input class="field" type="number" step="0.5" data-set="prayer.ishaAngle" data-num value="${esc(p.ishaAngle)}"></label>
        </div>
        <div class="mt">${segmented('asr', [{ value: 'hanafi', label: 'Аср: ханафитский' }, { value: 'shafi', label: 'Аср: шафиитский' }], p.asr)}</div>
      </details>
    </div>
    ${jumaSection()}
    ${qadaSettingsSection()}`;
}

function jumaSection() {
  const j = getData().settings.juma;
  return `
    <div class="group-title">Джума</div>
    <div class="card pad">
      <label class="switch-row"><span>По пятницам вместо Зухра</span><input type="checkbox" class="switch" data-set-bool="juma.enabled" ${j.enabled ? 'checked' : ''}></label>
      ${j.enabled ? `<div class="settings-rows">
        <label class="switch-row"><span>Начало Джума</span><input type="time" class="field compact" data-set="juma.time" value="${esc(j.time)}"></label>
        <label class="switch-row"><span>Напомнить заранее</span>
          <select class="field compact" data-set="juma.lead" data-num>${[0, 15, 30, 45, 60, 90].map((m) => `<option value="${m}" ${Number(j.lead) === m ? 'selected' : ''}>${m ? `за ${m} мин` : 'в начале'}</option>`).join('')}</select></label>
      </div>` : ''}
      <p class="hint">При отметке в пятницу выбираешь: Джума или Зухр (если не успел).</p>
    </div>`;
}

function qadaSettingsSection() {
  const q = getData().settings.qada;
  const d = qadaDebt();
  return `
    <div class="group-title">Старые долги каза</div>
    <div class="card pad">
      <div class="calc">
        <span>Пропущено</span>
        <label class="unit-field"><input class="field" type="number" min="0" inputmode="numeric" id="qada-years" placeholder="0"><span>лет</span></label>
        <label class="unit-field"><input class="field" type="number" min="0" inputmode="numeric" id="qada-months" placeholder="0"><span>мес.</span></label>
        <button class="btn btn-secondary" id="qada-calc">Посчитать</button>
      </div>
      <div class="qada-grid">${QADA_KEYS.map((k) => `<label><span>${QADA_NAMES[k]}</span><input class="field" type="number" min="0" inputmode="numeric" data-set="qada.old.${k}" data-num value="${Number(q.old?.[k]) || 0}"></label>`).join('')}</div>
      <label class="switch-row mt"><span>Цель: восполнять в день</span>
        <select class="field compact" data-set="qada.perDay" data-num>${[0, 1, 2, 3, 4, 5, 6, 10].map((n) => `<option value="${n}" ${Number(q.perDay) === n ? 'selected' : ''}>${n ? `${n} ${plural(n, ['намаз', 'намаза', 'намазов'])}` : 'без цели'}</option>`).join('')}</select></label>
      <p class="hint">Калькулятор считает по одному намазу каждого вида за каждый день (включая Витр), дальше любое число можно поправить. Осталось восполнить из старого долга: <b>${d.oldLeft}</b>.</p>
    </div>`;
}

function mountPrefs() {
  view.querySelectorAll('[data-set]').forEach((inp) => (inp.onchange = () => {
    const v = 'num' in inp.dataset ? Number(inp.value) : inp.value;
    if ('num' in inp.dataset && !Number.isFinite(v)) return;
    setSetting(inp.dataset.set, v);
  }));
  view.querySelectorAll('[data-set-bool]').forEach((inp) => (inp.onchange = () => setSetting(inp.dataset.setBool, inp.checked)));
  view.querySelectorAll('[data-adj]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.adj;
    setSetting(`prayer.adj.${k}`, (getData().settings.prayer.adj?.[k] || 0) + Number(b.dataset.delta));
  }));
  view.querySelectorAll('[data-seg=asr] button').forEach((b) => (b.onclick = () => setSetting('prayer.asr', b.dataset.value)));
  const calc = view.querySelector('#qada-calc');
  if (calc) calc.onclick = () => {
    const years = Number(view.querySelector('#qada-years').value) || 0;
    const months = Number(view.querySelector('#qada-months').value) || 0;
    const days = Math.round(years * 354.37 + months * 29.53); // лунный год, как принято при подсчёте каза
    if (!days) return toast('Укажи годы или месяцы');
    confirmSheet({
      title: `${days} ${plural(days, DAY_FORMS)} — по ${days} каждого намаза`,
      message: 'Заменить текущие числа старого долга? Уже восполненное по старому долгу будет вычитаться из новых чисел.',
      confirm: 'Заменить',
      onConfirm: () => {
        update((d) => {
          d.settings.qada = { ...d.settings.qada, old: Object.fromEntries(QADA_KEYS.map((k) => [k, days])) };
          d.settings.updatedAt = Date.now();
        });
        toast('Старый долг записан');
      },
    });
  };
  const city = view.querySelector('[data-pr=city]');
  city.onchange = () => {
    const c = CITIES.find(([n]) => n === city.value);
    update((d) => {
      d.settings.prayer = c ? { ...d.settings.prayer, city: c[0], lat: c[1], lon: c[2] } : { ...d.settings.prayer, city: 'Свои координаты' };
      d.settings.updatedAt = Date.now();
    });
  };
  view.querySelector('[data-pr=geo]').onclick = () => {
    if (!navigator.geolocation) return toast('Геолокация недоступна');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 10000) / 10000;
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        const near = CITIES.map(([n, la, lo]) => [n, Math.hypot(la - lat, lo - lon)]).sort((a, b) => a[1] - b[1])[0];
        update((d) => {
          d.settings.prayer = { ...d.settings.prayer, lat, lon, city: near && near[1] < 0.3 ? near[0] : 'Мои координаты' };
          d.settings.updatedAt = Date.now();
        });
        toast('Координаты обновлены');
      },
      () => toast('Не удалось определить местоположение'),
      { timeout: 10000 },
    );
  };
}

function mountSettings() {
  mountPrefs();
  const q = (s) => view.querySelector(`[data-s=${s}]`);
  if (q('now')) q('now').onclick = () => sync.syncNow();
  view.querySelectorAll('[data-seg=theme] button').forEach((b) => (b.onclick = () => setSetting('theme', b.dataset.value)));
  view.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = () => upsertHabit({ id: b.dataset.restore, archived: false })));
  q('export').onclick = () => {
    const blob = new Blob([stableStringify(getData(), 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `my-habits-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  q('import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!imported || !Array.isArray(imported.habits)) throw new Error();
      replaceData(merge(getData(), imported), { notifySync: true });
      toast('Данные импортированы');
    } catch {
      toast('Не удалось прочитать файл');
    }
    e.target.value = '';
  };
  q('wipe').onclick = () =>
    confirmSheet({
      title: 'Удалить все данные?',
      message: 'Все привычки, история и таймеры воздержания будут удалены' + ' — в том числе в репозитории.' + ' Сначала можно сделать экспорт.',
      confirm: 'Удалить всё',
      destructive: true,
      onConfirm: () => {
        habitsAll().forEach((h) => removeHabit(h.id));
        abstainAll().forEach((a) => removeAbstain(a.id));
        updateLocal((l) => (l.timers = {}));
        toast('Все данные удалены');
      },
    });
}

let firstSyncDone = false;
sync.onStatus(() => {
  const st = sync.getStatus();
  const el = document.getElementById('sync-status');
  if (el) el.innerHTML = syncStatusHTML();
  if (st.state === 'idle' && st.last && !firstSyncDone) {
    firstSyncDone = true;
    migrateNamaz();
    // часовой пояс для напоминаний — только после загрузки данных, чтобы не перезаписать настройки
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && getData().settings.tz !== tz) setSetting('tz', tz);
    } catch {
      /* ignore */
    }
  }
  if (st.state !== 'error') return;
  if (st.code === 'claim') return openClaim();
  if (st.code === 'foreign') return renderBlocked('Это личный трекер', 'Он привязан к другому аккаунту Telegram.');
  if (state.route !== 'settings') toast('Синхронизация: ' + st.error, { ms: 5000 });
});

/** Разово: начало учёта каза и этап Витр у привычки «Намаз». Только после загрузки данных с сервера. */
function migrateNamaz() {
  const tk = todayKey();
  if (!getData().settings.qada?.since) setSetting('qada.since', tk);
  for (const h of habitsActive().filter(isNamazHabit)) {
    if (h.stages.some((x) => x.role === 'vitr')) continue;
    upsertHabit({ id: h.id, stages: [...h.stages, { ...VITR_STAGE(), since: tk }] });
    toast('В «Намаз» добавлен Витр');
  }
}

// ---------- Первый вход: подтверждение владельца ----------

let claimOpen = false;
function openClaim() {
  if (claimOpen) return;
  claimOpen = true;
  const s = openSheet({
    className: 'sheet-compact',
    render: () => `
      <div class="sheet-body">
        <div class="confirm">
          <div class="empty-emoji">🔐</div>
          <h3>Подтверди, что это ты</h3>
          <p>Введи ключ подключения — фразу из секрета <b>PUSH_KEY</b>. Это нужно один раз: дальше вход по твоему аккаунту Telegram.</p>
          <input class="field" type="password" data-k="key" placeholder="Фраза-ключ" autocomplete="off">
          <button class="btn btn-block btn-primary mt" data-k="ok">Подтвердить</button>
        </div>
      </div>`,
    mount: (api) => {
      const inp = api.el.querySelector('[data-k=key]');
      const btn = api.el.querySelector('[data-k=ok]');
      setTimeout(() => inp.focus(), 350);
      const go = async () => {
        btn.disabled = true;
        try {
          await sync.api('/api/claim', { key: inp.value.trim() });
          claimOpen = false;
          api.close();
          haptic(20);
          toast('Готово! Трекер привязан к твоему Telegram');
          sync.syncNow();
        } catch (e) {
          toast(e.message, { ms: 5000 });
          btn.disabled = false;
        }
      };
      btn.onclick = go;
      inp.onkeydown = (e) => e.key === 'Enter' && go();
    },
  });
  return s;
}

// ---------- Вне Telegram ----------

function renderBlocked(title, text, extra = '') {
  document.body.classList.add('is-gate');
  view.innerHTML = `<div class="gate">
    <div class="empty-emoji">${title.includes('личный') ? '🔒' : '📱'}</div>
    <h2>${esc(title)}</h2>
    <p>${text}</p>
    ${extra}
  </div>`;
}

async function renderGate() {
  // старая версия хранила токен GitHub в браузере — удаляем его с устройства
  try {
    localStorage.removeItem('myhabits:sync:v1');
    localStorage.removeItem('myhabits:pushkey:v1');
  } catch {
    /* ignore */
  }
  const hasLocal = habitsAll().length || abstainAll().length;
  renderBlocked(
    'Трекер теперь в Telegram',
    'Открой своего бота в Telegram и нажми «Открыть трекер». Данные подтянутся из твоего приватного репозитория.',
    `<a class="btn btn-primary" id="gate-bot" href="https://t.me/" target="_blank" rel="noopener">Открыть Telegram</a>
     ${hasLocal ? `<button class="btn btn-secondary mt" id="gate-export">Сохранить копию данных (JSON)</button><p class="hint">На этом устройстве остались данные старой версии. Если синхронизация в ней была включена — они уже в репозитории.</p>` : ''}`,
  );
  document.getElementById('gate-export')?.addEventListener('click', () => {
    const blob = new Blob([stableStringify(getData(), 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `my-habits-${todayKey()}.json`;
    a.click();
  });
  try {
    const { bot } = await fetch(`${WORKER_URL}/api/info`).then((r) => r.json());
    if (bot) {
      const a = document.getElementById('gate-bot');
      a.href = `https://t.me/${bot}`;
      a.textContent = 'Открыть в Telegram';
      a.insertAdjacentHTML('afterend', `<p class="hint">Твой бот: @${esc(bot)}</p>`);
    }
  } catch {
    /* ignore */
  }
}

// ============================================================
// События
// ============================================================

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t || t.closest('.sheet')) return;
  const id = t.dataset.id;
  switch (t.dataset.action) {
    case 'add-habit': return openHabitEditor();
    case 'open-habit': return openHabitDetail(id);
    case 'habit-tap': e.stopPropagation(); return habitTap(id);
    case 'select-day': state.day = parseKey(t.dataset.day); return render();
    case 'go-today': state.day = today(); return render();
    case 'pick-date': {
      const p = document.getElementById('date-picker');
      try {
        p.showPicker();
      } catch {
        p.focus();
        p.click();
      }
      return;
    }
    case 'reorder': state.reorder = true; return render();
    case 'reorder-done': state.reorder = false; return render();
    case 'checkin': return openCheckin();
    case 'merge-namaz': return mergeNamaz();
    case 'hide-namaz':
      try {
        localStorage.setItem('myhabits:namaz-banner', 'hide');
      } catch {
        /* ignore */
      }
      return render();
    case 'add-abstain': return openAbstainEditor();
    case 'open-abstain': return openAbstainDetail(id);
    case 'clean-today': e.stopPropagation(); return toggleClean(id);
    case 'relapse': e.stopPropagation(); return relapse(id);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'date-picker' && e.target.value) {
    const d = parseKey(e.target.value);
    state.day = d > today() ? today() : d;
    render();
  }
});

// ============================================================
// Живые таймеры (раз в секунду)
// ============================================================

let lastDoneState = '';
function tick() {
  const now = Date.now();
  if (todayKey() !== state.lastTodayKey) {
    // наступил новый день
    if (dkey(state.day) === state.lastTodayKey) state.day = today();
    state.lastTodayKey = todayKey();
    return render();
  }
  for (const a of abstainAll()) {
    const el = abstainElapsed(a, now);
    document.querySelectorAll(`[data-live-abs="${a.id}"]`).forEach((n) => (n.innerHTML = timerHTML(el)));
    document.querySelectorAll(`[data-live-abs-short="${a.id}"]`).forEach((n) => (n.textContent = fmtDuration(el)));
    document.querySelectorAll(`[data-live-abs-progress="${a.id}"]`).forEach((n) => (n.style.width = `${Math.round(milestoneInfo(el).progress * 100)}%`));
  }
  const timers = getLocal().timers || {};
  let doneState = '';
  for (const id of Object.keys(timers)) {
    const h = findHabit(id);
    if (!h) continue;
    const v = runningValue(h, dkey(new Date(timers[id].at)));
    document.querySelectorAll(`[data-live-timer="${id}"]`).forEach((n) => (n.textContent = fmtClock(v)));
    doneState += v >= goalOf(h) ? id : '';
  }
  if (doneState !== lastDoneState) {
    const changed = lastDoneState !== '' || doneState !== '';
    lastDoneState = doneState;
    if (changed && doneState) {
      haptic(30);
      render();
    }
  }
}
setInterval(tick, 1000);

// ============================================================
// Запуск
// ============================================================

let renderQueued = false;
subscribe(() => {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
});
onLocalChange(() => sync.schedule());
window.addEventListener('hashchange', () => tg.inTelegram() && route());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());

if (!tg.inTelegram()) {
  renderGate();
} else {
  tg.init({ onBack: () => topSheet()?.close(), onTheme: applyTheme });
  route();
  sync.initSync();
  if (tg.startScreen() === 'checkin') setTimeout(openCheckin, 300);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// для отладки в консоли
window.__habits = { getData, update, touch, emptyData };
