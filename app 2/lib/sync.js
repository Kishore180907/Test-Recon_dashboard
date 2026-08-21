/* =============================================================================
 *  Incremental sync — the only thing that talks to Shopify on a schedule.
 *  Runs from the cron function and from the dashboard's "Refresh now" button.
 * ========================================================================== */

import { fetchOrdersInRange } from './shopify.js';
import { localDayToUTC, todayLocal, daysAgoLocal } from './timezone.js';
import {
  upsertOrders,
  pruneBefore,
  getWatermark,
  setWatermark,
  getBackfill,
  acquireLock,
  releaseLock,
} from './repo.js';

/** How far back the dashboard can look. Backfill seeds it; sync keeps it fresh. */
export const COVERAGE_DAYS = Number(process.env.COVERAGE_DAYS) || 90;

/** Re-fetch slightly before the last sync so nothing slips through the gap. */
const OVERLAP_MS = 5 * 60 * 1000;

export function coverageWindow() {
  return { start: daysAgoLocal(COVERAGE_DAYS - 1), end: todayLocal() };
}

/**
 * Pull everything that changed since the watermark and merge it into storage.
 * Cheap by design: on a normal 15-minute tick this is a handful of orders.
 */
export async function runSync({ by = 'cron', maxPages = 40 } = {}) {
  const backfill = await getBackfill();
  const wm = await getWatermark();

  if (!wm && (!backfill || backfill.status !== 'done')) {
    return { ok: false, reason: 'needs-backfill', backfill: backfill || null };
  }

  if (!(await acquireLock(by))) {
    return { ok: false, reason: 'locked' };
  }

  const startedAt = Date.now();
  try {
    const { start, end } = coverageWindow();
    const since = wm?.lastSyncAt
      ? new Date(wm.lastSyncAt - OVERLAP_MS).toISOString()
      : undefined;

    const fetched = await fetchOrdersInRange({
      startISO: localDayToUTC(start, 'start'),
      endISO: localDayToUTC(end, 'end'),
      updatedSinceISO: since,
      maxPages,
    });

    const { months, nonPos, pos } = await upsertOrders(fetched);
    const dropped = await pruneBefore(start);

    const watermark = {
      lastSyncAt: Date.now(),
      lastSyncISO: new Date().toISOString(),
      by,
      fetched: fetched.length,
      nonPos,
      pos,
      months,
      coverage: { start, end, days: COVERAGE_DAYS },
      durationMs: Date.now() - startedAt,
    };
    await setWatermark(watermark);

    return { ok: true, ...watermark, dropped };
  } finally {
    await releaseLock();
  }
}
