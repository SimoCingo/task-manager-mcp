/**
 * "Che giorno e' oggi?" ha una sola risposta: questa.
 *
 * Il server gira in UTC. Alle 00:30 di Roma per il server e' ancora ieri, e un
 * task "di oggi" finirebbe fra quelli di domani. Ogni data passa da qui.
 */

const DEFAULT_TZ = 'Europe/Rome';

export function tz(env) {
  return env?.TIMEZONE || DEFAULT_TZ;
}

/** Oggi come YYYY-MM-DD nel fuso dell'utente. */
export function today(env, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(env),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Ora locale come HH:MM. */
export function nowTime(env, now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz(env),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

/** Aggiunge giorni a una data YYYY-MM-DD, senza passare dai fusi. */
export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 0 = domenica ... 6 = sabato. */
export function weekday(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayName(isoDate) {
  return ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'][weekday(isoDate)];
}

/** Il prossimo lunedi' (mai oggi stesso). */
export function nextMonday(isoDate) {
  const wd = weekday(isoDate);
  return addDays(isoDate, ((8 - wd) % 7) || 7);
}

export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/**
 * Una data scritta come la scriverebbe un pulsante: accetta YYYY-MM-DD oppure
 * le scorciatoie "today", "tomorrow", "next_week" (il prossimo lunedi').
 * Le date in linguaggio naturale ("venerdi' prossimo") le risolve Claude,
 * non questo file. Restituisce null per "nessuna data", undefined se non valida.
 */
export function resolveDate(value, env, now = new Date()) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const t = today(env, now);
  switch (value.trim().toLowerCase()) {
    case 'today':
    case 'oggi':
      return t;
    case 'tomorrow':
    case 'domani':
      return addDays(t, 1);
    case 'next_week':
    case 'settimana':
      return nextMonday(t);
  }
  return isIsoDate(value.trim()) ? value.trim() : undefined;
}
