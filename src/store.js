/**
 * Tutte le letture e le scritture passano da qui.
 *
 * MCP, API REST e bot Telegram chiamano queste funzioni e nient'altro: cosi'
 * un task creato da Claude e uno creato dal telefono seguono le stesse regole.
 * Nessun altro file scrive SQL.
 */

import { today, addDays, resolveDate, isTime } from './dates.js';

export const AREAS = ['work', 'personal'];
export const STATUSES = ['inbox', 'todo', 'done'];
export const PRIORITIES = ['high', 'normal', 'low'];
export const SOURCES = ['claude', 'telegram', 'web', 'api'];
export const VIEWS = ['today', 'overdue', 'upcoming', 'inbox', 'open', 'no_date', 'done', 'trash', 'all'];

const MAX_TITLE = 500;
const MAX_NOTES = 5000;
const MAX_BATCH = 100;
const TRASH_DAYS = 30;
const STALE_DAYS = 14;

/** Un errore di chi chiama, non del sistema: diventa un 400, non un 500. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const nowIso = () => new Date().toISOString();

const SELECT_TASK = `
  SELECT t.*, p.name AS project
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
`;

const ORDER_OPEN = `
  ORDER BY
    CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
    t.due_date,
    CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
    CASE WHEN t.due_time IS NULL THEN 1 ELSE 0 END,
    t.due_time,
    t.id
`;

function shape(row, todayIso) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    notes: row.notes ?? null,
    area: row.area ?? null,
    project: row.project ?? null,
    project_id: row.project_id ?? null,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date ?? null,
    due_time: row.due_time ?? null,
    overdue: row.status !== 'done' && !row.deleted_at && !!row.due_date && row.due_date < todayIso,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
    deleted_at: row.deleted_at ?? null,
  };
}

function checkIds(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
  if (list.length === 0) throw new ValidationError('serve almeno un id');
  if (list.length > MAX_BATCH) throw new ValidationError(`al massimo ${MAX_BATCH} task per volta`);
  if (!list.every((n) => Number.isInteger(n) && n > 0)) throw new ValidationError('id non valido');
  return [...new Set(list)];
}

const placeholders = (n) => Array(n).fill('?').join(',');

function cleanText(value, field, max, { required = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw new ValidationError(`${field} non puo' essere vuoto`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} deve essere testo`);
  const v = value.trim();
  if (v.length > max) throw new ValidationError(`${field} troppo lungo (max ${max} caratteri)`);
  return v;
}

function checkEnum(value, field, allowed, { nullable = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} non valido: usa ${allowed.join(', ')}${nullable ? ' oppure null' : ''}`);
  }
  return value;
}

// ---------------------------------------------------------------- progetti

async function findProject(env, nameOrId) {
  if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId))) {
    return env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(Number(nameOrId)).first();
  }
  return env.DB.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE').bind(String(nameOrId).trim()).first();
}

/**
 * Trova il progetto per nome, o lo crea. L'area di un progetto nuovo viene dal
 * task; senza area non si crea niente, perche' un progetto deve stare da una
 * parte o dall'altra.
 */
async function resolveProject(env, name, area) {
  const clean = cleanText(name, 'project', 100);
  if (clean === undefined) return undefined;
  if (clean === null) return null;
  const found = await findProject(env, clean);
  if (found) return found;
  if (!area) {
    throw new ValidationError(`il progetto "${clean}" non esiste: per crearlo serve anche l'area (work o personal)`);
  }
  const row = await env.DB.prepare('INSERT INTO projects (name, area) VALUES (?, ?) RETURNING *')
    .bind(clean, area)
    .first();
  await logEvent(env, 'project.created', { id: row.id, name: clean, area });
  return row;
}

