(function () {
  'use strict';

  const root = document.getElementById('app-root');
  const toastRegion = document.getElementById('toast-region');
  const TASKS_KEY = 'daymark-tasks-v1';
  const SETTINGS_KEY = 'daymark-settings-v1';
  const DEFAULT_SETTINGS = { name: 'Alex', reminders: true, availableMinutes: 480, theme: 'midnight', themeVersion: 2 };
  const PRIORITY_POINTS = { low: 10, medium: 20, high: 30 };
  const DURATION_OPTIONS = [15, 30, 45, 60, 90];

  const state = {
    tasks: loadTasks(),
    settings: loadSettings(),
    view: 'today',
    selectedDate: todayKey(),
    summaryDate: todayKey(),
    filter: 'all',
    modal: null,
    formError: '',
    timerTaskId: null,
    timerStartedAt: null,
    timerInterval: null,
    settingsMessage: '',
  };

  const iconPaths = {
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    home: '<path d="m4 11 8-7 8 7v9H4z"/><path d="M9 20v-5h6v5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 7v5l3 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1h-2.5v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6.5v-2.5h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h2.5v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v2.5h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    edit: '<path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5z"/><path d="m13.8 6.7 3.5 3.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/>',
    play: '<path d="m9 5 10 7-10 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    timer: '<circle cx="12" cy="13" r="7"/><path d="M12 10v3l2 1M9 3h6M12 3v3"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    leaf: '<path d="M20 4C10 4 4 9 4 16c0 2 1 4 3 4 7 0 12-6 13-16Z"/><path d="M4 20c3-5 7-8 12-10"/>',
    flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4-2.4-6.5-5-9.5.1 2-1 3.1-2.2 4.3-.9-1.7-1.1-3.5-.8-5.8C8.2 6.3 5 10.1 5 15a7 7 0 0 0 7 7Z"/><path d="M12 22a3.5 3.5 0 0 0 3.5-3.5c0-1.8-1.2-3.1-2.5-4.6-.2 1.3-.7 2.1-1.6 2.9-.6-.9-.7-1.8-.5-2.9-1.5 1.2-2.4 2.8-2.4 4.6A3.5 3.5 0 0 0 12 22Z"/>',
    sparkles: '<path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/>',
    alert: '<path d="M12 3 2.7 20h18.6z"/><path d="M12 9v5M12 17h.01"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  };

  function icon(name) {
    return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${iconPaths[name] || iconPaths.info}</svg></span>`;
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function escapeAttr(value) { return escapeHTML(value).replace(/`/g, '&#96;'); }

  function pad(value) { return String(value).padStart(2, '0'); }

  function todayKey() { return dateKey(new Date()); }

  function dateKey(date) {
    const value = date instanceof Date ? date : new Date(date);
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  function dateFromKey(key) {
    const [year, month, day] = String(key).split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1);
  }

  function shiftDate(key, amount) {
    const date = dateFromKey(key);
    date.setDate(date.getDate() + amount);
    return dateKey(date);
  }

  function formatDate(key, options = {}) {
    const defaults = { weekday: 'long', month: 'long', day: 'numeric' };
    return new Intl.DateTimeFormat(undefined, { ...defaults, ...options }).format(dateFromKey(key));
  }

  function formatShortDate(key) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(dateFromKey(key)); }

  function isToday(key) { return key === todayKey(); }

  function isTomorrow(key) { return key === shiftDate(todayKey(), 1); }

  function relativeDayLabel(key) {
    if (isToday(key)) return 'Today';
    if (isTomorrow(key)) return 'Tomorrow';
    if (key === shiftDate(todayKey(), -1)) return 'Yesterday';
    return formatDate(key, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function formatMinutes(minutes) {
    const value = Number(minutes) || 0;
    if (value < 60) return `${value} min`;
    const hours = Math.floor(value / 60);
    const remaining = value % 60;
    return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
  }

  function formatSeconds(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (value < 60) return `${value}s`;
    const minutes = Math.floor(value / 60);
    const remaining = value % 60;
    if (minutes < 60) return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60 ? `${minutes % 60}m` : ''}`.trim();
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function initials(name) {
    return String(name || 'A').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'A';
  }

  function priorityPoints(priority) { return PRIORITY_POINTS[priority] || PRIORITY_POINTS.medium; }

  function normalizeTask(raw = {}) {
    const priority = ['low', 'medium', 'high'].includes(raw.priority) ? raw.priority : 'medium';
    return {
      id: String(raw.id || createId()),
      title: String(raw.title || '').trim(),
      description: String(raw.description || '').trim(),
      estimatedMinutes: DURATION_OPTIONS.includes(Number(raw.estimatedMinutes)) ? Number(raw.estimatedMinutes) : 30,
      plannedTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.plannedTime || '')) ? raw.plannedTime : '',
      priority,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? raw.date : todayKey(),
      completed: Boolean(raw.completed),
      completedAt: raw.completedAt || null,
      pointsAwarded: raw.completed ? Number(raw.pointsAwarded) || priorityPoints(priority) : 0,
      actualSeconds: Math.max(0, Number(raw.actualSeconds) || 0),
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }

  function createId() { return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

  function starterTasks() {
    const date = todayKey();
    return [
      { title: 'Plan the day', description: 'Choose the one outcome that matters most.', estimatedMinutes: 15, plannedTime: '08:30', priority: 'low', date },
      { title: 'Deep work block', description: 'Protect a focused block for your most important work.', estimatedMinutes: 60, plannedTime: '10:00', priority: 'high', date },
      { title: 'Move for 30 minutes', description: 'A short reset to keep your energy steady.', estimatedMinutes: 30, plannedTime: '13:00', priority: 'medium', date },
      { title: 'Read and reflect', description: 'Close the day with something that helps you grow.', estimatedMinutes: 30, plannedTime: '20:30', priority: 'low', date },
    ].map(normalizeTask);
  }

  function loadTasks() {
    try {
      const raw = JSON.parse(localStorage.getItem(TASKS_KEY) || 'null');
      if (Array.isArray(raw)) return raw.map(normalizeTask).filter((task) => task.title);
    } catch { /* Start with the local starter plan when storage is unavailable. */ }
    const firstRun = starterTasks();
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(firstRun)); } catch { /* Local persistence is best effort. */ }
    return firstRun;
  }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (raw && typeof raw === 'object') return { ...DEFAULT_SETTINGS, ...raw, availableMinutes: Math.max(60, Number(raw.availableMinutes) || DEFAULT_SETTINGS.availableMinutes), theme: raw.theme === 'warm' && raw.themeVersion === 2 ? 'warm' : 'midnight', themeVersion: 2 };
    } catch { /* Use defaults when local storage is unavailable. */ }
    return { ...DEFAULT_SETTINGS };
  }

  function persist() {
    commitActiveTimer();
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(state.tasks)); } catch { /* The app remains usable for this session. */ }
  }

  function persistSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* The app remains usable for this session. */ }
  }

  function commitActiveTimer() {
    if (!state.timerTaskId || !state.timerStartedAt) return;
    const task = state.tasks.find((item) => item.id === state.timerTaskId);
    if (!task) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - state.timerStartedAt) / 1000));
    if (elapsed > 0) task.actualSeconds += elapsed;
    state.timerStartedAt = Date.now();
  }

  function taskElapsed(task) {
    let seconds = Number(task.actualSeconds) || 0;
    if (state.timerTaskId === task.id && state.timerStartedAt) seconds += Math.max(0, Math.floor((Date.now() - state.timerStartedAt) / 1000));
    return seconds;
  }

  function tasksForDate(date) {
    return state.tasks.filter((task) => task.date === date).sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.plannedTime && b.plannedTime) return a.plannedTime.localeCompare(b.plannedTime);
      if (a.plannedTime) return -1;
      if (b.plannedTime) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  function summaryFor(date) {
    const tasks = tasksForDate(date);
    const completed = tasks.filter((task) => task.completed).length;
    const plannedMinutes = tasks.reduce((total, task) => total + task.estimatedMinutes, 0);
    const actualSeconds = tasks.reduce((total, task) => total + taskElapsed(task), 0);
    const points = tasks.reduce((total, task) => total + (task.completed ? (Number(task.pointsAwarded) || priorityPoints(task.priority)) : 0), 0);
    return { tasks, total: tasks.length, completed, pending: tasks.length - completed, percentage: tasks.length ? Math.round((completed / tasks.length) * 100) : 0, plannedMinutes, actualSeconds, points };
  }

  function motivationalMessage(summary) {
    if (!summary.total) return 'Start with one small task. A clear plan makes the next step easier.';
    if (summary.percentage === 100) return 'Everything on your list is complete. Nice work protecting your focus.';
    if (summary.percentage >= 75) return 'Great progress! Finish the last stretch, then give yourself a real break.';
    if (summary.percentage >= 50) return 'You are past the halfway point. Keep the rhythm gentle and steady.';
    if (summary.completed > 0) return 'A little progress counts. Choose the next task and keep moving.';
    return 'Your plan is ready. Start with the task that would make the biggest difference.';
  }

  function taskPoints(task) { return task.completed ? (Number(task.pointsAwarded) || priorityPoints(task.priority)) : priorityPoints(task.priority); }

  function totalLifetimePoints() {
    return state.tasks.reduce((total, task) => total + (task.completed ? (Number(task.pointsAwarded) || priorityPoints(task.priority)) : 0), 0);
  }

  function hasCompletedTaskOn(date) {
    return state.tasks.some((task) => task.date === date && task.completed);
  }

  function currentStreak() {
    let cursor = todayKey();
    if (!hasCompletedTaskOn(cursor)) cursor = shiftDate(cursor, -1);
    let streak = 0;
    while (hasCompletedTaskOn(cursor)) {
      streak += 1;
      cursor = shiftDate(cursor, -1);
    }
    return streak;
  }

  function momentumMessage(streak) {
    if (streak >= 7) return 'A full week of momentum. Keep it steady, not stressful.';
    if (streak > 0 && hasCompletedTaskOn(todayKey())) return 'You showed up today. One more small win keeps the rhythm alive.';
    if (streak > 0) return 'Your streak is waiting for one small win today.';
    return 'Complete one task today to light up your first streak.';
  }

  function renderMomentumCard() {
    const streak = currentStreak();
    const todayStarted = hasCompletedTaskOn(todayKey());
    return `<section class="momentum-card panel" aria-label="Daily momentum"><div class="momentum-leading"><span class="momentum-icon">${icon('flame')}</span><div class="momentum-copy"><p class="eyebrow">Your momentum</p><h3>${streak ? `${streak} day${streak === 1 ? '' : 's'} in a row` : 'Start a fresh streak'}</h3><p>${escapeHTML(momentumMessage(streak))}</p></div></div><div class="momentum-side"><span class="momentum-score">${todayStarted ? 'Today is active' : '1 small win'}</span><button class="button button-secondary button-small" type="button" data-action="next-win">${icon('arrowRight')}${todayStarted ? 'Keep going' : 'Find next win'}</button></div></section>`;
  }

  function toast(message, type = 'info') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info')}<span>${escapeHTML(message)}</span><button class="toast-close" type="button" aria-label="Dismiss notification">${icon('close')}</button>`;
    toastRegion.appendChild(item);
    item.querySelector('.toast-close')?.addEventListener('click', () => item.remove());
    window.setTimeout(() => item.remove(), 5200);
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme;
    const theme = state.settings.theme === 'warm' ? '#FCFCF8' : '#070B16';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme);
  }

  function navItem(view, label, iconName) {
    const active = state.view === view || (view === 'history' && state.view === 'summary');
    return `<button class="nav-item${active ? ' active' : ''}" type="button" data-view="${view}" aria-current="${active ? 'page' : 'false'}">${icon(iconName)}<span>${label}</span></button>`;
  }

  function renderShell() {
    applyTheme();
    root.innerHTML = `<div class="app-shell"><div class="app-frame">
      <header class="topbar">
        <button class="brand" type="button" data-view="today" aria-label="Open Today"><span class="brand-mark">${icon('check')}</span><span>Time <span class="brand-accent">Table</span></span></button>
        <div class="topbar-date">${icon('calendar')}<span>${formatDate(todayKey())}</span></div>
        <div class="topbar-actions"><button class="icon-button" type="button" data-view="settings" aria-label="Open settings">${icon('settings')}</button><span class="user-avatar" aria-label="Profile for ${escapeAttr(state.settings.name)}">${escapeHTML(initials(state.settings.name))}</span></div>
      </header>
      <main id="main-view" class="main-content" tabindex="-1">${renderView()}</main>
      <nav class="bottom-nav" aria-label="Primary navigation">${navItem('today', 'Today', 'home')}${navItem('history', 'History', 'history')}${navItem('settings', 'Settings', 'settings')}</nav>
    </div></div>${state.modal ? renderTaskModal() : ''}`;
    bindEvents();
    updateTimerDisplay();
  }

  function renderView() {
    if (state.view === 'history') return renderHistory();
    if (state.view === 'summary') return renderSummary();
    if (state.view === 'settings') return renderSettings();
    return renderToday();
  }

  function renderDateSwitcher(date, action = 'selected-date') {
    return `<div class="date-switcher" aria-label="Choose day"><button type="button" data-action="change-date" data-direction="-1" aria-label="Previous day">${icon('arrowLeft')}</button><strong>${escapeHTML(relativeDayLabel(date))}</strong><button type="button" data-action="change-date" data-direction="1" aria-label="Next day">${icon('arrowRight')}</button>${!isToday(date) ? `<button class="button button-small button-quiet" type="button" data-action="jump-today">Today</button>` : ''}</div>`;
  }

  function renderToday() {
    const summary = summaryFor(state.selectedDate);
    const plannedPoints = summary.tasks.reduce((total, task) => total + priorityPoints(task.priority), 0);
    const overbooked = summary.plannedMinutes > Number(state.settings.availableMinutes);
    const filteredTasks = summary.tasks.filter((task) => state.filter === 'all' || (state.filter === 'done' ? task.completed : !task.completed));
    const dateDescription = isToday(state.selectedDate) ? 'Your plan for today, one satisfying checkmark at a time.' : `A clear plan for ${formatDate(state.selectedDate, { weekday: 'long', month: 'long', day: 'numeric' })}.`;
    return `<div class="page-intro"><div><p class="eyebrow">${isToday(state.selectedDate) ? greeting() : 'Daily plan'}, ${escapeHTML(state.settings.name || 'there')}</p><h1>${isToday(state.selectedDate) ? 'Make today count.' : escapeHTML(relativeDayLabel(state.selectedDate))}</h1><p>${dateDescription}</p></div><div class="page-intro-actions">${renderDateSwitcher(state.selectedDate)}</div></div>
      <section class="hero-grid" aria-label="Daily progress">
        <article class="progress-card panel"><div class="progress-card-head"><div><p class="eyebrow">Daily progress</p><h2>${summary.completed} of ${summary.total} tasks complete</h2><p class="progress-card-copy">${summary.percentage === 100 ? 'You did it — your plan is complete.' : `${summary.percentage}% done. ${summary.pending ? `${summary.pending} ${summary.pending === 1 ? 'task' : 'tasks'} left for the day.` : 'Add a task when you are ready.'}`}</p></div><div class="progress-ring" style="--progress:${summary.percentage}" aria-label="${summary.percentage}% complete" role="img"><div class="progress-ring-content"><strong>${summary.percentage}%</strong><span>done</span></div></div></div><div class="progress-track" role="progressbar" aria-label="Task completion" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${summary.percentage}"><span style="width:${summary.percentage}%"></span></div><div class="progress-foot"><span>${summary.total ? `${summary.completed} complete · ${summary.pending} pending` : 'No tasks planned yet'}</span><strong>${summary.points} points earned</strong></div></article>
        <div class="stat-stack"><article class="stat-card panel"><div class="stat-label"><span>Points today</span>${icon('star')}</div><strong class="stat-value">${summary.points}</strong><span class="stat-foot">${plannedPoints ? `${plannedPoints} available from this plan` : 'Complete a task to earn points'}<br><strong>${totalLifetimePoints()} lifetime points</strong></span></article><article class="stat-card panel"><div class="stat-label"><span>Time planned</span>${icon('clock')}</div><strong class="stat-value">${formatMinutes(summary.plannedMinutes)}</strong><span class="stat-foot">${summary.actualSeconds ? `<strong>${formatSeconds(summary.actualSeconds)}</strong> tracked so far` : `About ${formatMinutes(state.settings.availableMinutes)} available`}</span></article></div>
      </section>
      ${renderMomentumCard()}
      ${overbooked ? `<div class="planning-warning" role="status">${icon('alert')}<span>Your plan is ${formatMinutes(summary.plannedMinutes - Number(state.settings.availableMinutes))} over your ${formatMinutes(state.settings.availableMinutes)} available window. Consider moving one task to tomorrow.</span></div>` : ''}
      <section class="section-block"><div class="section-heading"><div><p class="eyebrow">Your plan</p><h2>${isToday(state.selectedDate) ? "Today's tasks" : `${relativeDayLabel(state.selectedDate)}'s tasks`}</h2><p>${summary.total ? `${formatMinutes(summary.plannedMinutes)} of focused work planned.` : 'Keep it light and start with one clear next step.'}</p></div><button class="button button-primary button-small" type="button" data-action="open-add">${icon('plus')}Add task</button></div><div class="filters" role="tablist" aria-label="Filter tasks"><button class="filter-chip${state.filter === 'all' ? ' active' : ''}" type="button" data-action="set-filter" data-filter="all">All <span>(${summary.total})</span></button><button class="filter-chip${state.filter === 'pending' ? ' active' : ''}" type="button" data-action="set-filter" data-filter="pending">Pending <span>(${summary.pending})</span></button><button class="filter-chip${state.filter === 'done' ? ' active' : ''}" type="button" data-action="set-filter" data-filter="done">Done <span>(${summary.completed})</span></button></div>${filteredTasks.length ? `<div class="task-list">${filteredTasks.map(renderTaskCard).join('')}</div>` : renderEmptyTasks(summary, state.filter)}</section>
      <div class="motivation"><span class="motivation-icon">${icon(summary.percentage === 100 ? 'sparkles' : 'leaf')}</span><div><strong>${summary.percentage === 100 ? 'A complete day' : 'A note for your day'}</strong><span>${escapeHTML(motivationalMessage(summary))}</span></div></div><div class="add-task-bar"><button class="button button-secondary" type="button" data-action="open-add">${icon('plus')}Plan another task</button></div>`;
  }

  function renderEmptyTasks(summary, filter) {
    if (filter === 'done') return `<div class="empty-state"><div class="empty-state-inner"><span class="empty-icon">${icon('check')}</span><h3>No completed tasks yet</h3><p>Finish a task and it will land here as a small record of progress.</p></div></div>`;
    if (filter === 'pending' && summary.total) return `<div class="empty-state"><div class="empty-state-inner"><span class="empty-icon">${icon('sparkles')}</span><h3>Everything is complete</h3><p>This plan is clear. Use the time you saved to rest or prepare tomorrow.</p></div></div>`;
    return `<div class="empty-state"><div class="empty-state-inner"><span class="empty-icon">${icon('target')}</span><h3>Start with a simple plan</h3><p>Add the tasks you want to complete ${isToday(state.selectedDate) ? 'today' : relativeDayLabel(state.selectedDate).toLowerCase()}. You can keep them short, realistic, and easy to finish.</p><button class="button button-primary" type="button" data-action="open-add">${icon('plus')}Add your first task</button></div></div>`;
  }

  function renderTaskCard(task) {
    const running = state.timerTaskId === task.id;
    const elapsed = taskElapsed(task);
    const timeLabel = task.plannedTime ? formatTime(task.plannedTime) : 'Anytime';
    return `<article class="task-card${task.completed ? ' completed' : ''}" data-task-card="${escapeAttr(task.id)}"><button class="task-check" type="button" data-action="toggle-task" data-id="${escapeAttr(task.id)}" aria-label="${task.completed ? 'Mark incomplete' : 'Mark complete'}: ${escapeAttr(task.title)}">${task.completed ? icon('check') : ''}</button><div class="task-content"><div class="task-title-row"><div class="task-title">${escapeHTML(task.title)}</div>${task.completed ? '<span class="eyebrow">Complete</span>' : ''}</div>${task.description ? `<p class="task-description">${escapeHTML(task.description)}</p>` : ''}<div class="task-meta"><span class="task-meta-item">${icon('clock')}${formatMinutes(task.estimatedMinutes)}</span><span class="task-meta-item">${icon('calendar')}${escapeHTML(timeLabel)}</span><span class="priority-pill ${escapeAttr(task.priority)}">${escapeHTML(task.priority)}</span>${running ? `<span class="task-timer" data-timer-value="${escapeAttr(task.id)}">${icon('timer')}${formatSeconds(elapsed)}</span>` : elapsed ? `<span class="task-meta-item">${icon('timer')}${formatSeconds(elapsed)} tracked</span>` : ''}<span class="task-points">${taskPoints(task)} pts</span></div></div><div class="task-actions">${!task.completed ? `<button class="task-action${running ? ' running' : ''}" type="button" data-action="toggle-timer" data-id="${escapeAttr(task.id)}" aria-label="${running ? 'Stop timer' : 'Start timer'} for ${escapeAttr(task.title)}">${icon(running ? 'pause' : 'play')}</button>` : ''}<button class="task-action" type="button" data-action="edit-task" data-id="${escapeAttr(task.id)}" aria-label="Edit ${escapeAttr(task.title)}">${icon('edit')}</button><button class="task-action" type="button" data-action="delete-task" data-id="${escapeAttr(task.id)}" aria-label="Delete ${escapeAttr(task.title)}">${icon('trash')}</button></div></article>`;
  }

  function formatTime(value) {
    const [hours, minutes] = String(value).split(':').map(Number);
    const date = new Date();
    date.setHours(hours || 0, minutes || 0, 0, 0);
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function historyDates() {
    const dates = new Set();
    for (let offset = 0; offset < 8; offset += 1) dates.add(shiftDate(todayKey(), -offset));
    state.tasks.forEach((task) => dates.add(task.date));
    return [...dates].sort((a, b) => b.localeCompare(a));
  }

  function renderHistory() {
    const rows = historyDates().map((date) => {
      const summary = summaryFor(date);
      const future = date > todayKey();
      return `<article class="history-row"><div class="history-date"><span class="history-date-icon">${icon(future ? 'calendar' : 'history')}</span><div><strong>${escapeHTML(relativeDayLabel(date))}</strong><span>${escapeHTML(formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' }))}${future ? ' · Upcoming plan' : ''}</span></div></div><div class="history-progress"><div class="history-progress-top"><span>${summary.completed} of ${summary.total} tasks</span><strong>${summary.percentage}%</strong></div><div class="progress-track" role="progressbar" aria-label="${escapeAttr(relativeDayLabel(date))} completion" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${summary.percentage}"><span style="width:${summary.percentage}%"></span></div></div><div class="history-points">${summary.points} pts<small>${formatMinutes(summary.plannedMinutes)} planned</small></div><button class="icon-button" type="button" data-action="open-summary" data-date="${escapeAttr(date)}" aria-label="Review ${escapeAttr(relativeDayLabel(date))}">${icon('chevronRight')}</button></article>`;
    }).join('');
    return `<div class="page-intro"><div><p class="eyebrow">Look back with kindness</p><h1>Your history.</h1><p>Review your rhythm, celebrate completed work, and make tomorrow more realistic.</p></div><div class="page-intro-actions"><button class="button button-primary" type="button" data-action="open-add">${icon('plus')}Plan a task</button></div></div><div class="history-toolbar"><p>${historyDates().length} days on your local timeline · nothing leaves this device.</p><button class="button button-secondary button-small" type="button" data-view="today">${icon('home')}Back to today</button></div><section class="history-list" aria-label="Daily history">${rows}</section>`;
  }

  function renderSummary() {
    const summary = summaryFor(state.summaryDate);
    const isFuture = state.summaryDate > todayKey();
    const actualLabel = summary.actualSeconds ? formatSeconds(summary.actualSeconds) : 'Not tracked';
    const summaryMessage = isFuture ? 'This plan is still ahead. Keep it realistic, then let the day unfold.' : summary.percentage === 100 ? 'A fully completed plan. Take the win, then make room for what matters next.' : summary.percentage >= 60 ? 'Great progress! You completed most of your planned tasks. Prepare a realistic plan for tomorrow.' : summary.total ? 'Every finished task still counts. Use this record to make the next plan a little more achievable.' : 'No tasks were recorded for this day. A blank day is useful information too.';
    return `<div class="page-intro"><div><p class="eyebrow">Daily summary</p><h1>${escapeHTML(relativeDayLabel(state.summaryDate))}</h1><p>A simple record of what you planned, completed, and learned.</p></div><div class="page-intro-actions"><div class="date-switcher"><button type="button" data-action="change-summary-date" data-direction="-1" aria-label="Previous summary day">${icon('arrowLeft')}</button><strong>${escapeHTML(formatShortDate(state.summaryDate))}</strong><button type="button" data-action="change-summary-date" data-direction="1" aria-label="Next summary day">${icon('arrowRight')}</button></div><button class="button button-secondary button-small" type="button" data-view="history">${icon('history')}History</button></div></div><section class="summary-card panel"><div class="summary-card-top"><div><p class="eyebrow">${isFuture ? 'Upcoming plan' : 'Daily report'}</p><h2>${summary.percentage}% of the plan completed</h2><p>${summary.completed} completed · ${summary.pending} unfinished · ${summary.points} points earned</p></div><span class="summary-stamp">${icon('calendar')}${escapeHTML(formatDate(state.summaryDate, { month: 'long', day: 'numeric', year: 'numeric' }))}</span></div><div class="summary-metrics"><div class="summary-metric"><strong>${summary.total}</strong><span>tasks planned</span></div><div class="summary-metric"><strong>${summary.completed}</strong><span>tasks completed</span></div><div class="summary-metric"><strong>${summary.points}</strong><span>points earned</span></div><div class="summary-metric"><strong>${formatMinutes(summary.plannedMinutes)}</strong><span>estimated time</span></div></div><div class="summary-message">${escapeHTML(summaryMessage)}</div></section><div class="summary-layout"><section class="summary-task-list panel"><div class="section-heading"><div><p class="eyebrow">The details</p><h2>Tasks from this day</h2></div><span class="faint">${summary.total} total</span></div>${summary.tasks.length ? `<div class="task-list">${summary.tasks.map((task) => renderTaskCard(task)).join('')}</div>` : renderEmptyTasks(summary, 'all')}</section><aside class="summary-side panel"><h3>Time and points</h3><p>Estimates and tracked time stay separate so your history remains honest.</p><div class="summary-side-stat"><span>Estimated time</span><strong>${formatMinutes(summary.plannedMinutes)}</strong></div><div class="summary-side-stat"><span>Actual tracked time</span><strong>${actualLabel}</strong></div><div class="summary-side-stat"><span>Lifetime points</span><strong>${totalLifetimePoints()}</strong></div><button class="button button-secondary button-small" type="button" data-action="open-add" data-date="${escapeAttr(state.summaryDate)}">${icon('plus')}Add to this day</button></aside></div>`;
  }

  function renderSettings() {
    return `<div class="page-intro"><div><p class="eyebrow">Make the system yours</p><h1>Settings.</h1><p>Keep preferences simple. Time Table stores your tasks and settings locally on this device.</p></div></div><div class="settings-layout"><section class="settings-panel panel"><h2>Your preferences</h2><p>Small choices that make your daily plan feel more like yours.</p><form class="settings-form" id="settings-form"><label class="field"><span>Your name</span><input type="text" name="name" maxlength="40" value="${escapeAttr(state.settings.name)}" placeholder="What should Time Table call you?"></label><div class="field-row"><label class="field"><span>Available focus time</span><select name="availableMinutes">${[240, 360, 480, 600, 720].map((minutes) => `<option value="${minutes}"${Number(state.settings.availableMinutes) === minutes ? ' selected' : ''}>${formatMinutes(minutes)} per day</option>`).join('')}</select><em>Used for the gentle over-planning warning.</em></label><label class="field"><span>Theme</span><select name="theme"><option value="midnight"${state.settings.theme === 'midnight' ? ' selected' : ''}>Midnight neon</option><option value="warm"${state.settings.theme === 'warm' ? ' selected' : ''}>Soft light</option></select><em>Choose what feels calm to use.</em></label></div><div class="settings-save"><span class="settings-message" aria-live="polite">${escapeHTML(state.settingsMessage)}</span><button class="button button-primary" type="submit">Save preferences</button></div></form></section><div><section class="settings-panel panel"><h2>Gentle reminders</h2><p>These preferences stay on this device. Browser notifications are not required for the core workflow.</p><div class="toggle-row"><div class="toggle-copy"><strong>Planning reminder</strong><span>Keep a visual reminder to plan tomorrow at night.</span></div><label class="toggle"><span class="sr-only">Enable planning reminder</span><input type="checkbox" name="reminders" data-settings-toggle="reminders"${state.settings.reminders ? ' checked' : ''}><span class="toggle-track"></span></label></div><div class="settings-tip">${icon('info')}<span>At night, choose tomorrow in the Add Task form and capture only what you can realistically finish.</span></div></section><section class="settings-panel panel"><h2>Your rewards</h2><p>Simple points, no leaderboards. Earn more as tasks get more important.</p><div class="summary-side-stat"><span>Lifetime points</span><strong>${totalLifetimePoints()}</strong></div><div class="summary-side-stat"><span>Next milestone</span><strong>${totalLifetimePoints() >= 100 ? '100 reached' : `${100 - totalLifetimePoints()} to 100`}</strong></div></section></div></div>`;
  }

  function renderTaskModal() {
    const draft = state.modal?.draft || {};
    const editing = state.modal?.mode === 'edit';
    const selectedDate = draft.date || state.selectedDate;
    return `<div class="modal-backdrop" data-modal-backdrop role="presentation"><section class="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="task-modal-title" data-modal-sheet><div class="modal-head"><div><h2 id="task-modal-title">${editing ? 'Edit task' : 'Add a task'}</h2><p>${editing ? 'Keep the plan current without losing your progress.' : 'A short, clear plan is easier to complete.'}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close task form">${icon('close')}</button></div><form class="task-form" id="task-form"><label class="field"><span>Task title <b aria-hidden="true">*</b></span><input type="text" name="title" maxlength="100" value="${escapeAttr(draft.title || '')}" placeholder="e.g. Prepare presentation" autocomplete="off" required></label><label class="field"><span>Description <em>optional</em></span><textarea name="description" maxlength="180" placeholder="A little context helps future you.">${escapeHTML(draft.description || '')}</textarea></label><div class="field-row"><label class="field"><span>Estimated time</span><select name="estimatedMinutes">${DURATION_OPTIONS.map((minutes) => `<option value="${minutes}"${Number(draft.estimatedMinutes) === minutes ? ' selected' : ''}>${formatMinutes(minutes)}</option>`).join('')}</select></label><label class="field"><span>Planned start <em>optional</em></span><input type="time" name="plannedTime" value="${escapeAttr(draft.plannedTime || '')}"></label></div><label class="field"><span>Task date</span><input type="date" name="date" value="${escapeAttr(selectedDate)}"><div class="date-quick-row"><button class="date-quick${selectedDate === todayKey() ? ' active' : ''}" type="button" data-action="modal-date" data-date="${escapeAttr(todayKey())}">Today</button><button class="date-quick${selectedDate === shiftDate(todayKey(), 1) ? ' active' : ''}" type="button" data-action="modal-date" data-date="${escapeAttr(shiftDate(todayKey(), 1))}">Tomorrow</button></div></label><div class="field"><span>Priority</span><div class="choice-row" role="group" aria-label="Task priority">${['low', 'medium', 'high'].map((priority) => `<button class="choice${draft.priority === priority ? ' active' : ''}" type="button" data-action="modal-priority" data-priority="${priority}">${priority}<span class="sr-only"> priority</span></button>`).join('')}</div></div><div class="form-error" role="alert">${escapeHTML(state.formError)}</div><div class="modal-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">${editing ? 'Save changes' : 'Add task'}</button></div></form></section></div>`;
  }

  function openTaskModal(id = null, defaultDate = state.selectedDate) {
    const task = id ? state.tasks.find((item) => item.id === id) : null;
    state.formError = '';
    state.modal = { mode: task ? 'edit' : 'add', id: task?.id || null, draft: task ? { ...task } : { title: '', description: '', estimatedMinutes: 30, plannedTime: '', priority: 'medium', date: defaultDate } };
    renderShell();
    window.setTimeout(() => root.querySelector('input[name="title"]')?.focus(), 0);
  }

  function closeModal() {
    state.modal = null;
    state.formError = '';
    renderShell();
  }

  function readTaskForm(form) {
    const data = new FormData(form);
    return { title: String(data.get('title') || '').trim(), description: String(data.get('description') || '').trim(), estimatedMinutes: Number(data.get('estimatedMinutes')) || 30, plannedTime: String(data.get('plannedTime') || ''), date: String(data.get('date') || state.selectedDate), priority: state.modal?.draft?.priority || 'medium' };
  }

  function submitTaskForm(form) {
    const values = readTaskForm(form);
    if (!values.title) {
      state.formError = 'Add a title so you know exactly what success looks like.';
      renderShell();
      window.setTimeout(() => root.querySelector('input[name="title"]')?.focus(), 0);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
      state.formError = 'Choose a valid date for this task.';
      renderShell();
      return;
    }
    const now = new Date().toISOString();
    if (state.modal?.mode === 'edit') {
      const task = state.tasks.find((item) => item.id === state.modal.id);
      if (task) Object.assign(task, values, { updatedAt: now });
      toast('Task updated.', 'success');
    } else {
      state.tasks.push(normalizeTask({ ...values, id: createId(), createdAt: now, updatedAt: now }));
      toast('Task added to your plan.', 'success');
    }
    persist();
    state.selectedDate = values.date;
    state.modal = null;
    state.formError = '';
    renderShell();
  }

  function toggleTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const pointsBefore = totalLifetimePoints();
    if (state.timerTaskId === id) stopTimer(id, false);
    task.completed = !task.completed;
    task.completedAt = task.completed ? new Date().toISOString() : null;
    task.pointsAwarded = task.completed ? priorityPoints(task.priority) : 0;
    task.updatedAt = new Date().toISOString();
    persist();
    toast(task.completed ? `+${task.pointsAwarded} points — ${task.title}` : 'Points reversed. You can come back to it later.', task.completed ? 'success' : 'info');
    const pointsAfter = totalLifetimePoints();
    if (task.completed && Math.floor(pointsAfter / 100) > Math.floor(pointsBefore / 100)) toast(`Milestone reached: ${Math.floor(pointsAfter / 100) * 100} lifetime points.`, 'success');
    if (task.completed && summaryFor(task.date).percentage === 100) toast('Plan complete. That is a great day.', 'success');
    renderShell();
  }

  function deleteTask(id) {
    const index = state.tasks.findIndex((item) => item.id === id);
    if (index < 0) return;
    const task = state.tasks[index];
    if (!window.confirm(`Delete “${task.title}”? This cannot be undone.`)) return;
    if (state.timerTaskId === id) stopTimer(id, false);
    state.tasks.splice(index, 1);
    persist();
    toast('Task deleted.', 'success');
    renderShell();
  }

  function stopTimer(id = state.timerTaskId, shouldRender = true) {
    if (!id || state.timerTaskId !== id) return;
    commitActiveTimer();
    state.timerTaskId = null;
    state.timerStartedAt = null;
    persist();
    if (shouldRender) {
      toast('Timer stopped and actual time saved.', 'success');
      renderShell();
    }
  }

  function startTimer(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task || task.completed) return;
    if (state.timerTaskId && state.timerTaskId !== id) stopTimer(state.timerTaskId, false);
    state.timerTaskId = id;
    state.timerStartedAt = Date.now();
    persist();
    toast(`Timer started for “${task.title}”.`, 'info');
    renderShell();
  }

  function toggleTimer(id) {
    if (state.timerTaskId === id) stopTimer(id);
    else startTimer(id);
  }

  function updateTimerDisplay() {
    if (!state.timerInterval) state.timerInterval = window.setInterval(() => {
      if (!state.timerTaskId) return;
      const task = state.tasks.find((item) => item.id === state.timerTaskId);
      const element = document.querySelector(`[data-timer-value="${CSS.escape(state.timerTaskId)}"]`);
      if (task && element) element.textContent = `${formatSeconds(taskElapsed(task))}`;
    }, 1000);
  }

  function navigate(view) {
    if (!['today', 'history', 'summary', 'settings'].includes(view)) return;
    state.view = view;
    state.settingsMessage = '';
    renderShell();
    window.setTimeout(() => document.getElementById('main-view')?.focus(), 0);
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.classList.contains('modal-backdrop')) {
      closeModal();
      return;
    }
    const viewControl = target.closest('[data-view]');
    if (viewControl && root.contains(viewControl)) {
      event.preventDefault();
      navigate(viewControl.dataset.view);
      return;
    }
    const control = target.closest('[data-action]');
    if (!control || !root.contains(control)) return;
    const action = control.dataset.action;
    if (action === 'close-modal') {
      closeModal();
      return;
    }
    if (action === 'open-add') {
      openTaskModal(null, control.dataset.date || state.selectedDate);
      return;
    }
    if (action === 'edit-task') {
      openTaskModal(control.dataset.id);
      return;
    }
    if (action === 'delete-task') {
      deleteTask(control.dataset.id);
      return;
    }
    if (action === 'toggle-task') {
      toggleTask(control.dataset.id);
      return;
    }
    if (action === 'toggle-timer') {
      toggleTimer(control.dataset.id);
      return;
    }
    if (action === 'next-win') {
      state.view = 'today';
      state.selectedDate = todayKey();
      state.filter = tasksForDate(todayKey()).some((task) => !task.completed) ? 'pending' : 'all';
      renderShell();
      window.setTimeout(() => {
        const next = root.querySelector('.task-card:not(.completed) .task-check');
        if (next) {
          next.focus();
          next.scrollIntoView({ behavior: 'smooth', block: 'center' });
          toast('Your next small win is ready.', 'success');
        } else {
          toast('Today is complete. Enjoy the momentum.', 'success');
        }
      }, 0);
      return;
    }
    if (action === 'change-date') {
      state.selectedDate = shiftDate(state.selectedDate, Number(control.dataset.direction) || 0);
      state.filter = 'all';
      renderShell();
      return;
    }
    if (action === 'jump-today') {
      state.selectedDate = todayKey();
      state.filter = 'all';
      renderShell();
      return;
    }
    if (action === 'set-filter') {
      state.filter = control.dataset.filter || 'all';
      renderShell();
      return;
    }
    if (action === 'open-summary') {
      state.summaryDate = control.dataset.date || todayKey();
      state.view = 'summary';
      renderShell();
      return;
    }
    if (action === 'change-summary-date') {
      state.summaryDate = shiftDate(state.summaryDate, Number(control.dataset.direction) || 0);
      renderShell();
      return;
    }
    if (action === 'modal-priority' && state.modal) {
      state.modal.draft.priority = control.dataset.priority || 'medium';
      state.formError = '';
      renderShell();
      window.setTimeout(() => root.querySelector(`[data-action="modal-priority"][data-priority="${state.modal?.draft.priority}"]`)?.focus(), 0);
      return;
    }
    if (action === 'modal-date' && state.modal) {
      state.modal.draft.date = control.dataset.date || state.selectedDate;
      state.formError = '';
      renderShell();
      return;
    }
  }

  function updateModalDraftField(target) {
    if (!state.modal || !target.name) return;
    const field = target.name;
    if (['title', 'description', 'estimatedMinutes', 'plannedTime', 'date'].includes(field)) state.modal.draft[field] = field === 'estimatedMinutes' ? Number(target.value) : target.value;
  }

  function handleInput(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) updateModalDraftField(target.closest('#task-form') ? target : {});
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    if (target.closest('#task-form')) {
      updateModalDraftField(target);
      return;
    }
    if (target.dataset.settingsToggle === 'reminders') {
      state.settings.reminders = target.checked;
      persistSettings();
      return;
    }
    if (target.name === 'theme' && target.closest('#settings-form')) {
      state.settings.theme = target.value === 'warm' ? 'warm' : 'midnight';
      state.settings.themeVersion = 2;
      applyTheme();
      return;
    }
    if (target.name === 'availableMinutes' && target.closest('#settings-form')) {
      state.settings.availableMinutes = Math.max(60, Number(target.value) || 480);
    }
  }

  function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (form.id === 'task-form') {
      submitTaskForm(form);
      return;
    }
    if (form.id === 'settings-form') {
      const data = new FormData(form);
      state.settings.name = String(data.get('name') || '').trim() || 'Alex';
      state.settings.availableMinutes = Math.max(60, Number(data.get('availableMinutes')) || 480);
      state.settings.theme = data.get('theme') === 'warm' ? 'warm' : 'midnight';
      state.settings.themeVersion = 2;
      state.settingsMessage = 'Saved locally on this device.';
      persistSettings();
      applyTheme();
      toast('Preferences saved.', 'success');
      renderShell();
    }
  }

  function bindEvents() {
    root.onclick = handleClick;
    root.oninput = handleInput;
    root.onchange = handleChange;
    root.onsubmit = handleSubmit;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.modal) closeModal();
  });
  window.addEventListener('beforeunload', () => persist());
  renderShell();
})();
