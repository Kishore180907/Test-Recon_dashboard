/* Cron sync. Runs every SYNC_INTERVAL_MINUTES (default 15).
 * Scheduled functions get 30s — an incremental delta is a handful of orders,
 * so maxPages is capped to keep a bad day from running long. */

import { runSync } from '../../lib/sync.js';

export default async () => {
  const result = await runSync({ by: 'cron', maxPages: 20 });
  console.log('[scheduled-sync]', JSON.stringify(result));
  return new Response(JSON.stringify(result), {
    headers: { 'content-type': 'application/json' },
  });
};

/*
 * The cron MUST be a plain string literal.
 *
 * This read `process.env.SYNC_CRON` with a cron string as a fallback, which
 * looks harmless and is not: Netlify registers a schedule by parsing this file
 * at build time rather than running it, so an expression is not a cron it can
 * recognise. (The cron literal itself is kept out of this comment on purpose —
 * it contains the two characters that close a block comment, which broke a
 * build once already.) The
 * function deployed, reported healthy, and was never put on a schedule — no
 * invocations, no log lines, and a dashboard whose data only moved when someone
 * pressed Refresh now. Declaring the schedule in netlify.toml did not fix it
 * either; only a literal here does.
 *
 * To change the interval, edit this string and SYNC_INTERVAL_MINUTES, which is
 * the label the header shows. There is no environment variable for it, on
 * purpose — that is the trap that caused this.
 */
export const config = {
  schedule: '*/15 * * * *',
};