export async function listProjects(env, { includeArchived = false } = {}) {
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.name, p.area, p.archived,
      (SELECT COUNT(*) FROM tasks t
        WHERE t.project_id = p.id AND t.status != 'done' AND t.deleted_at IS NULL) AS open_tasks
    FROM projects p
    ${includeArchived ? '' : 'WHERE p.archived = 0'}
    ORDER BY p.area, p.name COLLATE NOCASE
  `).all();
  return results.map((r) => ({ ...r, archived: !!r.archived }));
}

export async function updateProject(env, id, { name, area, archived } = {}) {
  const sets = [];
  const binds = [];
  const n = cleanText(name, 'name', 100);
  if (n) { sets.push('name = ?'); binds.push(n); }
  const a = checkEnum(area, 'area', AREAS);
  if (a) { sets.push('area = ?'); binds.push(a); }
  if (archived !== undefined) { sets.push('archived = ?'); binds.push(archived ? 1 : 0); }
  if (!sets.length) throw new ValidationError('niente da modificare');
  const row = await env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...binds, Number(id))
    .first();
  return row ? { ...row, archived: !!row.archived } : null;
}

// ---------------------------------------------------------------- lettura

export async function getTask(env, id) {
  const row = await env.DB.prepare(`${SELECT_TASK} WHERE t.id = ?`).bind(Number(id)).first();
  return shape(row, today(env));
}

async function getTasksByIds(env, ids) {
  const { results } = await env.DB.prepare(`${SELECT_TASK} WHERE t.id IN (${placeholders(ids.length)}) ORDER BY t.id`)
    .bind(...ids)
    .all();
  const t = today(env);
  return results.map((r) => shape(r, t));
}

/**
 * L'elenco, con i filtri che servono a tutte le domande che farai:
 * "cosa ho oggi", "cosa c'e' di lavoro questa settimana", "cerca preventivo".
 */
export async function listTasks(env, filters = {}) {
  const t = today(env);
  const view = checkEnum(filters.view ?? 'open', 'view', VIEWS);
  const where = [];
  const binds = [];
  let order = ORDER_OPEN;

  if (view === 'trash') {
    where.push('t.deleted_at IS NOT NULL');
    order = 'ORDER BY t.deleted_at DESC';
  } else {
    where.push('t.deleted_at IS NULL');
  }

  switch (view) {
    case 'today':
      where.push("t.status != 'done'", 't.due_date IS NOT NULL', 't.due_date <= ?');
      binds.push(t);
      break;
    case 'overdue':
      where.push("t.status != 'done'", 't.due_date < ?');
      binds.push(t);
      break;
    case 'upcoming': {
      const days = Math.min(Math.max(Number(filters.days) || 7, 1), 60);
      where.push("t.status != 'done'", 't.due_date > ?', 't.due_date <= ?');
      binds.push(t, addDays(t, days));
      break;
    }
    case 'inbox':
      where.push("t.status = 'inbox'");
      order = 'ORDER BY t.created_at DESC';
      break;
    case 'open':
      where.push("t.status != 'done'");
      break;
    case 'no_date':
      where.push("t.status = 'todo'", 't.due_date IS NULL');
      break;
    case 'done':
      where.push("t.status = 'done'");
      order = 'ORDER BY t.completed_at DESC';
      break;
  }

  const area = checkEnum(filters.area || undefined, 'area', AREAS);
  if (area) { where.push('t.area = ?'); binds.push(area); }

  const status = checkEnum(filters.status || undefined, 'status', STATUSES);
  if (status) { where.push('t.status = ?'); binds.push(status); }

  const priority = checkEnum(filters.priority || undefined, 'priority', PRIORITIES);
  if (priority) { where.push('t.priority = ?'); binds.push(priority); }

  if (filters.project !== undefined && filters.project !== null && filters.project !== '') {
    const p = await findProject(env, filters.project);
    if (!p) throw new ValidationError(`progetto "${filters.project}" non trovato`);
    where.push('t.project_id = ?');
    binds.push(p.id);
  }

  if (filters.due_from) {
    const d = resolveDate(filters.due_from, env);
    if (!d) throw new ValidationError('due_from non valida: usa YYYY-MM-DD');
    where.push('t.due_date >= ?');
    binds.push(d);
  }
  if (filters.due_to) {
    const d = resolveDate(filters.due_to, env);
    if (!d) throw new ValidationError('due_to non valida: usa YYYY-MM-DD');
    where.push('t.due_date <= ?');
    binds.push(d);
  }

  const query = typeof filters.query === 'string' ? filters.query.trim() : '';
  if (query) {
    // Ogni parola deve comparire, in qualsiasi ordine: "mail marco" trova
    // "Rispondere alla mail di Marco".
    for (const word of query.split(/\s+/).slice(0, 8)) {
      const like = `%${word.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      where.push("(t.title LIKE ? ESCAPE '\\' OR IFNULL(t.notes, '') LIKE ? ESCAPE '\\' OR IFNULL(p.name, '') LIKE ? ESCAPE '\\')");
      binds.push(like, like, like);
    }
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const sql = `${SELECT_TASK} WHERE ${where.join(' AND ')} ${order} LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, limit).all();
  return results.map((r) => shape(r, t));
}

// ---------------------------------------------------------------- scrittura

/**
 * Crea uno o piu' task. Senza area il task va in inbox: si smista dopo.
 */
export async function createTasks(env, items, source = 'api') {
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) throw new ValidationError('nessun task da creare');
  if (list.length > MAX_BATCH) throw new ValidationError(`al massimo ${MAX_BATCH} task per volta`);
  checkEnum(source, 'source', SOURCES);

  // Si valida tutto PRIMA di scrivere: un errore al terzo task non deve
  // lasciare i primi due creati a meta' di una richiesta fallita.
  const prepared = [];
  for (const item of list) {
    const title = cleanText(item?.title, 'title', MAX_TITLE, { required: true });
    if (title === undefined) throw new ValidationError('title obbligatorio');
    const notes = cleanText(item.notes, 'notes', MAX_NOTES) ?? null;
    const area = checkEnum(item.area || undefined, 'area', AREAS) ?? null;
    const priority = checkEnum(item.priority || undefined, 'priority', PRIORITIES) ?? 'normal';
    const status = checkEnum(item.status || undefined, 'status', STATUSES);

    let dueDate = null;
    if (item.due_date !== undefined && item.due_date !== null && item.due_date !== '') {
      dueDate = resolveDate(item.due_date, env);
      if (!dueDate) throw new ValidationError(`due_date non valida per "${title}": usa YYYY-MM-DD`);
    }
    let dueTime = null;
    if (item.due_time) {
      if (!isTime(item.due_time)) throw new ValidationError(`due_time non valida per "${title}": usa HH:MM`);
      if (!dueDate) dueDate = today(env);
      dueTime = item.due_time;
    }
    prepared.push({ title, notes, area, priority, status, dueDate, dueTime, project: item.project });
  }

  const ids = [];
  for (const p of prepared) {
    let area = p.area;
    const project = p.project ? await resolveProject(env, p.project, area) : null;
    if (project && !area) area = project.area;
    const status = p.status ?? (area ? 'todo' : 'inbox');
    const now = nowIso();
    const row = await env.DB.prepare(`
      INSERT INTO tasks (title, notes, area, project_id, status, priority, due_date, due_time, source,
                         created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(p.title, p.notes, area, project?.id ?? null, status, p.priority, p.dueDate, p.dueTime, source,
            now, now, status === 'done' ? now : null).first();
    ids.push(row.id);
  }
  await logEvent(env, 'task.created', { ids, source });
  return getTasksByIds(env, ids);
}

