/* GET /api/data — reads storage only. Never calls Shopify, so it can't time out.
 *
 * The reading and shaping live in lib/snapshot.js, which a shared report also
 * calls. See the header there for why those two must not each have their own
 * copy of it. */

import { getWatermark, getBackfill } from '../../lib/repo.js';
import { loadRange, rangeProblem } from '../../lib/snapshot.js';
import { metaCredentialMode } from '../../lib/meta.js';
import { todayLocal, daysAgoLocal } from '../../lib/timezone.js';
import { coverageWindow } from '../../lib/sync.js';

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);
  const start = url.searchParams.get('start') || daysAgoLocal(6);
  const end = url.searchParams.get('end') || todayLocal();
  /* Buckets are always exclusive — every order lands in exactly one of the
   * three, so they sum to the non-POS total. The old ?exclusive=false overlay
   * counted assisted orders twice and was removed with its UI toggle: a second
   * way to count contradicts the whole point of a source of truth. The
   * parameter is ignored rather than rejected so an old bookmark still works;
   * it just gets the real numbers. */

  const bad = rangeProblem(start, end);
  if (bad) return json(bad.status, bad.body);

  try {
    const [watermark, backfill] = await Promise.all([getWatermark(), getBackfill()]);

    if (!watermark && (!backfill || backfill.status !== 'done')) {
      return json(503, {
        error: 'No data yet — run the backfill once to seed storage.',
        backfill: backfill || { status: 'not-started' },
        needsBackfill: true,
      });
    }

    const payload = await loadRange(start, end, {
      generatedAt: watermark?.lastSyncISO || null,
      syncedAt: watermark?.lastSyncAt || null,
      syncBy: watermark?.by || null,
      coverage: coverageWindow(),
      backfill: backfill?.status || null,
      metaAds: {
        credentials: metaCredentialMode(),
        lastSync: watermark?.meta || null,
      },
    });

    return json(200, payload);
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/data' };
