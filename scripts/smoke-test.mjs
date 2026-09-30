// Prova end-to-end di un'installazione LOCALE: API REST, login, OAuth, MCP.
//
//   1. cp .dev.vars.example .dev.vars
//   2. npm run db:locale        (database locale VUOTO: il test crea dati suoi)
//   3. npm run dev              (in un altro terminale)
//   4. npm test
//
// Legge password e token da .dev.vars, quindi non contiene segreti.
// Rifiuta di girare contro un indirizzo che non sia locale: crea task di
// prova, e non devono finire nella tua installazione vera.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const host = (() => { try { return new URL(BASE).hostname; } catch { return ''; } })();
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error('Rifiuto di girare su ' + BASE + ': questo test scrive dati e va usato solo in locale.');
  process.exit(2);
}

function devVar(name) {
  try {
    const lines = readFileSync('.dev.vars', 'utf8').split(/\r?\n/);
    const line = lines.find((l) => l.startsWith(name + '='));
    return line ? line.slice(name.length + 1).trim() : null;
  } catch {
    return null;
  }
}
const PASSWORD = devVar('APP_PASSWORD');
const TOKEN = devVar('API_TOKEN');
if (!PASSWORD || !TOKEN) {
  console.error('Servono APP_PASSWORD e API_TOKEN in .dev.vars (copia .dev.vars.example).');
  process.exit(2);
}
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  try { data = await res.clone().json(); } catch { data = await res.text(); }
  return { status: res.status, data, res };
};

const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const plus = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };

console.log('\n== REST');
check('home risponde', (await fetch(BASE + '/')).status === 200);
check('senza auth 401', (await fetch(BASE + '/api/tasks')).status === 401);
check('token sbagliato 401', (await api('GET', '/api/tasks', null, { Authorization: 'Bearer nope' })).status === 401);

let r = await api('POST', '/api/login', { password: 'sbagliata' }, { Authorization: '' });
check('login sbagliato 401', r.status === 401, JSON.stringify(r.data));
r = await api('POST', '/api/login', { password: PASSWORD }, { Authorization: '' });
const cookie = (r.res.headers.get('set-cookie') || '').split(';')[0];
check('login giusto + cookie', r.status === 200 && cookie.startsWith('__Host-tm_session='), r.status);
r = await api('GET', '/api/me', null, { Authorization: '', Cookie: cookie });
check('cookie valido', r.data?.authenticated === true);
r = await api('GET', '/api/me', null, { Authorization: '', Cookie: cookie.slice(0, -3) + 'xxx' });
check('cookie manomesso rifiutato', r.data?.authenticated === false);

r = await api('POST', '/api/tasks', { tasks: [
  { title: 'Rivedere preventivo', area: 'work', project: 'Alpha', due_date: plus(localToday, 3), priority: 'high' },
  { title: 'Prenotare dentista', area: 'personal', due_date: 'tomorrow' },
  { title: 'Idea sparsa senza area' },
  { title: 'Pagare bolletta', area: 'personal', due_date: plus(localToday, -2) },
  { title: 'Chiamare Marco', area: 'work', due_time: '15:00' },
] });
check('crea 5 task', r.status === 201 && r.data.tasks.length === 5, JSON.stringify(r.data));
const [first, dent, idea, bolletta, marco] = r.data.tasks ?? [];
check('progetto creato e collegato', first?.project === 'Alpha');
check('tomorrow risolto', dent?.due_date === plus(localToday, 1), dent?.due_date);
check('senza area -> inbox', idea?.status === 'inbox' && idea?.area === null);
check('con area -> todo', dent?.status === 'todo');
check('arretrato marcato overdue', bolletta?.overdue === true);
check('ora senza data -> oggi', marco?.due_date === localToday && marco?.due_time === '15:00');

r = await api('POST', '/api/tasks', { tasks: [{ title: 'ok' }, { title: 'data rotta', due_date: '2026-02-31' }] });
check('data impossibile 400', r.status === 400, JSON.stringify(r.data));
r = await api('GET', '/api/tasks?view=all&query=ok');
check('batch invalido non scrive nulla', r.data.count === 0, JSON.stringify(r.data));

r = await api('POST', '/api/tasks', { title: 'x', project: 'ProgettoNuovo' });
check('progetto nuovo senza area 400', r.status === 400);

