'use strict';
/**
 * La web app: nessuna build, nessuna libreria. Un unico stato, una funzione
 * che ridisegna la vista corrente, un solo punto (`api()`) che parla con il
 * server. Le regole di dominio (cosa e' "oggi", come si smista) stanno nel
 * Worker: qui si mostra e si tocca soltanto.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  view: 'today',       // today | inbox | upcoming | projects | project-detail | search | done | trash
  area: '',             // '' | work | personal
  project: null,        // { name, area } quando view === 'project-detail'
  query: '',
  today: null,          // YYYY-MM-DD, dal server: e' l'unica fonte per "oggi"
  projectsCache: null,
};

// ---------------------------------------------------------------- utility

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

/** Somma giorni a una data YYYY-MM-DD, senza passare dai fusi orari. */
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function formatDay(iso, { weekday = 'long' } = {}) {
  const d = new Date(`${iso}T12:00:00`); // mezzogiorno: evita che un fuso sbagliato faccia scivolare il giorno
  return capitalize(new Intl.DateTimeFormat('it-IT', { weekday, day: 'numeric', month: 'long' }).format(d));
}

/** L'etichetta della scadenza in una riga: "Oggi", "Domani", oppure "lun 21 set". */
function dueLabel(task) {
  if (!task.due_date) return null;
  let label;
  if (task.due_date === state.today) label = 'Oggi';
  else if (task.due_date === addDays(state.today, 1)) label = 'Domani';
  else label = formatDay(task.due_date, { weekday: 'short' });
  if (task.due_time) label += ` · ${task.due_time}`;
  return label;
}

let toastTimer = null;
function toast(message) {
  clearTimeout(toastTimer);
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = message;
  toastTimer = setTimeout(() => el.remove(), 3000);
}

