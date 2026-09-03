/* GET /api/data — reads storage only. Never calls Shopify, so it can't time out. */

import {
  readOrders,
  readPosTotals,
  readMetaInsights,
  getWatermark,
  getBackfill,
  getOrderChannels,
} from '../../lib/repo.js';
import { buildPayload } from '../../lib/payload.js';
import { metaCredentialMode } from '../../lib/meta.js';
import { todayLocal, daysAgoLocal, STORE_TZ } from '../../lib/timezone.js';
import { COVERAGE_DAYS, coverageWindow } from '../../lib/sync.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);
  const start = url.searchParams.get('start') || daysAgoLocal(6);
  const end = url.searchParams.get('end') || todayLocal();
  const exclusive = url.searchParams.get('exclusive') !== 'false';

  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return json(400, { error: 'start and end must be YYYY-MM-DD' });
  }
  if (start > end) return json(400, { error: 'start must be on or before end' });

  const cover = coverageWindow();
  if (start < cover.start) {
    return json(400, {
      error: `Outside the ${COVERAGE_DAYS}-day coverage window (earliest ${cover.start})`,
      coverage: cover,
    });
  }

  try {
    const [orders, posTotals, metaInsights, watermark, backfill, orderChannels] =
      await Promise.all([
        readOrders(start, end),
        readPosTotals(start, end),
        readMetaInsights(start, end),
        getWatermark(),
        getBackfill(),
        // Cached at sync time, so this stays a pure storage read.
        getOrderChannels(),
      ]);

    if (!watermark && (!backfill || backfill.status !== 'done')) {
      return json(503, {
        error: 'No data yet — run the backfill once to seed storage.',
        backfill: backfill || { status: 'not-started' },
        needsBackfill: true,
      });
    }

    return json(
      200,
      buildPayload({
        orders,
        posTotals,
        metaInsights,
        orderChannels,
        start,
        end,
        exclusive,
        meta: {
          generatedAt: watermark?.lastSyncISO || null,
          syncedAt: watermark?.lastSyncAt || null,
          syncBy: watermark?.by || null,
          ordersInStore: orders.length,
          timezone: STORE_TZ,
          coverage: cover,
          backfill: backfill?.status || null,
          metaAds: {
            credentials: metaCredentialMode(),
            rowsInRange: metaInsights.length,
            lastSync: watermark?.meta || null,
          },
        },
      })
    );
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/data' };
