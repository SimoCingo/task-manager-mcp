/**
 * Il cancello.
 *
 * Una persona sola, una password sola (APP_PASSWORD). Serve in due punti:
 * - la pagina /authorize, quando Claude o ChatGPT collegano il connettore;
 * - il login della web app, che lascia un cookie firmato.
 *
 * Gli script possono usare invece Authorization: Bearer API_TOKEN.
 */

import { countEvents, logEvent } from './store.js';

export const SESSION_COOKIE = '__Host-tm_session';
const SESSION_DAYS = 60;

// Cinque errori dallo stesso indirizzo in un quarto d'ora e si aspetta.
// Trenta in tutto e si ferma tutto: protegge anche da chi cambia indirizzo.
const WINDOW_MIN = 15;
const MAX_PER_IP = 5;
const MAX_TOTAL = 30;

const enc = new TextEncoder();

function secret(env) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET non impostato');
  return env.SESSION_SECRET;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Confronto a tempo costante. Si confrontano gli HMAC, che hanno sempre la
 * stessa lunghezza: la lunghezza della password non trapela.
 */
export async function safeEqual(env, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([hmac(env, a), hmac(env, b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
}

/**
 * Verifica la password con il limite sui tentativi.
 * Restituisce { ok } oppure { ok: false, blocked, retryAfter }.
 */
export async function checkPassword(env, request, password) {
  const ip = clientIp(request);
  const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
  const [fromIp, total] = await Promise.all([
    countEvents(env, 'auth.failed', since, { ip }),
    countEvents(env, 'auth.failed', since),
  ]);
  if (fromIp >= MAX_PER_IP || total >= MAX_TOTAL) {
    return { ok: false, blocked: true, retryAfter: WINDOW_MIN * 60 };
  }

  if (!env.APP_PASSWORD) throw new Error('APP_PASSWORD non impostata');
  const ok = await safeEqual(env, password ?? '', env.APP_PASSWORD);
  await logEvent(env, ok ? 'auth.ok' : 'auth.failed', { ip });
  return { ok, blocked: false };
}

// ---------------------------------------------------------------- sessione web

export async function createSession(env) {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const salt = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${expires}.${salt}`;
  return `${payload}.${b64url(await hmac(env, payload))}`;
}

export async function validSession(env, value) {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [expires, salt, sig] = parts;
  const expected = b64url(await hmac(env, `${expires}.${salt}`));
  if (!(await safeEqual(env, sig, expected))) return false;
  return Number(expires) > Date.now();
}

export function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** La richiesta viene da te? Cookie della web app oppure token per gli script. */
export async function isAuthenticated(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && env.API_TOKEN) {
    return safeEqual(env, auth.slice(7), env.API_TOKEN);
  }
  return validSession(env, readCookie(request, SESSION_COOKIE));
}
