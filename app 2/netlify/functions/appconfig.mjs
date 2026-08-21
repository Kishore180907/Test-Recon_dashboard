/* GET /api/config — what the dashboard needs before its first data call. */

import { STORE_TZ, todayLocal, daysAgoLocal } from '../../lib/timezone.js';
import { ASSISTED_RULE } from '../../lib/classify.js';
import { COVERAGE_DAYS, coverageWindow } from '../../lib/sync.js';
import { getWatermark, getBackfill } from '../../lib/repo.js';

export default async () => {
  const [watermark, backfill] = await Promise.all([getWatermark(), getBackfill()]);

  return new Response(
    JSON.stringify({
      timezone: STORE_TZ,
      shop: process.env.SHOPIFY_SHOP || null,
      defaults: { start: daysAgoLocal(6), end: todayLocal() },
      coverage: { ...coverageWindow(), days: COVERAGE_DAYS },
      syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES) || 15,
      assistedRule: {
        mode: ASSISTED_RULE.mode,
        signals: Object.fromEntries(
          Object.entries(ASSISTED_RULE.signals).map(([k, v]) => [k, v.enabled])
        ),
      },
      lastSync: watermark
        ? { at: watermark.lastSyncISO, by: watermark.by, fetched: watermark.fetched }
        : null,
      backfill: backfill || { status: 'not-started' },
    }),
    { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  );
};

export const config = { path: '/api/config' };
