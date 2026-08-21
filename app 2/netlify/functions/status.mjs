/* GET /api/status — sync + backfill health, for the header and the setup step. */

import { getWatermark, getBackfill } from '../../lib/repo.js';
import { coverageWindow, COVERAGE_DAYS } from '../../lib/sync.js';

export default async () => {
  const [watermark, backfill] = await Promise.all([getWatermark(), getBackfill()]);
  const body = {
    coverage: { ...coverageWindow(), days: COVERAGE_DAYS },
    syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES) || 15,
    lastSync: watermark || null,
    ageSeconds: watermark?.lastSyncAt
      ? Math.round((Date.now() - watermark.lastSyncAt) / 1000)
      : null,
    backfill: backfill || { status: 'not-started' },
    ready: Boolean(watermark) || backfill?.status === 'done',
  };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/status' };