/**
 * Modifica uno o piu' task, ognuno con i suoi campi. Un campo assente resta
 * com'e'; null lo svuota.
 */
export async function updateTasks(env, updates, source = 'api') {
  const list = Array.isArray(updates) ? updates : [updates];
  if (list.length === 0) throw new ValidationError('nessuna modifica');
  if (list.length > MAX_BATCH) throw new ValidationError(`al massimo ${MAX_BATCH} task per volta`);

  const touched = [];
  const missing = [];
  for (const u of list) {
    const [id] = checkIds(u?.id);
    const current = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
    if (!current) { missing.push(id); continue; }

    const sets = {};
    const title = cleanText(u.title, 'title', MAX_TITLE, { required: true });
    if (title !== undefined) sets.title = title;
    const notes = cleanText(u.notes, 'notes', MAX_NOTES);
    if (notes !== undefined) sets.notes = notes;
    const area = checkEnum(u.area, 'area', AREAS);
    if (area !== undefined) sets.area = area;
    const priority = checkEnum(u.priority, 'priority', PRIORITIES);
    if (priority !== undefined) sets.priority = priority;

    if (u.project !== undefined) {
      const p = await resolveProject(env, u.project, area ?? current.area);
      sets.project_id = p ? p.id : null;
      if (p && !current.area && area === undefined) sets.area = p.area;
    }

    if (u.due_date !== undefined) {
      const d = resolveDate(u.due_date, env);
      if (d === undefined) throw new ValidationError(`due_date non valida per il task ${id}: usa YYYY-MM-DD, today, tomorrow, next_week o null`);
      sets.due_date = d;
      if (d === null) sets.due_time = null;
    }
    if (u.due_time !== undefined) {
      if (u.due_time !== null && !isTime(u.due_time)) throw new ValidationError(`due_time non valida per il task ${id}: usa HH:MM`);
      sets.due_time = u.due_time;
      if (u.due_time && !(sets.due_date ?? current.due_date)) sets.due_date = today(env);
    }

    let status = checkEnum(u.status, 'status', STATUSES);
    // Smistare un task dell'inbox (dargli un'area) lo rende "da fare".
    if (status === undefined && current.status === 'inbox' && (sets.area ?? current.area)) status = 'todo';
    if (status !== undefined && status !== current.status) {
      sets.status = status;
      sets.completed_at = status === 'done' ? nowIso() : null;
    }

    if (u.restore === true) sets.deleted_at = null;

    if (Object.keys(sets).length === 0) { touched.push(id); continue; }
    sets.updated_at = nowIso();
    const cols = Object.keys(sets);
    await env.DB.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((c) => sets[c]), id)
      .run();
    touched.push(id);
    await logEvent(env, 'task.updated', { id, changes: sets, source });
  }
  return { tasks: touched.length ? await getTasksByIds(env, touched) : [], not_found: missing };
}