/** L'unico punto che parla col server. Lancia con {status, message} se qualcosa va storto. */
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* risposta senza corpo */ }
  if (!res.ok) {
    const err = new Error(data?.error || `errore ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ avvio

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const me = await api('/api/me');
    if (me.authenticated) await enterApp();
    else showLogin();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#screen-login').hidden = false;
  $('#screen-app').hidden = true;
  $('#login-password').value = '';
  $('#login-error').hidden = true;
  $('#login-password').focus();
}

async function enterApp() {
  $('#screen-login').hidden = true;
  $('#screen-app').hidden = false;
  await refreshBadges();
  await loadView();
}

let loggingIn = false;
$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (loggingIn) return; // un tocco doppio sul telefono non deve contare come due tentativi
  loggingIn = true;
  const errorEl = $('#login-error');
  errorEl.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#login-password').value }) });
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.status === 429 ? err.message : 'Password sbagliata.';
    errorEl.hidden = false;
  } finally {
    loggingIn = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  closeSheets();
  try { await api('/api/logout', { method: 'POST' }); } catch { /* si esce comunque */ }
  showLogin();
});

// -------------------------------------------------------------- quadranti

async function refreshBadges() {
  try {
    const ov = await api('/api/overview');
    state.today = ov.today;
    setBadge('#badge-today', ov.counts.overdue + ov.counts.due_today);
    setBadge('#badge-inbox', ov.counts.inbox);
  } catch { /* i badge non sono critici: se falliscono restano come stavano */ }
}

function setBadge(sel, n) {
  const el = $(sel);
  el.hidden = !n;
  if (n) el.textContent = n > 99 ? '99+' : String(n);
}

// -------------------------------------------------------------- navigazione

const TITLES = {
  today: 'Oggi', inbox: 'Inbox', upcoming: 'Prossimi 7 giorni', projects: 'Progetti',
  search: 'Cerca', done: 'Fatte', trash: 'Cestino',
};

function setView(view, extra = {}) {
  state.view = view;
  Object.assign(state, extra);
  $('#view-title').textContent = view === 'project-detail' ? state.project.name : TITLES[view];
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view || (view === 'project-detail' && b.dataset.view === 'projects')));
  // L'area non ha senso per l'Inbox (i task in inbox non hanno ancora un'area).
  $('#area-filter').hidden = view === 'inbox';
  loadView();
}

$$('#tabbar button').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view, { project: null, query: '' })));

$$('#area-filter button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.area = btn.dataset.area;
    $$('#area-filter button').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    loadView();
  });
});

$('#btn-more').addEventListener('click', () => openSheet('#sheet-more'));
$$('#sheet-more button[data-view]').forEach((btn) => btn.addEventListener('click', () => { closeSheets(); setView(btn.dataset.view); }));

// -------------------------------------------------------------- rendering

async function loadView() {
  const content = $('#content');
  content.innerHTML = '<p class="empty">Carico…</p>';
  try {
    switch (state.view) {
      case 'today': return renderToday();
      case 'inbox': return renderFlat(await api(`/api/tasks?view=inbox`), 'inbox', 'Niente da smistare. Inbox vuota.');
      case 'upcoming': return renderUpcoming();
      case 'projects': return renderProjects();
      case 'project-detail': return renderProjectDetail();
      case 'search': return renderSearch();
      case 'done': return renderFlat(await api(qs('/api/tasks', { view: 'done' })), 'done', 'Non hai ancora chiuso niente.');
      case 'trash': return renderFlat(await api(qs('/api/tasks', { view: 'trash' })), 'trash', 'Il cestino e\' vuoto.');
    }
  } catch (err) {
    content.innerHTML = `<p class="list-error">Non riesco a caricare: ${esc(err.message)}</p>`;
  }
}

function qs(path, params) {
  const p = new URLSearchParams();
  if (state.area) p.set('area', state.area);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, v);
  return `${path}?${p.toString()}`;
}

async function renderToday() {
  const { tasks } = await api(qs('/api/tasks', { view: 'today' }));
  const overdue = tasks.filter((t) => t.overdue);
  const today = tasks.filter((t) => !t.overdue);
  if (!tasks.length) return setContent(`<p class="empty">Niente per oggi. 🎉</p>`);
  let html = '';
  html += section('In ritardo', overdue, 'open', true);
  html += section('Oggi', today, 'open');
  setContent(html);
}

async function renderUpcoming() {
  const { tasks } = await api(qs('/api/tasks', { view: 'upcoming', days: 7 }));
  if (!tasks.length) return setContent(`<p class="empty">Niente nei prossimi 7 giorni.</p>`);
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.due_date)) groups.set(t.due_date, []);
    groups.get(t.due_date).push(t);
  }
  let html = '';
  for (const [date, list] of groups) html += section(formatDay(date), list, 'open');
  setContent(html);
}

function renderFlat(data, mode, emptyMessage) {
  const tasks = data.tasks;
  if (!tasks.length) return setContent(`<p class="empty">${esc(emptyMessage)}</p>`);
  setContent(rows(tasks, mode));
}

async function renderProjects() {
  if (!state.projectsCache) state.projectsCache = (await api('/api/projects')).projects;
  const list = state.projectsCache.filter((p) => !state.area || p.area === state.area);
  if (!list.length) return setContent(`<p class="empty">Nessun progetto${state.area ? ' in questa area' : ''} ancora.<br>Se ne crea uno scrivendolo in un task, da Claude o dal dettaglio di un task.</p>`);
  setContent(list.map((p) => `
    <button type="button" class="project-row" data-project="${esc(p.name)}" data-area="${p.area}">
      <span class="dot area-${p.area}"></span>
      <span class="name">${esc(p.name)}</span>
      <span class="count">${p.open_tasks} aperti</span>
    </button>`).join(''));
}

async function renderProjectDetail() {
  const { tasks } = await api(`/api/tasks?view=open&project=${encodeURIComponent(state.project.name)}`);
  const back = `<button type="button" class="back-row" id="back-to-projects">‹ Progetti</button>`;
  setContent(back + (tasks.length ? rows(tasks, 'open') : '<p class="empty">Nessun task aperto in questo progetto.</p>'));
}

function renderSearch() {
  const bar = `<div class="search-bar"><input id="search-input" type="search" inputmode="search" placeholder="Cerca in titoli, note, progetti…" value="${esc(state.query)}" autofocus></div>`;
  if (!state.query.trim()) return setContent(bar + '<p class="empty">Scrivi qualcosa per cercare.</p>');
  const query = state.query; // congelato qui: le risposte si confrontano con QUESTO valore, non con quello attuale
  api(qs('/api/tasks', { view: 'all', query }))
    .then(({ tasks }) => {
      if (state.query !== query) return; // nel frattempo la ricerca e' cambiata: risultato vecchio, si scarta
      const list = tasks.length
        ? rows(tasks, (t) => (t.status === 'done' ? 'done' : 'open'))
        : '<p class="empty">Nessun risultato.</p>';
      setContent(bar + list, { keepFocus: '#search-input' });
    })
    .catch((err) => {
      if (state.query !== query) return;
      setContent(bar + `<p class="list-error">${esc(err.message)}</p>`, { keepFocus: '#search-input' });
    });
  setContent(bar + '<p class="empty">Cerco…</p>', { keepFocus: '#search-input' });
}

function setContent(html, { keepFocus } = {}) {
  const content = $('#content');
  const hadFocus = keepFocus && document.activeElement?.matches(keepFocus);
  const selStart = hadFocus ? document.activeElement.selectionStart : null;
  content.innerHTML = html;
  if (hadFocus) {
    const el = $(keepFocus, content);
    if (el) { el.focus(); if (selStart != null) el.setSelectionRange(selStart, selStart); }
  }
}

function section(title, tasks, mode, isOverdue = false) {
  if (!tasks.length) return '';
  return `<div class="section-title${isOverdue ? ' overdue' : ''}">${esc(title)}</div>${rows(tasks, mode)}`;
}

function rows(tasks, mode) {
  return tasks.map((t) => taskRow(t, typeof mode === 'function' ? mode(t) : mode)).join('');
}

function taskRow(t, mode) {
  const due = dueLabel(t);
  const badges = [
    t.area ? `<span class="badge area-${t.area}">${t.area === 'work' ? 'Lavoro' : 'Privato'}</span>` : '',
    t.project ? `<span class="badge">${esc(t.project)}</span>` : '',
    due ? `<span class="badge due${t.overdue ? ' overdue' : ''}">${esc(due)}</span>` : '',
  ].join('');

  const checkGlyph = mode === 'done' ? '✓' : mode === 'trash' ? '↺' : '';
  const checkClass = mode === 'done' ? 'done' : mode === 'trash' ? 'trash' : '';
  const checkAction = mode === 'trash' ? 'restore' : mode === 'done' ? 'reopen' : 'complete';

  let quick = '';
  if (mode === 'inbox') {
    quick = `<button type="button" data-quick="area:work">Lavoro</button><button type="button" data-quick="area:personal">Privato</button>`;
  } else if (mode === 'open') {
    quick = `<button type="button" data-quick="postpone">→ domani</button>`;
  } else if (mode === 'done') {
    quick = `<button type="button" data-quick="trash">🗑</button>`;
  }

  return `
    <div class="task-row${t.overdue ? ' overdue' : ''}${mode === 'done' ? ' done' : ''}" data-id="${t.id}">
      <button type="button" class="check ${checkClass}" data-action="${checkAction}" aria-label="${checkAction}">${checkGlyph}</button>
      <button type="button" class="task-body" data-action="open">
        <span class="task-title">${esc(t.title)}</span>
        ${badges ? `<div class="task-meta">${badges}</div>` : ''}
      </button>
      ${quick ? `<div class="task-quick">${quick}</div>` : ''}
    </div>`;
}

// --------------------------------------------------------- azioni sulle righe

$('#content').addEventListener('click', async (e) => {
  const projectBtn = e.target.closest('.project-row');
  if (projectBtn) return setView('project-detail', { project: { name: projectBtn.dataset.project, area: projectBtn.dataset.area } });

  if (e.target.closest('#back-to-projects')) return setView('projects');

  const row = e.target.closest('.task-row');
  if (!row) return;
  const id = Number(row.dataset.id);

  const openBtn = e.target.closest('[data-action="open"]');
  if (openBtn) return openTaskSheet(id);

  const primary = e.target.closest('[data-action]');
  if (primary && primary.dataset.action !== 'open') {
    const action = primary.dataset.action;
    return runMutation(async () => {
      if (action === 'complete') await api(`/api/tasks/${id}/complete`, { method: 'POST' });
      else if (action === 'reopen') await api(`/api/tasks/${id}/reopen`, { method: 'POST' });
      else if (action === 'restore') await api(`/api/tasks/${id}/restore`, { method: 'POST' });
    });
  }

  const quick = e.target.closest('[data-quick]');
  if (quick) {
    const [kind, value] = quick.dataset.quick.split(':');
    return runMutation(async () => {
      if (kind === 'postpone') await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ due_date: 'tomorrow' }) });
      else if (kind === 'area') await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ area: value }) });
      else if (kind === 'trash') await api(`/api/tasks/${id}`, { method: 'DELETE' });
    });
  }
});

$('#content').addEventListener('input', (e) => {
  if (e.target.id === 'search-input') { state.query = e.target.value; renderSearch(); }
});

/** Esegue un'azione, poi ricarica: piu' semplice e piu' sicuro che tenere due copie dei dati. */
async function runMutation(fn) {
  try {
    await fn();
    state.projectsCache = null; // i conteggi dei progetti potrebbero essere cambiati
    await Promise.all([refreshBadges(), loadView()]);
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------- aggiungere

$('#form-quick-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#quick-add-input');
  const title = input.value.trim();
  if (!title) return;
  const task = { title };
  if (state.view === 'project-detail') { task.project = state.project.name; task.area = state.project.area; }
  input.value = '';
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ tasks: [task] }) });
    state.projectsCache = null;
    await Promise.all([refreshBadges(), loadView()]);
  } catch (err) {
    input.value = title; // il testo non si perde se il salvataggio fallisce
    toast(`Non salvato: ${err.message}`);
  }
});

// -------------------------------------------------------- dettaglio task

let editingId = null;

async function openTaskSheet(id) {
  let task;
  try {
    task = (await api(`/api/tasks/${id}`)).task;
  } catch (err) {
    return toast(err.message);
  }
  editingId = id;
  $('#task-title').value = task.title;
  $('#task-notes').value = task.notes || '';
  $('#task-area').value = task.area || '';
  $('#task-priority').value = task.priority || 'normal';
  $('#task-project').value = task.project || '';
  $('#task-date').value = task.due_date || '';
  $('#task-time').value = task.due_time || '';
  $('#task-delete').hidden = !!task.deleted_at;
  $('#task-restore').hidden = !task.deleted_at;

  if (!state.projectsCache) {
    state.projectsCache = await api('/api/projects').then((d) => d.projects).catch(() => []);
  }
  $('#project-names').innerHTML = state.projectsCache.map((p) => `<option value="${esc(p.name)}">`).join('');

  openSheet('#sheet-task');
}

// Togliere la data a mano (col picker nativo) deve togliere anche l'ora:
// altrimenti store.js, trovando un'ora senza data, rimette "oggi" invece di
// lasciare il task senza scadenza.
$('#task-date').addEventListener('change', () => {
  if (!$('#task-date').value) $('#task-time').value = '';
});

$$('#sheet-task [data-quick-date]').forEach((btn) => btn.addEventListener('click', () => {
  const kind = btn.dataset.quickDate;
  const base = state.today || new Date().toISOString().slice(0, 10);
  const value = kind === 'today' ? base : kind === 'tomorrow' ? addDays(base, 1)
    : kind === 'next_week' ? addDays(base, ((8 - new Date(`${base}T12:00:00`).getDay()) % 7) || 7) : '';
  $('#task-date').value = value;
  if (!value) $('#task-time').value = '';
}));

$('#sheet-task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = editingId;
  const patch = {
    title: $('#task-title').value.trim(),
    notes: $('#task-notes').value.trim() || null,
    priority: $('#task-priority').value,
    project: $('#task-project').value.trim() || null,
    due_date: $('#task-date').value || null,
    due_time: $('#task-time').value || null,
  };
  // L'area si manda solo se scelta esplicitamente: rimandare un task gia'
  // smistato in Inbox non e' un'operazione che questa scheda offre.
  if ($('#task-area').value) patch.area = $('#task-area').value;

  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    closeSheets();
    state.projectsCache = null;
    await Promise.all([refreshBadges(), loadView()]);
  } catch (err) {
    toast(err.message);
  }
});

$('#task-cancel').addEventListener('click', closeSheets);

$('#task-delete').addEventListener('click', async () => {
  if (!confirm('Spostare questo task nel cestino? Resta recuperabile per 30 giorni.')) return;
  try {
    await api(`/api/tasks/${editingId}`, { method: 'DELETE' });
    closeSheets();
    state.projectsCache = null;
    await Promise.all([refreshBadges(), loadView()]);
  } catch (err) { toast(err.message); }
});

$('#task-restore').addEventListener('click', async () => {
  try {
    await api(`/api/tasks/${editingId}/restore`, { method: 'POST' });
    closeSheets();
    await Promise.all([refreshBadges(), loadView()]);
  } catch (err) { toast(err.message); }
});

// -------------------------------------------------------------- sheet/backdrop

function openSheet(sel) {
  $(sel).hidden = false;
  $('#backdrop').hidden = false;
}
function closeSheets() {
  $$('.sheet').forEach((s) => { s.hidden = true; });
  $('#backdrop').hidden = true;
}
$('#backdrop').addEventListener('click', closeSheets);

boot();
