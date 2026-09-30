/**
 * Il server MCP: quello che vedono Claude e ChatGPT.
 *
 * Qui non c'e' logica sui task: ogni tool traduce la richiesta e chiama
 * store.js. Il ragionamento (che area e', che giorno e' "venerdi'") lo fa il
 * modello, guidato dalle istruzioni qui sotto.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import * as store from './store.js';
import { today, weekdayName, addDays } from './dates.js';

function instructions(env) {
  const t = today(env);
  const next = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(t, i + 1);
    return `${weekdayName(d)} ${d}`;
  }).join(', ');

  // Cosa conta come "lavoro" e' l'unica cosa da personalizzare: si cambia
  // con la variabile WORK_CONTEXT in wrangler.jsonc, senza toccare il codice.
  const work = env.WORK_CONTEXT || 'clienti, colleghi, fornitori, amministrazione della propria attivita\'';

  return `Task manager personale: lavoro e vita privata insieme.
Oggi e' ${weekdayName(t)} ${t} (fuso ${env.TIMEZONE || 'Europe/Rome'}). Prossimi giorni: ${next}.

Come usarlo:
- Rispondi sempre in italiano, in modo breve.
- Titoli brevi che iniziano con un verbo all'infinito ("Chiamare Marco per il preventivo"). I dettagli vanno in notes.
- area: "work" per il lavoro (${work}); "personal" per tutto il resto (casa, salute, famiglia, amici, sport, spese personali). Se e' davvero ambiguo non indicare l'area: il task finisce in inbox e si smista dopo.
- Converti le date relative in YYYY-MM-DD usando la data di oggi ("entro venerdi'" = quel venerdi'). Se l'utente non dice una data, non inventarla.
- due_time solo se l'utente indica un orario.
- priority "high" solo se l'utente dice che e' urgente o importante, o la scadenza e' stretta. Altrimenti non indicarla.
- project: prima di assegnarne uno chiama list_projects e riusa i nomi esistenti. Crea un progetto nuovo solo se l'utente lo nomina chiaramente.
- Un messaggio con piu' cose da fare diventa piu' task in una sola chiamata a create_tasks.
- Per chiudere, modificare o eliminare un task descritto a parole, cercalo prima con list_tasks (parametro query). Se ci sono piu' candidati chiedi quale: non indovinare.
- "Cosa ho oggi?" = list_tasks con view "today" (include gli arretrati). "Come sono messo?" = get_overview.
- delete_task sposta nel cestino, recuperabile per 30 giorni. Prima di eliminare piu' di un task chiedi conferma.
- "Smista l'inbox": list_tasks view "inbox", poi update_task con area (ed eventualmente project, due_date) per ciascuno, in una sola chiamata.
- "Revisione settimanale": weekly_review, poi proponi cosa chiudere, rinviare o buttare, e agisci solo dopo la conferma.
- Dopo ogni modifica conferma in una riga cosa hai fatto.`;
}

// Nelle risposte al modello i task viaggiano compatti: niente campi vuoti,
// niente timestamp che non servono. Ogni token in meno e' contesto in piu'.
function compact(task) {
  const out = {};
  for (const k of ['id', 'title', 'notes', 'area', 'project', 'status', 'priority', 'due_date', 'due_time']) {
    if (task[k] !== null && task[k] !== undefined) out[k] = task[k];
  }
  if (out.priority === 'normal') delete out.priority;
  if (task.overdue) out.overdue = true;
  if (task.completed_at) out.completed_at = task.completed_at;
  if (task.deleted_at) out.deleted_at = task.deleted_at;
  return out;
}

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

/** Un errore di validazione torna al modello come testo, cosi' puo' correggersi. */
function tool(fn) {
  return async (args) => {
    try {
      return await fn(args ?? {});
    } catch (e) {
      if (e instanceof store.ValidationError) {
        return { isError: true, content: [{ type: 'text', text: `Errore: ${e.message}` }] };
      }
      console.error('[mcp]', e);
      return { isError: true, content: [{ type: 'text', text: 'Errore interno del task manager. Riprova fra poco.' }] };
    }
  };
}

