/* =============================================================================
 *  ONE RANGE, READ FROM STORAGE AND SHAPED
 *  ---------------------------------------------------------------------------
 *  /api/data and a shared report must not compute their figures separately.
 *
 *  A report exists so a stakeholder sees the finding the person who sent it was
 *  looking at. The moment the two paths each do their own reading and shaping,
 *  they are free to drift — a bucket rule applied in one and not the other, a
 *  POS order counted on one side only — and the report quietly stops being
 *  evidence of anything. So both call loadRange(), and buildPayload() is still
 *  the only place a bucket is decided.
 *
 *  Storage reads live here; payload.js stays pure.
 * ========================================================================== */

import {
  readOrders,
  readPosTotals,
  readMetaInsights,
  getOrderChannels,
} from './repo.js';
import { buildPayload } from './payload.js';
import { isPOS } from './classify.js';
import { STORE_TZ } from './timezone.js';
import { COVERAGE_DAYS, coverageWindow } from './sync.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reject a range before any storage is touched.
 *
 * Returns null when the range is usable, or `{ status, body }` ready to send.
 * Shared so a report cannot be created for a window /api/data would refuse —
 * which would otherwise produce a frozen report of a range the live view
 * answers 400 for, and an "Open live view" link that lands on an error.
 */
export function rangeProblem(start, end) {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return { status: 400, body: { error: 'start and end must be YYYY-MM-DD' } };
  }
  if (start > end) {
    return { status: 400, body: { error: 'start must be on or before end' } };
  }
  const cover = coverageWindow();
  if (start < cover.start) {
    return {
      status: 400,
      body: {
        error: `Outside the ${COVERAGE_DAYS}-day coverage window (earliest ${cover.start})`,
        coverage: cover,
      },
    };
  }
  return null;
}

/**
 * Read one range out of storage and shape it the way the dashboard renders it.
 *
 * Pure storage — never calls Shopify, so it cannot time out on someone else's
 * API. `meta` is merged onto the result; the caller owns the fields that
 * describe the request rather than the data (sync age, coverage, backfill).
 */
export async function loadRange(start, end, meta = {}) {
  const [orders, posTotals, metaInsights, orderChannels] = await Promise.all([
    readOrders(start, end),
    readPosTotals(start, end),
    readMetaInsights(start, end),
    // Cached at sync time, so this stays a pure storage read.
    getOrderChannels(),
  ]);

  return buildPayload({
    orders,
    posTotals,
    metaInsights,
    orderChannels,
    start,
    end,
    exclusive: true,
    meta: {
      /* Rows the three tiles will actually show. A POS order can be in storage
       * without being in a tile — it is promoted into one only while the
       * online-to-store rule is on, and the stored copy outlives the rule being
       * switched off. Counting the raw shard would make "Orders in view"
       * disagree with the tiles beside it. */
      ordersInStore: orders.filter((o) => !isPOS(o)).length,
      timezone: STORE_TZ,
      ...meta,
      /* This function is the only one that saw the raw Meta day rows — the
       * payload keeps them rolled up per campaign — so the row count is
       * contributed here and the caller fills in the rest of the block. */
      metaAds: { rowsInRange: metaInsights.length, ...(meta.metaAds || {}) },
    },
  });
}
