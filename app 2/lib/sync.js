/* =============================================================================
 *  Incremental sync — the only thing that talks to Shopify on a schedule.
 *  Runs from the cron function and from the dashboard's "Refresh now" button.
 * ========================================================================== */

import { fetchOrdersInRange, fetchOrderChannels } from './shopify.js';
import { fetchCampaignInsights, metaConfigured, metaCredentialMode } from './meta.js';
import { localDayToUTC, todayLocal, daysAgoLocal } from './timezone.js';
import {
  upsertOrders,
  upsertMetaInsights,
  pruneBefore,
  getWatermark,
  setWatermark,
  setOrderChannels,
  getBackfill,
  acquireLock,
  releaseLock,
} from './repo.js';

/** How far back the dashboard can look. Backfill seeds it; sync keeps it fresh. */
export const COVERAGE_DAYS = Number(process.env.COVERAGE_DAYS) || 90;

/** Re-fetch slightly before the last sync so nothing slips through the gap. */
const OVERLAP_MS = 5 * 60 * 1000;

/**
 * How far back to re-pull Meta on a routine tick.
 *
 * Meta keeps revising a day's numbers for roughly three days after it closes as
 * attribution settles, so re-reading only "today" would leave the dashboard
 * showing figures Ads Manager has since corrected. A week of trailing days
 * covers that with room to spare and is still one small request.
 */
const META_REFRESH_DAYS = Number(process.env.META_REFRESH_DAYS) || 7;

export function coverageWindow() {
  return { start: daysAgoLocal(COVERAGE_DAYS - 1), end: todayLocal() };
}

/**
 * Refresh Meta campaign insights.
 *
 * Deliberately never throws. Meta is supplementary evidence — if the token has
 * lapsed or the Graph API is having a bad afternoon, the order dashboard must
 * still render. The failure is recorded in the watermark so /api/status can say
 * so out loud rather than leaving stale ad numbers looking current.
 */
export async function syncMetaAds({ coverage, seeded = false } = {}) {
  // MOCK_DATA serves the bundled fixture, which needs no credentials — that is
  // what lets `npm run smoke` and the local dev server exercise the whole join.
  if (!metaConfigured() && process.env.MOCK_DATA !== '1') {
    return { ok: false, reason: metaCredentialMode() === 'partial' ? 'partial-credentials' : 'not-configured' };
  }

  // First run seeds the whole coverage window; after that only the tail moves.
  const since = seeded ? daysAgoLocal(META_REFRESH_DAYS - 1) : coverage.start;
  const until = coverage.end;

  try {
    const rows = await fetchCampaignInsights({ since, until });
    const { months } = await upsertMetaInsights(rows);
    return {
      ok: true,
      since,
      until,
      rows: rows.length,
      campaigns: new Set(rows.map((r) => r.campaignKey)).size,
      months,
      seededAt: seeded ? undefined : new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, reason: 'error', error: String(err.message || err), since, until };
  }
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

    const meta = await syncMetaAds({
      coverage: { start, end },
      seeded: Boolean(wm?.meta?.seededAt),
    });
    // Carry the seed stamp forward: it marks that the full window has been
    // pulled once, which is what lets later ticks fetch only the tail.
    if (meta.ok && !meta.seededAt) meta.seededAt = wm?.meta?.seededAt;

    /* Refresh the order -> sales channel map for the whole window.
     *
     * This is what lets the Ecommerce tile include mobile-app drafts: the Admin
     * API reports them as ordinary drafts, and only Shopify Analytics knows the
     * device. Cached here so /api/data can stay a pure storage read.
     *
     * A failure is not fatal — the map simply keeps its previous value and the
     * dashboard falls back to Admin-API bucketing. */
    let channels = null;
    try {
      const map = await fetchOrderChannels(start, end);
      if (map.size) {
        channels = { count: map.size, at: Date.now() };
        await setOrderChannels(Object.fromEntries(map));
      }
    } catch (err) {
      console.log(`[sync] channel map skipped: ${err.message}`);
    }

    const dropped = await pruneBefore(start);

    const watermark = {
      channels,
      lastSyncAt: Date.now(),
      lastSyncISO: new Date().toISOString(),
      by,
      fetched: fetched.length,
      nonPos,
      pos,
      months,
      meta,
      coverage: { start, end, days: COVERAGE_DAYS },
      durationMs: Date.now() - startedAt,
    };
    await setWatermark(watermark);

    return { ok: true, ...watermark, dropped };
  } finally {
    await releaseLock();
  }
}