r = await api('GET', '/api/tasks?view=today');
check('today = arretrati + oggi', r.data.tasks.map((t) => t.title).join('|') === 'Pagare bolletta|Chiamare Marco', r.data.tasks?.map((t) => t.title));
r = await api('GET', '/api/tasks?view=inbox');
check('inbox', r.data.count === 1);
r = await api('GET', '/api/tasks?view=upcoming');
check('upcoming 7gg', r.data.count === 2, r.data.count);
r = await api('GET', '/api/tasks?view=open&area=work');
check('filtro area', r.data.count === 2);
r = await api('GET', '/api/tasks?query=' + encodeURIComponent('preventivo rivedere'));
check('ricerca parole in ordine diverso', r.data.count === 1);
r = await api('GET', '/api/tasks?query=alpha');
check('ricerca per nome progetto', r.data.count === 1);
r = await api('GET', '/api/tasks?query=' + encodeURIComponent('100%'));
check('ricerca con % non esplode', r.status === 200);
r = await api('GET', '/api/tasks?project=alpha');
check('filtro progetto case-insensitive', r.data.count === 1);

r = await api('PATCH', `/api/tasks/${idea.id}`, { area: 'personal' });
check('smistare inbox -> todo', r.data.task?.status === 'todo' && r.data.task?.area === 'personal', JSON.stringify(r.data));
r = await api('PATCH', `/api/tasks/${bolletta.id}`, { due_date: 'today' });
check('rinvio a oggi', r.data.task?.due_date === localToday && r.data.task?.overdue === false);
r = await api('PATCH', `/api/tasks/${marco.id}`, { due_date: null });
check('togliere data toglie ora', r.data.task?.due_date === null && r.data.task?.due_time === null);
r = await api('PATCH', `/api/tasks/${marco.id}`, { due_time: '25:00' });
check('ora invalida 400', r.status === 400);
r = await api('PATCH', '/api/tasks/99999', { title: 'boh' });
check('task inesistente 404', r.status === 404);

r = await api('POST', `/api/tasks/${dent.id}/complete`);
check('completa', r.data.task?.status === 'done' && !!r.data.task?.completed_at);
r = await api('POST', `/api/tasks/${dent.id}/reopen`);
check('riapri', r.data.task?.status === 'todo' && r.data.task?.completed_at === null);
r = await api('DELETE', `/api/tasks/${dent.id}`);
check('cestino', !!r.data.task?.deleted_at);
r = await api('GET', '/api/tasks?view=open');
check('cestinato sparisce dagli aperti', !r.data.tasks.some((t) => t.id === dent.id));
r = await api('GET', '/api/tasks?view=trash');
check('compare nel cestino', r.data.tasks.some((t) => t.id === dent.id));
r = await api('POST', `/api/tasks/${dent.id}/restore`);
check('ripristina', r.data.task?.deleted_at === null && r.data.task?.status === 'todo');

r = await api('GET', '/api/overview');
check('overview', r.data.today === localToday && typeof r.data.counts?.inbox === 'number', JSON.stringify(r.data));
r = await api('GET', '/api/projects');
check('progetti con conteggio', r.data.projects?.[0]?.name === 'Alpha' && r.data.projects[0].open_tasks === 1, JSON.stringify(r.data));
r = await api('GET', '/api/review');
check('review', Array.isArray(r.data.stale) && Array.isArray(r.data.next_7_days));

r = await api('POST', '/api/tasks', { title: 'csrf' }, { Origin: 'https://evil.example' });
check('origine estranea 403', r.status === 403);
r = await fetch(BASE + '/api/tasks', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' }, body: '{"title":"x"}' });
check('content-type non json 400', r.status === 400);

console.log('\n== OAuth + MCP');
r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('MCP senza token 401', r.status === 401);
check('WWW-Authenticate presente', (r.headers.get('www-authenticate') || '').includes('Bearer'));
const meta = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
check('metadati OAuth', meta.authorization_endpoint?.endsWith('/authorize') && meta.registration_endpoint);
const prm = await fetch(BASE + '/.well-known/oauth-protected-resource/mcp');
check('metadati risorsa protetta', prm.status === 200, prm.status);

const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
const reg = await (await fetch(meta.registration_endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude <script>', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
})).json();
check('registrazione client', !!reg.client_id, JSON.stringify(reg));

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'st123', resource: BASE + '/mcp' });
r = await fetch(`${BASE}/authorize?${q}`);
const html = await r.text();
check('pagina password', r.status === 200 && html.includes('type="password"'));
check('nome client escapato', html.includes('Claude &lt;script&gt;') && !html.includes('<script>'));
check('mostra dominio di destinazione', html.includes('claude.ai'));

