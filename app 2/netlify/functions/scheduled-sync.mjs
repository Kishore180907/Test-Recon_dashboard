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

export const config = {
  schedule: process.env.SYNC_CRON || '*/15 * * * *',
};
