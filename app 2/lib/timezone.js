/* Convert store-local calendar dates to precise UTC instants. */

export const STORE_TZ = process.env.STORE_TIMEZONE || 'America/New_York';

/** Offset (in minutes) of `tz` from UTC at instant `date`. */
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

/** "2026-08-11" + start/end of day in the store's timezone -> UTC ISO string. */
export function localDayToUTC(dateStr, edge = 'start', tz = STORE_TZ) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const h = edge === 'end' ? 23 : 0;
  const mi = edge === 'end' ? 59 : 0;
  const s = edge === 'end' ? 59 : 0;
  const ms = edge === 'end' ? 999 : 0;

  // Guess with UTC, then correct by the offset that actually applies.
  let guess = new Date(Date.UTC(y, m - 1, d, h, mi, s, ms));
  for (let i = 0; i < 2; i += 1) {
    const off = tzOffsetMinutes(guess, tz);
    guess = new Date(Date.UTC(y, m - 1, d, h, mi, s, ms) - off * 60000);
  }
  return guess.toISOString();
}

/** The store-local calendar date (YYYY-MM-DD) an instant falls on. */
export function localDateOf(iso, tz = STORE_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Today's calendar date in the store's timezone, as YYYY-MM-DD. */
export function todayLocal(tz = STORE_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** N days before today, in the store's timezone, as YYYY-MM-DD. */
export function daysAgoLocal(n, tz = STORE_TZ) {
  const d = new Date(Date.now() - n * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
