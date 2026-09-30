/**
 * L'API REST: la usa la web app, e qualsiasi script con API_TOKEN.
 *
 *   POST   /api/login                 { password }        -> cookie di sessione
 *   POST   /api/logout
 *   GET    /api/me
 *
 *   GET    /api/overview
 *   GET    /api/review
 *   GET    /api/tasks?view=&area=&project=&query=&priority=&due_from=&due_to=&days=&limit=
 *   POST   /api/tasks                 { title, ... } oppure { tasks: [...] }
 *   GET    /api/tasks/:id
 *   PATCH  /api/tasks/:id             { campi da cambiare }
 *   POST   /api/tasks/:id/complete
 *   POST   /api/tasks/:id/reopen
 *   DELETE /api/tasks/:id             -> cestino
 *   POST   /api/tasks/:id/restore
 *   GET    /api/projects
 *   PATCH  /api/projects/:id          { name, area, archived }
 */

import * as store from './store.js';
import {
  checkPassword, createSession, sessionCookie, clearSessionCookie, isAuthenticated,
} from './auth.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE, ...headers } });

const error = (message, status) => json({ error: message }, status);

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  // Pretendere JSON chiude la porta ai form di altri siti: un form HTML non
  // puo' mandare application/json senza passare dal controllo CORS.
  if (!type.includes('application/json')) throw new store.ValidationError('serve Content-Type: application/json');
  try {
    return await request.json();
  } catch {
    throw new store.ValidationError('corpo JSON non leggibile');
  }
}

/** Una richiesta che cambia qualcosa deve arrivare da questo stesso sito. */
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // script, curl, app native
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (method !== 'GET' && !sameOrigin(request)) return error('origine non consentita', 403);

  try {
    // ------------------------------------------------ accesso
    if (path === '/api/login' && method === 'POST') {
      const body = await readJson(request);
      const result = await checkPassword(env, request, String(body?.password ?? ''));
      if (result.blocked) return error('troppi tentativi, riprova fra 15 minuti', 429);
      if (!result.ok) return error('password sbagliata', 401);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(await createSession(env)) });
    }
    if (path === '/api/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    }

    const authed = await isAuthenticated(env, request);
    if (path === '/api/me') return json({ authenticated: authed });
    if (!authed) return error('accesso richiesto', 401);

    const source = (request.headers.get('Authorization') || '').startsWith('Bearer ') ? 'api' : 'web';

    // ------------------------------------------------ quadri
    if (path === '/api/overview' && method === 'GET') return json(await store.overview(env));
    if (path === '/api/review' && method === 'GET') return json(await store.weeklyReview(env));

    // ------------------------------------------------ progetti
    if (path === '/api/projects' && method === 'GET') {
      return json({ projects: await store.listProjects(env, { includeArchived: url.searchParams.get('archived') === '1' }) });
    }
    let m = path.match(/^\/api\/projects\/(\d+)$/);
    if (m && method === 'PATCH') {
      const project = await store.updateProject(env, m[1], await readJson(request));
      return project ? json({ project }) : error('progetto non trovato', 404);
    }

    // ------------------------------------------------ task
    if (path === '/api/tasks') {
      if (method === 'GET') {
        const filters = Object.fromEntries(url.searchParams.entries());
        const tasks = await store.listTasks(env, filters);
        return json({ count: tasks.length, tasks });
      }
      if (method === 'POST') {
        const body = await readJson(request);
        const items = Array.isArray(body?.tasks) ? body.tasks : [body];
        const tasks = await store.createTasks(env, items, source);
        return json({ tasks }, 201);
      }
    }

    m = path.match(/^\/api\/tasks\/(\d+)(?:\/(complete|reopen|restore))?$/);
    if (m) {
      const id = Number(m[1]);
      const action = m[2];
      if (!action && method === 'GET') {
        const task = await store.getTask(env, id);
        return task ? json({ task }) : error('task non trovato', 404);
      }
      if (!action && method === 'PATCH') {
        const body = await readJson(request);
        const res = await store.updateTasks(env, [{ ...body, id }], source);
        return res.tasks.length ? json({ task: res.tasks[0] }) : error('task non trovato', 404);
      }
      if (!action && method === 'DELETE') {
        const res = await store.trashTasks(env, [id], { source });
        return res.tasks.length ? json({ task: res.tasks[0] }) : error('task non trovato', 404);
      }
      if (action && method === 'POST') {
        const res = action === 'restore'
          ? await store.restoreTasks(env, [id], { source })
          : await store.completeTasks(env, [id], { reopen: action === 'reopen', source });
        return res.tasks.length ? json({ task: res.tasks[0] }) : error('task non trovato', 404);
      }
    }

    return error('non trovato', 404);
  } catch (e) {
    if (e instanceof store.ValidationError) return error(e.message, 400);
    console.error('[api]', method, path, e);
    return error('errore interno', 500);
  }
}
