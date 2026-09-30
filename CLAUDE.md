# Task Manager MCP: regole del progetto

Per chi (persona o agente) modifica questo codice. L'installazione e' spiegata nel `README.md`.

## Stack
Un solo Cloudflare Worker in JavaScript, senza build: D1 per i dati, KV per i token OAuth, file statici in `public/`. Deve restare eseguibile **sul piano gratuito**: niente servizi a pagamento.

## Dove sta cosa
```
src/index.js      ingresso: OAuthProvider davanti a /mcp, il resto all'app
src/mcp.js        server MCP (8 strumenti) + istruzioni per il modello
src/api.js        API REST per web app e script
src/store.js      UNICO posto che scrive SQL
src/dates.js      UNICA risposta a "che giorno e' oggi" (fuso da TIMEZONE)
src/auth.js       password, sessione, limite tentativi
src/authorize.js  pagina password del flusso OAuth
migrations/       schema D1
public/           web app: index.html, app.js, style.css, sw.js, manifest
```

## Regole
1. Tutte le letture e scritture passano da `store.js`. MCP e API non toccano il database.
2. Le date passano da `dates.js`. Il server e' in UTC, l'utente no.
3. Il cestino e' `deleted_at`, non uno stato. Nessuna cancellazione definitiva se non dal cron dopo 30 giorni.
4. Un batch si valida tutto prima di scrivere.
5. Gli errori di validazione tornano al modello come testo leggibile (`isError`), cosi' si corregge da solo.
6. **Nessun segreto nel codice o nei file versionati.** Password e chiavi stanno nei secrets di Cloudflare (`wrangler secret put`); in locale in `.dev.vars`, che e' escluso da git.
7. Ogni nuova rotta protetta deve verificare l'accesso dentro la rotta, non solo a monte.

## Comandi
```
npm run dev          # Worker in locale su http://127.0.0.1:8787
npm run db:locale    # migrazioni sul database locale
npm run db:remoto    # migrazioni sul database in produzione
npm test             # verifica end-to-end, SOLO su un'installazione locale vuota
npm run deploy
```

## Trappole note
- Con `assets.run_worker_first` il documento principale passa dal Worker. Il servizio statico normalizza `/index.html` in `/` con un redirect: per servire la pagina si passa la richiesta cosi' com'e', gia' su `/`.
- `OAuthProvider` vuole `apiHandler` come oggetto con `fetch`, non una funzione.
- Il server MCP usa `createMcpHandler` da `agents/mcp/server` con `@modelcontextprotocol/server` 2.0.0. Non usare l'SDK v1 ne' `McpAgent`: sono deprecati.
- Se cambi `database_id` in `wrangler.jsonc`, il database locale ricomincia vuoto (lo stato locale e' legato all'id): riesegui `npm run db:locale`.