export async function completeTasks(env, ids, { reopen = false, source = 'api' } = {}) {
  const list = checkIds(ids);
  const now = nowIso();
  const sql = reopen
    ? `UPDATE tasks SET status = CASE WHEN area IS NULL THEN 'inbox' ELSE 'todo' END,
         completed_at = NULL, updated_at = ? WHERE status = 'done' AND id IN (${placeholders(list.length)})`
    : `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?
         WHERE status != 'done' AND id IN (${placeholders(list.length)})`;
  const binds = reopen ? [now, ...list] : [now, now, ...list];
  await env.DB.prepare(sql).bind(...binds).run();
  await logEvent(env, reopen ? 'task.reopened' : 'task.completed', { ids: list, source });
  return withMissing(await getTasksByIds(env, list), list);
}

/** Nel cestino, non via: si recupera per 30 giorni. */
export async function trashTasks(env, ids, { source = 'api' } = {}) {
  const list = checkIds(ids);
  const now = nowIso();
  await env.DB.prepare(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND id IN (${placeholders(list.length)})`)
    .bind(now, now, ...list)
    .run();
  await logEvent(env, 'task.trashed', { ids: list, source });
  return withMissing(await getTasksByIds(env, list), list);
}

export async function restoreTasks(env, ids, { source = 'api' } = {}) {
  const list = checkIds(ids);
  await env.DB.prepare(`UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id IN (${placeholders(list.length)})`)
    .bind(nowIso(), ...list)
    .run();
  await logEvent(env, 'task.restored', { ids: list, source });
  return withMissing(await getTasksByIds(env, list), list);
}

function withMissing(tasks, ids) {
  const found = new Set(tasks.map((t) => t.id));
  return { tasks, not_found: ids.filter((id) => !found.has(id)) };
}

/** Svuota il cestino dei task buttati da piu' di 30 giorni. Lo chiama il cron. */
export async function purgeTrash(env) {
  const limit = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  const res = await env.DB.prepare('DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(limit).run();
  const removed = res.meta?.changes ?? 0;
  if (removed) await logEvent(env, 'trash.purged', { removed });
  return removed;
}

// ---------------------------------------------------------------- quadri d'insieme

/** "Come sono messo?" in una chiamata sola. */
export async function overview(env) {
  const t = today(env);
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
      SUM(CASE WHEN status != 'done' AND due_date < ?1 THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN status != 'done' AND due_date = ?1 THEN 1 ELSE 0 END) AS due_today,
      SUM(CASE WHEN status != 'done' AND due_date > ?1 AND due_date <= ?2 THEN 1 ELSE 0 END) AS next_7_days,
      SUM(CASE WHEN status = 'todo' AND due_date IS NULL THEN 1 ELSE 0 END) AS no_date,
      SUM(CASE WHEN status != 'done' AND area = 'work' THEN 1 ELSE 0 END) AS open_work,
      SUM(CASE WHEN status != 'done' AND area = 'personal' THEN 1 ELSE 0 END) AS open_personal,
      SUM(CASE WHEN status = 'done' AND completed_at >= ?3 THEN 1 ELSE 0 END) AS done_last_7_days
    FROM tasks WHERE deleted_at IS NULL
  `).bind(t, addDays(t, 7), new Date(Date.now() - 7 * 86400000).toISOString()).first();

  const counts = Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, v ?? 0]));
  return { today: t, counts };
}

