/**
 * Il Worker: un solo indirizzo, tre porte.
 *
 *   /mcp            server MCP per Claude e ChatGPT. Protetto da OAuth:
 *                   OAuthProvider verifica il token PRIMA di passare la
 *                   richiesta a mcpApiHandler.
 *   /authorize      la pagina con la password che si apre quando colleghi
 *                   il connettore. /oauth/token e /oauth/register e i
 *                   metadati /.well-known/* li gestisce OAuthProvider.
 *   /api/*          API REST: cookie della web app o Bearer API_TOKEN,
 *                   controllato dentro handleApi su ogni rotta.
 *   /              la pagina della web app (public/index.html). Passa da
 *                   qui e non dal servizio statico automatico solo per
 *                   aggiungere gli header di sicurezza: vedi wrangler.jsonc
 *                   `assets.run_worker_first`. Il resto della cartella
 *                   public/ (script, stile, icone) lo serve Cloudflare
 *                   direttamente: la pagina stessa controlla il login
 *                   chiamando /api/me, quindi non serve nasconderla.
 */

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { mcpApiHandler } from './mcp.js';
import { handleAuthorize } from './authorize.js';
import { handleApi } from './api.js';
import { purgeTrash } from './store.js';

const APP_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const app = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/authorize') return handleAuthorize(request, env);
    if (pathname.startsWith('/api/')) return handleApi(request, env);

    if (pathname === '/' || pathname === '/index.html') {
      // Il servizio statico normalizza /index.html -> / con un redirect: se
      // richiediamo il file esplicito ci restituisce QUEL redirect, non il
      // contenuto. Passiamo la richiesta cosi' com'e', gia' sull'URL pulito.
      const asset = await env.ASSETS.fetch(request);
      const res = new Response(asset.body, asset);
      for (const [k, v] of Object.entries(APP_SECURITY_HEADERS)) res.headers.set(k, v);
      return res;
    }
    return new Response('Non trovato', { status: 404 });
  },
};

const provider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpApiHandler,
  defaultHandler: app,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  clientIdMetadataDocumentEnabled: true,
  // La password si scrive una volta, quando colleghi il connettore. Il token
  // d'accesso dura un'ora e si rinnova da solo; il permesso intero scade dopo
  // 180 giorni (il predefinito, 30, voleva dire password una volta al mese).
  // Il client registrato deve vivere piu' a lungo del permesso, altrimenti
  // scadrebbe prima lui. Per chiudere l'accesso prima: rimuovi il connettore
  // o cambia APP_PASSWORD e svuota OAUTH_KV.
  refreshTokenTTL: 180 * 86400,
  clientRegistrationTTL: 365 * 86400,
});

export default {
  fetch(request, env, ctx) {
    return provider.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeTrash(env));
  },
};
