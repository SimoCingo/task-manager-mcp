/**
 * La pagina che si apre quando colleghi il connettore in Claude o ChatGPT.
 *
 * Mostra CHI sta chiedendo l'accesso e DOVE finira' il permesso: la
 * registrazione dei client e' aperta a chiunque, quindi l'unica difesa contro
 * un client finto e' che tu legga il nome e l'indirizzo prima di scrivere la
 * password. Tutto quello che arriva dal client passa da escapeHtml.
 */

import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { checkPassword } from './auth.js';

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function page({ clientName, redirectHost, query, error }) {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Collega Task Manager</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f5f2; --card:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e4e1da; --accent:#2f5d50; --err:#a3302a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --card:#1e1d1b; --ink:#eeebe4; --muted:#a19d95; --line:#33312d; --accent:#7fb5a3; --err:#e0847d; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--ink);
         font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  form { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .who { color:var(--muted); font-size:14px; margin:0 0 18px; }
  .who b { color:var(--ink); }
  label { display:block; font-size:14px; margin-bottom:6px; }
  input { width:100%; font:inherit; padding:12px; border-radius:10px; border:1px solid var(--line); background:transparent; color:inherit; }
  button { width:100%; margin-top:14px; font:inherit; font-weight:600; padding:12px; border:0; border-radius:10px; background:var(--accent); color:#fff; }
  @media (prefers-color-scheme: dark) { button { color:#10201b; } }
  .err { color:var(--err); font-size:14px; margin:0 0 12px; }
</style>
</head>
<body>
<form method="POST" action="/authorize?${escapeHtml(query)}">
  <h1>Collega Task Manager</h1>
  <p class="who"><b>${escapeHtml(clientName)}</b> chiede di leggere e modificare i tuoi task.<br>
  Il permesso verra' consegnato a <b>${escapeHtml(redirectHost)}</b>.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Consenti l'accesso</button>
</form>
</body>
</html>`;
}

export async function handleAuthorize(request, env) {
  let oauthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    // Senza un redirect gia' verificato l'errore si mostra qui, mai altrove.
    if (!error.redirectUri) {
      return new Response(`Richiesta di autorizzazione non valida: ${error.description}`, { status: 400 });
    }
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set('error', error.code);
    redirect.searchParams.set('error_description', error.description);
    if (error.state) redirect.searchParams.set('state', error.state);
    if (error.issuer) redirect.searchParams.set('iss', error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return new Response('Client OAuth sconosciuto', { status: 400 });

  const url = new URL(request.url);
  let redirectHost = '?';
  try { redirectHost = new URL(oauthRequest.redirectUri).host; } catch {}
  const view = {
    clientName: client.clientName || client.clientId,
    redirectHost,
    query: url.searchParams.toString(),
  };

  if (request.method === 'GET') {
    return new Response(page(view), { headers: SECURITY_HEADERS });
  }
  if (request.method !== 'POST') {
    return new Response('Metodo non consentito', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  const form = await request.formData();
  const result = await checkPassword(env, request, String(form.get('password') || ''));
  if (!result.ok) {
    const error = result.blocked
      ? 'Troppi tentativi sbagliati. Riprova fra 15 minuti.'
      : 'Password sbagliata.';
    return new Response(page({ ...view, error }), { status: result.blocked ? 429 : 401, headers: SECURITY_HEADERS });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: 'owner',
    metadata: { clientName: client.clientName ?? null },
    scope: oauthRequest.scope,
    props: { userId: 'owner' },
  });
  return Response.redirect(redirectTo, 302);
}
