# Task Manager per Claude (MCP) su Cloudflare

Un task manager personale, lavoro e vita privata insieme, che puoi usare in due modi:

- **parlando con Claude**, anche dal telefono: "Oggi devo mandare le planimetrie al fornitore e domani comprare i fiori". Claude capisce che sono due task, li classifica e assegna le date;
- **da una web app** che aggiungi alla Home del telefono e che si comporta come un'app: Oggi, Inbox, Prossimi 7 giorni, Progetti, Cerca, Fatte, Cestino.

Tutto gira sul **piano gratuito di Cloudflare**. Il costo aggiuntivo è zero, oltre all'abbonamento a Claude che probabilmente hai già. I dati stanno in un database sul **tuo** account.

> **Stato del progetto.** Nato per uso personale e usato per settimane, ma non è stato sottoposto a una revisione di sicurezza esterna. Leggi la sezione [Sicurezza](#sicurezza) e usalo a tuo rischio.

---

## Quando ha senso (e quando no)

Per la maggior parte delle persone esistono già connettori pronti per Claude (Todoist, Asana, Notion): si aggiungono in due minuti e non serve costruire nulla. Questo progetto ha senso se vuoi:

- tenere i dati in un database tuo, non in un servizio di terzi;
- decidere tu le regole (cosa è lavoro, cosa va in Inbox, cestino di 30 giorni);
- capire come funziona un MCP dall'interno.

---

## Come funziona

```
Claude (app, web, telefono) ── MCP ──┐
Web app sul telefono (PWA) ──────────┼──►  Cloudflare Worker  ──►  D1 (database)
                                     │        │
                                     │        └─ KV (permessi OAuth)
                                     └─ tutto dietro la tua password
```

Un solo Worker fa tre cose: espone il server MCP (`/mcp`), le API REST (`/api/*`) e la web app. Non c'è nessun server acceso: Cloudflare avvia il codice quando arriva una richiesta.

| Cosa | Dove sta |
|---|---|
| Codice e web app | Cloudflare Worker (`src/`, `public/`) |
| Task e progetti | D1, database SQLite gestito da Cloudflare |
| Permessi di Claude | KV, un piccolo archivio chiave-valore |
| Segreti (password, chiavi) | Cloudflare secrets, **mai** nel codice |

---

## Cosa serve

- **Un account Cloudflare** (gratuito, non chiede la carta): [dash.cloudflare.com](https://dash.cloudflare.com)
- **Node.js 22 o superiore** (`node -v` per controllare)
- **Claude** con un connettore personalizzato: il piano gratuito ne permette **uno**, Pro e Max di più. I connettori personalizzati si aggiungono da claude.ai (web o desktop) e poi si usano anche da telefono. L'installazione diretta da mobile è ancora in beta.

---

## Installazione

Fai i passi in ordine, dal terminale, dentro la cartella del progetto.

### 1. Scarica e installa

```bash
git clone https://github.com/SimoCingo/task-manager-mcp.git
cd task-manager-mcp
npm install
```

### 2. Prova in locale (facoltativo, ma consigliato)

```bash
cp .dev.vars.example .dev.vars    # su Windows PowerShell: Copy-Item .dev.vars.example .dev.vars
npm run db:locale                 # crea il database locale
npm run dev                       # avvia su http://127.0.0.1:8787
```

In un altro terminale:

```bash
npm test
```

Il test fa passare per login, OAuth e tutti gli strumenti MCP. Deve finire con `70 ok, 0 falliti`. Crea task di prova e si aspetta un database locale vuoto: per ripeterlo ferma il server, cancella la cartella `.wrangler/state`, rilancia `npm run db:locale` e riavvia `npm run dev`. Rifiuta di girare su qualsiasi indirizzo che non sia locale, quindi non può toccare la tua installazione vera.

### 3. Collega il tuo account Cloudflare

```bash
npx wrangler login
```

Si apre il browser: accedi e clicca **Allow**.

### 4. Crea database e archivio

```bash
npx wrangler d1 create task-manager --location weur
npx wrangler kv namespace create OAUTH_KV
```

`--location weur` sceglie l'Europa occidentale; usa `enam` o `wnam` se sei in Nord America.

Se Wrangler chiede *"Would you like Wrangler to add it on your behalf?"* rispondi **No**. Ognuno dei due comandi stampa un identificativo: copiali in [`wrangler.jsonc`](wrangler.jsonc), al posto degli zeri (`database_id` e `id`).

### 5. Crea le tabelle

```bash
npm run db:remoto
```

### 6. Imposta i segreti

I segreti li scrivi **tu**, nel terminale: non vanno mai in un file, in una chat o in un messaggio.

```bash
npx wrangler secret put APP_PASSWORD
```

Scegli una **frase di più parole**, non una parola breve. Quando scrivi non compare nulla: è normale. È la password che userai per collegare Claude e per entrare nella web app.

```bash
npx wrangler secret put SESSION_SECRET
```

Qui incolla una stringa casuale lunga. Un modo per generarla:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copia l'output e incollalo quando Wrangler lo chiede.

### 7. Pubblica

```bash
npm run deploy
```

La prima volta Wrangler registra un sottodominio workers.dev per il tuo account, spesso scegliendolo da solo a partire dal nome o dall'email dell'account. Controlla l'indirizzo che stampa alla fine: è pubblico e potrebbe contenere il tuo nome. Se non ti piace puoi cambiarlo dal pannello Cloudflare (Workers & Pages → Change accanto a "Your subdomain*"). Meglio farlo prima di collegare Claude, perché dopo il connettore va ricreato con il nuovo indirizzo. Ecco l'indirizzo del tuo servizio:

```
https://task-manager.<il-tuo-nome>.workers.dev
```

Aprilo nel browser: dovresti vedere la pagina di accesso.

### 8. Collega Claude

Da [claude.ai](https://claude.ai), sul computer:

1. **Customize → Connectors → + → Add custom connector**
2. Nome: `Task Manager`
3. URL: il tuo indirizzo seguito da `/mcp`, cioè `https://task-manager.<il-tuo-nome>.workers.dev/mcp`
4. **Add**, poi **Connect**: si apre una pagina con la password che hai impostato al passo 6.

La pagina mostra chi chiede l'accesso e a quale indirizzo verrà consegnato il permesso. Controlla che sia Claude.

Da quel momento il connettore funziona anche dall'app di Claude sul telefono. Alla prima richiesta Claude chiede il permesso di usare gli strumenti: puoi scegliere di consentirli sempre.

### 9. Aggiungi la web app alla Home

Sul telefono apri l'indirizzo del servizio (senza `/mcp`), entra con la password, poi:

- **iPhone (Safari):** Condividi → *Aggiungi alla schermata Home*
- **Android (Chrome):** menu ⋮ → *Aggiungi a schermata Home* / *Installa app*

---

## Come si usa

Dopo aver collegato il connettore, in una chat con Claude prova:

- "Oggi devo mandare le planimetrie al fornitore e domani comprare i fiori"
- "Cosa ho da fare oggi?"
- "Come sono messo questa settimana?"
- "Sposta a domani quello che non ho chiuso"
- "Smista l'inbox" (assegna area, progetto e data ai task aggiunti dalla web app)
- "Facciamo la revisione settimanale"

### Gli strumenti che Claude può usare

| Strumento | A cosa serve |
|---|---|
| `get_overview` | Conteggi: inbox, in ritardo, oggi, prossimi 7 giorni |
| `list_tasks` | Elenco e ricerca, con filtri (vista, area, progetto, date, testo) |
| `create_tasks` | Crea uno o più task in una chiamata |
| `update_task` | Modifica uno o più task (anche in blocco) |
| `complete_task` | Chiude o riapre |
| `delete_task` | Sposta nel cestino (recuperabile per 30 giorni) |
| `list_projects` | Progetti con numero di task aperti |
| `weekly_review` | Arretrati, task fermi da 14 giorni, inbox, chiusi negli ultimi 7 giorni |

### Come si comporta

- Un task senza area finisce in **Inbox**, da smistare dopo. La web app aggiunge sempre in Inbox: non interpreta il linguaggio, quello lo fa Claude.
- Eliminare significa **cestino**, non cancellare: un cron giornaliero svuota solo quello che ci sta da più di 30 giorni.
- Gli errori tornano a Claude come testo leggibile, così si corregge da solo.

---

## Personalizzare

| Cosa | Dove |
|---|---|
| Fuso orario (decide quando "oggi" diventa "domani") | `TIMEZONE` in `wrangler.jsonc` |
| Cosa conta come "lavoro" per te | `WORK_CONTEXT` in `wrangler.jsonc` (facoltativo) |
| Le istruzioni che riceve Claude (lingua, tono, regole) | funzione `instructions()` in `src/mcp.js` |
| Aspetto della web app | `public/style.css`, `public/app.js` |
| Colore e forma dell'icona | `scripts/generate-icons.mjs`, poi `npm run icons` |

Dopo ogni modifica: `npm run deploy`. Le istruzioni per Claude sono in italiano; se le traduci, traduci anche i titoli d'esempio.

---

## Sicurezza

Cosa c'è:

- **Ogni richiesta richiede il login.** Le API rispondono 401 senza cookie o token; il connettore MCP usa OAuth 2.1 con PKCE e la tua password.
- **Limite ai tentativi di accesso:** 5 errori dallo stesso indirizzo in 15 minuti bloccano quell'indirizzo, 30 in totale bloccano tutto.
- **Confronto delle password a tempo costante** e cookie firmato (HMAC), `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Le richieste che modificano dati** devono arrivare dallo stesso sito e in JSON, contro le richieste inviate da altre pagine.
- **La pagina di autorizzazione** mostra il nome del client e dove verrà mandato il permesso, con testi escapati e header di sicurezza (CSP, niente iframe).
- **Nessun segreto nel codice:** stanno nei secrets di Cloudflare.

Cosa devi fare tu:

- Scegli una **password lunga** (una frase). È l'unica difesa dell'installazione.
- **Non pubblicare `.dev.vars`** e non incollare mai password o token in chat.
- Il permesso dato a Claude dura **180 giorni**. Per chiuderlo prima: rimuovi il connettore da claude.ai. Per invalidare tutti i permessi svuota il namespace `OAUTH_KV` dal pannello Cloudflare; per chiudere le sessioni della web app cambia `SESSION_SECRET`.
- L'indirizzo del servizio è pubblico: non è segreto, ma non c'è motivo di diffonderlo.

Se trovi un problema di sicurezza, apri una segnalazione senza pubblicare dettagli sfruttabili.

---

## Limiti noti

- **Nessun riepilogo automatico.** I task programmati di Claude oggi non riescono ad agganciare in modo affidabile un connettore personalizzato ([segnalazione](https://github.com/anthropics/claude-code/issues/63233)). Il riepilogo lo chiedi tu a Claude.
- **Nessun task ricorrente**, nessun promemoria a orario, nessuna notifica.
- **La web app non capisce il linguaggio:** aggiunge il titolo in Inbox.
- **Un solo utente.** Non è pensato per essere condiviso.

---

## Costruirlo con Claude Code

Se preferisci farti guidare, apri questa cartella con Claude Code e scrivi:

> Leggi il README e guidami nell'installazione sul mio account Cloudflare, un passo alla volta. Non chiedermi mai di incollare password o token: li inserisco io nel terminale.

Per adattarlo a te (altra lingua, altre aree oltre a lavoro/privato) leggi prima `CLAUDE.md`: spiega le regole del progetto.

---

## Struttura

```
src/index.js       ingresso: OAuth davanti a /mcp, il resto all'app
src/mcp.js         server MCP: strumenti e istruzioni per il modello
src/api.js         API REST per la web app e per gli script
src/store.js       l'unico file che scrive SQL
src/dates.js       l'unica risposta a "che giorno e' oggi"
src/auth.js        password, sessione, limite tentativi
src/authorize.js   pagina della password del flusso OAuth
public/            web app (HTML, CSS, JS senza build) e icone
migrations/        schema del database
scripts/           test di verifica e generatore di icone
```

## Licenza

[MIT](LICENSE). Fanne quello che vuoi, senza garanzie.