const post = (pw) => fetch(`${BASE}/authorize?${q}`, { method: 'POST', body: new URLSearchParams({ password: pw }), redirect: 'manual' });
r = await post('sbagliata');
check('password sbagliata -> niente codice', r.status === 401);
r = await post(PASSWORD);
const loc = r.headers.get('location') || '';
check('redirect con code', r.status === 302 && loc.startsWith(redirectUri) && loc.includes('code=') && loc.includes('state=st123'), `${r.status} ${loc}`);
const code = new URL(loc).searchParams.get('code');

const tok = await (await fetch(BASE + meta.token_endpoint.replace(/^https?:\/\/[^/]+/, ''), {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier, resource: BASE + '/mcp' }),
})).json();
check('access token', !!tok.access_token && !!tok.refresh_token, JSON.stringify(tok));

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  const payload = text.trim().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  try { return { status: res.status, body: JSON.parse(payload) }; } catch { return { status: res.status, body: text }; }
};

r = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
check('initialize', r.body?.result?.serverInfo?.name === 'task-manager', JSON.stringify(r).slice(0, 400));
check('istruzioni con la data di oggi', (r.body?.result?.instructions || '').includes(localToday));

r = await mcp('tools/list', {});
const names = (r.body?.result?.tools || []).map((t) => t.name).sort();
check('8 tool', names.join(',') === 'complete_task,create_tasks,delete_task,get_overview,list_projects,list_tasks,update_task,weekly_review', names.join(','));
const del = r.body?.result?.tools?.find((t) => t.name === 'delete_task');
check('delete marcato distruttivo', del?.annotations?.destructiveHint === true);

const call = async (name, args) => {
  const res = await mcp('tools/call', { name, arguments: args });
  const c = res.body?.result;
  let data = null;
  try { data = JSON.parse(c?.content?.[0]?.text); } catch { data = c?.content?.[0]?.text; }
  return { isError: !!c?.isError, data, raw: res };
};

let c = await call('create_tasks', { tasks: [
  { title: 'Rispondere alla mail di Giulia', area: 'work', project: 'Alpha', due_date: localToday },
  { title: 'Comprare regalo compleanno', area: 'personal', due_date: plus(localToday, 5), notes: 'budget 50 euro' },
] });
check('MCP create_tasks', !c.isError && c.data?.created?.length === 2, JSON.stringify(c.raw).slice(0, 400));
check('risposta compatta (niente campi vuoti)', c.data?.created?.[1]?.notes === 'budget 50 euro' && !('project' in c.data.created[1]) && !('priority' in c.data.created[1]));
const giulia = c.data?.created?.[0];

c = await call('list_tasks', { view: 'today' });
check('MCP list_tasks today', !c.isError && c.data?.tasks?.some((t) => t.id === giulia?.id), JSON.stringify(c.data));
c = await call('list_tasks', { query: 'mail giulia' });
check('MCP ricerca', c.data?.count === 1);
c = await call('update_task', { updates: [{ id: giulia.id, due_date: 'tomorrow', priority: 'high' }] });
check('MCP update_task', c.data?.updated?.[0]?.due_date === plus(localToday, 1) && c.data.updated[0].priority === 'high', JSON.stringify(c.data));
c = await call('update_task', { updates: [{ id: giulia.id, due_date: 'venerdi' }] });
check('MCP errore leggibile al modello', c.isError && String(c.data).includes('due_date'), JSON.stringify(c.raw).slice(0, 300));
c = await call('complete_task', { ids: [giulia.id, 424242] });
check('MCP complete_task + not_found', c.data?.completed?.[0]?.status === 'done' && c.data.not_found?.[0] === 424242, JSON.stringify(c.data));
c = await call('delete_task', { ids: [giulia.id] });
check('MCP delete_task', !!c.data?.trashed?.[0]?.deleted_at);
c = await call('update_task', { updates: [{ id: giulia.id, restore: true }] });
check('MCP restore', c.data?.updated?.[0] && !c.data.updated[0].deleted_at, JSON.stringify(c.data));
c = await call('get_overview', {});
check('MCP get_overview', c.data?.today === localToday);
c = await call('list_projects', {});
check('MCP list_projects', c.data?.projects?.length === 1);
c = await call('weekly_review', {});
check('MCP weekly_review', Array.isArray(c.data?.overdue));
c = await call('create_tasks', { tasks: [{ title: '' }] });
check('MCP titolo vuoto rifiutato', c.isError || c.raw.body?.error, JSON.stringify(c.raw).slice(0, 300));

// refresh token
const ref = await (await fetch(BASE + '/oauth/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }),
})).json();
check('refresh token', !!ref.access_token, JSON.stringify(ref));

console.log(`\n${pass} ok, ${fail} falliti`);
process.exit(fail ? 1 : 0);
