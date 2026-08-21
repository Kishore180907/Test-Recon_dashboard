/* POST /api/sync-now — the dashboard's "Refresh now" button.
 * Same incremental sync as the cron, on demand. Guarded by the same lock, so a
 * click landing on top of a cron tick is a no-op rather than a double pull. */

import { runSync } from '../../lib/sync.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const result = await runSync({ by: 'manual', maxPages: 10 });
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 409,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = { path: '/api/sync-now' };