/**
 * La revisione settimanale: cosa e' in ritardo, cosa e' fermo, cosa aspetta
 * di essere smistato, cosa hai chiuso. Il giudizio su cosa buttare lo da'
 * Claude, non il codice.
 */
export async function weeklyReview(env) {
  const t = today(env);
  const staleBefore = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const q = (sql, ...binds) =>
    env.DB.prepare(sql).bind(...binds).all().then((r) => r.results.map((x) => shape(x, t)));

  const [overdue, stale, inbox, done, upcoming] = await Promise.all([
    q(`${SELECT_TASK} WHERE t.deleted_at IS NULL AND t.status != 'done' AND t.due_date < ? ${ORDER_OPEN}`, t),
    q(`${SELECT_TASK} WHERE t.deleted_at IS NULL AND t.status = 'todo' AND (t.due_date IS NULL OR t.due_date >= ?)
        AND t.updated_at < ? ORDER BY t.updated_at LIMIT 50`, t, staleBefore),
    q(`${SELECT_TASK} WHERE t.deleted_at IS NULL AND t.status = 'inbox' ORDER BY t.created_at`),
    q(`${SELECT_TASK} WHERE t.deleted_at IS NULL AND t.status = 'done' AND t.completed_at >= ? ORDER BY t.completed_at DESC`, weekAgo),
    q(`${SELECT_TASK} WHERE t.deleted_at IS NULL AND t.status != 'done' AND t.due_date >= ? AND t.due_date <= ? ${ORDER_OPEN}`, t, addDays(t, 7)),
  ]);
  return { today: t, stale_after_days: STALE_DAYS, overdue, stale, inbox, done_last_7_days: done, next_7_days: upcoming };
}

// ---------------------------------------------------------------- registro

export async function logEvent(env, type, details = {}) {
  try {
    await env.DB.prepare('INSERT INTO events (type, details) VALUES (?, ?)').bind(type, JSON.stringify(details)).run();
  } catch (e) {
    // Il registro non deve mai far fallire l'operazione che racconta.
    console.error('[events]', type, e?.message);
  }
}

export async function countEvents(env, type, sinceIso, { ip } = {}) {
  const sql = ip
    ? "SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ? AND json_extract(details, '$.ip') = ?"
    : 'SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ?';
  const row = await env.DB.prepare(sql).bind(...(ip ? [type, sinceIso, ip] : [type, sinceIso])).first();
  return row?.n ?? 0;
}
