// Точка входа: экраны, обработчики, живые таймеры.
import {
  getData, getLocal, subscribe, update, updateLocal, replaceData, merge, emptyData, touch,
  habitsActive, habitsAll, abstainAll, findHabit, findAbstain, getLog, setLog,
  upsertHabit, upsertAbstain, removeHabit, removeAbstain, setSetting, onLocalChange,
} from './store.js';
import * as sync from './sync.js';
import {
  goalOf, valueOf, progressOf, isDone, isScheduled, firstDay, doneInWeek, scheduleText, goalText,
  currentStreak, bestStreak, streakText, rateOf, totalCompletions, dayStats, rangeRate,
  MILESTONES, abstainElapsed, abstainBest, milestoneInfo, isCleanDay, relapseDays,
  habitHeatValue, overallHeatValue, achievements,
} from './logic.js';
import {
  COLORS, HABIT_EMOJI, ABSTAIN_EMOJI, icon, ring, animateRings, heatmap, scrollHeatmaps, barChart,
  weekdayLetter, openSheet, refreshLiveSheets, confirmSheet, toast, haptic, segmented,
} from './ui.js';
import {
  dkey, parseKey, today, todayKey, addDays, startOfWeek, esc, plural, fmtDayLong, fmtDateShort, fmtDateTime,
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
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]:not([media])')?.setAttribute('content', dark ? '#000000' : '#F2F2F7');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ============================================================
// Рендер
// ============================================================

function render() {
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
  refreshLiveSheets();
  tick();
}