const area = z.enum(['work', 'personal']);
const priority = z.enum(['high', 'normal', 'low']);
const dateStr = z.string().describe('YYYY-MM-DD, oppure "today", "tomorrow", "next_week" (prossimo lunedi)');
const timeStr = z.string().describe('HH:MM, 24 ore');
const ids = z.array(z.number().int().positive()).min(1).max(100);

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildServer(env) {
  const server = new McpServer(
    { name: 'task-manager', version: '0.1.0' },
    { instructions: instructions(env) }
  );

  server.registerTool('get_overview', {
    title: 'Quadro generale',
    description: "Data di oggi e conteggi: inbox, in ritardo, in scadenza oggi, prossimi 7 giorni, senza data, aperti per area, chiusi negli ultimi 7 giorni. Usalo per \"come sono messo?\".",
    inputSchema: z.object({}),
    annotations: READ,
  }, tool(async () => json(await store.overview(env))));

  server.registerTool('list_tasks', {
    title: 'Elenca e cerca task',
    description: 'Elenca i task con filtri combinabili. view: today (oggi + arretrati), overdue, upcoming (prossimi N giorni, default 7), inbox (da smistare), open (tutti gli aperti, default), no_date, done (chiusi, piu recenti prima), trash (cestino), all. query cerca parole in titolo, note e nome progetto.',
    inputSchema: z.object({
      view: z.enum(store.VIEWS).optional(),
      area: area.optional(),
      project: z.string().optional().describe('Nome del progetto'),
      query: z.string().optional().describe('Parole da cercare, tutte devono comparire'),
      priority: priority.optional(),
      due_from: dateStr.optional(),
      due_to: dateStr.optional(),
      days: z.number().int().min(1).max(60).optional().describe('Solo per view "upcoming"'),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    annotations: READ,
  }, tool(async (args) => {
    const tasks = await store.listTasks(env, args);
    return json({ today: today(env), count: tasks.length, tasks: tasks.map(compact) });
  }));

  server.registerTool('create_tasks', {
    title: 'Crea task',
    description: "Crea uno o piu task in una chiamata. Senza area il task va in inbox. Un progetto che non esiste viene creato (serve l'area).",
    inputSchema: z.object({
      tasks: z.array(z.object({
        title: z.string().min(1).max(500),
        notes: z.string().max(5000).optional(),
        area: area.optional(),
        project: z.string().max(100).optional(),
        priority: priority.optional(),
        due_date: dateStr.optional(),
        due_time: timeStr.optional(),
      })).min(1).max(100),
    }),
    annotations: WRITE,
  }, tool(async ({ tasks }) => {
    const created = await store.createTasks(env, tasks, 'claude');
    return json({ created: created.map(compact) });
  }));

  server.registerTool('update_task', {
    title: 'Modifica task',
    description: 'Modifica uno o piu task, ognuno con i propri campi. Un campo assente resta invariato; null lo svuota (es. due_date null = senza data). Dare un\'area a un task in inbox lo rende "todo". status "done" lo chiude. restore true lo recupera dal cestino.',
    inputSchema: z.object({
      updates: z.array(z.object({
        id: z.number().int().positive(),
        title: z.string().min(1).max(500).optional(),
        notes: z.string().max(5000).nullable().optional(),
        area: area.optional(),
        project: z.string().max(100).nullable().optional(),
        priority: priority.optional(),
        due_date: dateStr.nullable().optional(),
        due_time: timeStr.nullable().optional(),
        status: z.enum(['inbox', 'todo', 'done']).optional(),
        restore: z.boolean().optional(),
      })).min(1).max(100),
    }),
    annotations: WRITE,
  }, tool(async ({ updates }) => {
    const res = await store.updateTasks(env, updates, 'claude');
    return json({ updated: res.tasks.map(compact), not_found: res.not_found });
  }));

  server.registerTool('complete_task', {
    title: 'Chiudi o riapri task',
    description: 'Segna come fatti uno o piu task. Con reopen true li riapre.',
    inputSchema: z.object({ ids, reopen: z.boolean().optional() }),
    annotations: { ...WRITE, idempotentHint: true },
  }, tool(async ({ ids: list, reopen }) => {
    const res = await store.completeTasks(env, list, { reopen: !!reopen, source: 'claude' });
    return json({ [reopen ? 'reopened' : 'completed']: res.tasks.map(compact), not_found: res.not_found });
  }));

  server.registerTool('delete_task', {
    title: 'Elimina task',
    description: 'Sposta uno o piu task nel cestino (recuperabili per 30 giorni con update_task restore true). Chiedi conferma prima di eliminarne piu di uno.',
    inputSchema: z.object({ ids }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, tool(async ({ ids: list }) => {
    const res = await store.trashTasks(env, list, { source: 'claude' });
    return json({ trashed: res.tasks.map(compact), not_found: res.not_found });
  }));

  server.registerTool('list_projects', {
    title: 'Elenca progetti',
    description: 'Progetti esistenti con area e numero di task aperti. Chiamalo prima di assegnare un progetto, per riusare i nomi giusti.',
    inputSchema: z.object({ include_archived: z.boolean().optional() }),
    annotations: READ,
  }, tool(async ({ include_archived }) => json({ projects: await store.listProjects(env, { includeArchived: !!include_archived }) })));

  server.registerTool('weekly_review', {
    title: 'Revisione settimanale',
    description: 'Materiale per la revisione: task in ritardo, fermi da oltre 14 giorni, in inbox, chiusi negli ultimi 7 giorni e in scadenza nei prossimi 7. Proponi cosa chiudere, rinviare o eliminare e agisci solo dopo conferma.',
    inputSchema: z.object({}),
    annotations: READ,
  }, tool(async () => {
    const r = await store.weeklyReview(env);
    const c = (list) => list.map(compact);
    return json({
      today: r.today,
      stale_after_days: r.stale_after_days,
      overdue: c(r.overdue),
      stale: c(r.stale),
      inbox: c(r.inbox),
      done_last_7_days: c(r.done_last_7_days),
      next_7_days: c(r.next_7_days),
    });
  }));

  return server;
}

/**
 * L'handler che OAuthProvider chiama DOPO aver verificato il token.
 * OAuthProvider vuole un oggetto con fetch, non una funzione nuda.
 */
export const mcpApiHandler = {
  fetch(request, env, ctx) {
    return createMcpHandler(() => buildServer(env), { route: '/mcp' })(request, env, ctx);
  },
};