function route() {
  const r = location.hash.replace('#', '');
  state.route = ROUTES.includes(r) ? r : 'today';
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
    ${due.length ? `<section class="list">${due.map((h) => habitCard(h, day)).join('')}</section>` : ''}
    ${other.length ? `<h3 class="section-title">Не по расписанию</h3><section class="list is-dim">${other.map((h) => habitCard(h, day)).join('')}</section>` : ''}
    ${empty}
  `;
}

function habitCard(h, day) {
  const key = dkey(day);
  const isToday = key === todayKey();
  const running = isToday && getLocal().timers?.[h.id];
  const v = h.type === 'timer' ? runningValue(h, key) : valueOf(h, key);
  const g = goalOf(h);
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

  return `<article class="hcard ${done ? 'is-done' : ''}" data-action="open-habit" data-id="${h.id}" style="--c:${h.color}">
    ${ring(v / g, { size: 46, stroke: 4.5, color: h.color, key: `h-${h.id}-${key}`, inner: `<span class="emoji">${esc(h.emoji)}</span>` })}
    <div class="hmain">
      <div class="hname">${esc(h.name)}</div>
      <div class="hsub">${sub.join('<span class="dot">·</span>')}</div>
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
  const g = goalOf(h);
  haptic();
  if (h.type === 'check') return setLog(id, key, v >= 1 ? 0 : 1);
  if (h.type === 'count') {
    if (v >= g) return setLog(id, key, 0);
    return setLog(id, key, v + (Number(h.step) || 1));
  }
  if (h.type === 'timer') {
    if (!isToday || v >= g) {
      if (v >= g) {
        stopTimer(id);
        return setLog(id, key, 0);
      }
      return openHabitDetail(id);
    }
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
      const g = goalOf(h);
      const running = isToday && getLocal().timers?.[h.id];
      const dayLabel = isToday ? 'Сегодня' : fmtDateShort(day);

      let editor = '';
      if (h.type === 'check') {
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
      const g = goalOf(h);
      const v = valueOf(h, key);
      if (q('toggle')) q('toggle').onclick = () => (haptic(), setLog(id, key, v >= 1 ? 0 : 1));
      if (q('inc')) q('inc').onclick = () => (haptic(), setLog(id, key, v + (Number(h.step) || 1)));
      if (q('dec')) q('dec').onclick = () => (haptic(), setLog(id, key, Math.max(0, v - (Number(h.step) || 1))));
      if (q('input')) q('input').onchange = (e) => setLog(id, key, Math.max(0, Number(String(e.target.value).replace(',', '.')) || 0));
      if (q('timer')) q('timer').onclick = () => (haptic(), toggleTimer(id));
      if (q('add5')) q('add5').onclick = () => setLog(id, key, getLog(id, key) + 300);
      if (q('sub5')) q('sub5').onclick = () => setLog(id, key, Math.max(0, getLog(id, key) - 300));
      if (q('reset')) q('reset').onclick = () => (stopTimer(id), setLog(id, key, 0));
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
    <div class="group-title">Привычки · за 30 дней</div>
    <div class="card list-group">${habitRows}</div>` : ''}
    ${abst.length ? `<div class="group-title">Воздержание</div><div class="card list-group">${abstRows}</div>` : ''}
    <div class="group-title">Достижения · ${unlocked} из ${ach.list.length}</div>
    <div class="ach-grid">${ach.list.map((x) => `<div class="ach ${x.ok ? 'is-ok' : ''}"><div class="ach-emoji">${x.emoji}</div><b>${esc(x.title)}</b><span>${esc(x.desc)}</span></div>`).join('')}</div>
  `;
}

// ============================================================
// Экран «Настройки»
// ============================================================

function syncStatusHTML() {
  const s = sync.getStatus();
  const map = {
    off: ['gray', 'Не подключено — данные хранятся только на этом устройстве'],
    idle: ['green', s.last ? `Синхронизировано · ${new Date(s.last).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Подключено'],
    syncing: ['blue', 'Синхронизация…'],
    offline: ['orange', 'Нет сети — изменения сохранятся и отправятся позже'],
    error: ['red', s.error || 'Ошибка синхронизации'],
  };
  const [c, text] = map[s.state] || map.off;
  return `<span class="status-dot" style="background:var(--${c})"></span><span>${esc(text)}</span>`;
}

function viewSettings() {
  const cfg = (state.settingsDraft = state.settingsDraft || sync.getConfig());
  const theme = getData().settings.theme || 'system';
  const archived = habitsAll().filter((h) => h.archived);
  const connected = sync.isConfigured();
  return `
    <header class="page-head"><div><div class="eyebrow">My Habits</div><h1>Настройки</h1></div></header>

    <div class="group-title">Синхронизация с GitHub</div>
    <div class="card pad">
      <div class="sync-status" id="sync-status">${syncStatusHTML()}</div>
      <div class="form-grid one">
        <label><span>Владелец (логин GitHub)</span><input class="field" data-s="owner" value="${esc(cfg.owner)}" placeholder="username" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
        <label><span>Приватный репозиторий для данных</span><input class="field" data-s="repo" value="${esc(cfg.repo)}" placeholder="my-habits-data" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
        <label><span>Файл</span><input class="field" data-s="path" value="${esc(cfg.path)}" placeholder="data.json" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
        <label><span>Токен (fine-grained)</span><input class="field" type="password" data-s="token" value="${esc(cfg.token)}" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" data-s="save">${connected ? 'Сохранить' : 'Подключить'}</button>
        ${connected ? `<button class="btn btn-secondary" data-s="now">${icon.cloud(17)} Синхронизировать</button>` : ''}
      </div>
      ${connected ? `<button class="link-btn danger mt" data-s="off">Отключить синхронизацию</button>` : ''}
      <p class="hint">Токен хранится только в этом браузере. Создай fine-grained токен с доступом <b>только</b> к репозиторию данных и правом <b>Contents: Read and write</b>. Подробная инструкция — в README репозитория.</p>
    </div>

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

    <div class="group-title">Данные</div>
    <div class="card list-group">
      <button class="row" data-s="export">${icon.archive(20)}<span>Экспорт в JSON</span></button>
      <label class="row">${icon.undo(20)}<span>Импорт из JSON</span><input type="file" accept="application/json,.json" data-s="import" hidden></label>
      <button class="row is-danger" data-s="wipe">${icon.trash(20)}<span>Удалить все данные</span></button>
    </div>
    <p class="footnote">My Habits · данные принадлежат только тебе</p>
  `;
}

function mountSettings() {
  const q = (s) => view.querySelector(`[data-s=${s}]`);
  const d = state.settingsDraft;
  ['owner', 'repo', 'path', 'token'].forEach((k) => (q(k).oninput = (e) => (d[k] = e.target.value.trim())));
  q('save').onclick = async () => {
    const cfg = { owner: d.owner, repo: d.repo || 'my-habits-data', path: d.path || 'data.json', token: d.token };
    if (!cfg.owner || !cfg.token) return toast('Укажи владельца и токен');
    const btn = q('save');
    btn.disabled = true;
    try {
      const info = await sync.testConnection(cfg);
      sync.setConfig(cfg);
      state.settingsDraft = null;
      if (!info.private) toast('⚠️ Репозиторий публичный — данные увидят все. Лучше сделать его приватным.', { ms: 6000 });
      else toast('Подключено к ' + info.fullName);
      await sync.syncNow();
      render();
    } catch (e) {
      toast(e.message || 'Не удалось подключиться', { ms: 5000 });
      btn.disabled = false;
    }
  };
  if (q('now')) q('now').onclick = () => sync.syncNow();
  if (q('off')) q('off').onclick = () =>
    confirmSheet({
      title: 'Отключить синхронизацию?',
      message: 'Данные останутся на этом устройстве и в репозитории, но перестанут обновляться.',
      confirm: 'Отключить',
      destructive: true,
      onConfirm: () => {
        sync.setConfig({ ...sync.getConfig(), token: '' });
        state.settingsDraft = null;
        render();
      },
    });
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
      message: 'Все привычки, история и таймеры воздержания будут удалены' + (sync.isConfigured() ? ' — в том числе в GitHub-репозитории.' : '.') + ' Сначала можно сделать экспорт.',
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

sync.onStatus(() => {
  const el = document.getElementById('sync-status');
  if (el) el.innerHTML = syncStatusHTML();
  if (sync.getStatus().state === 'error' && state.route !== 'settings') {
    toast('Синхронизация: ' + sync.getStatus().error, { ms: 5000 });
  }
});

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
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());

route();
sync.initSync();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// для отладки в консоли
window.__habits = { getData, update, touch, emptyData };
