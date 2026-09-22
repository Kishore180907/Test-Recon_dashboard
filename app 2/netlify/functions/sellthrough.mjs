/* GET /api/sellthrough?end=YYYY-MM-DD[&refresh=1]
 * -----------------------------------------------------------------------
 * Sell-through by brand, straight from Shopify's inventory dataset.
 *
 * Kept out of /api/data deliberately, for the same reason /api/channels is:
 * that endpoint reads storage only and never calls Shopify, which is what
 * guarantees it cannot time out. This one does call Shopify — five ShopifyQL
 * queries — so the page loads it separately, only when the panel is opened,
 * and it is allowed to fail without taking the dashboard down.
 *
 * CACHED, because the analytics endpoint rate-limits. Five queries per open,
 * with several people watching the same dashboard, hits 429s quickly. The
 * shaped report is written to Blobs and re-served until it ages out; `end` is
 * part of the cache key so asking for a different day still refetches, and
 * ?refresh=1 forces a rebuild. Inventory does not move fast enough for an hour
 * of staleness to change a decision, and the response says how old it is so
 * the panel can show that rather than implying it is live.
 *
 * The edge gate has already checked the session cookie before this runs.
 */

import { fetchBrandSellThrough } from '../../lib/sellthrough.js';
import { getSellThrough, setSellThrough } from '../../lib/repo.js';
import { todayLocal } from '../../lib/timezone.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TTL_MS = Number(process.env.SELLTHROUGH_TTL_MS) || 60 * 60 * 1000;

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);
  const end = url.searchParams.get('end') || todayLocal();
  const force = url.searchParams.get('refresh') === '1';

  // Interpolated into a ShopifyQL string, so it is validated rather than
  // trusted — only a plain ISO date has any business being there.
  if (!DATE_RE.test(end)) {
    return json(400, { error: 'end must be YYYY-MM-DD' });
  }

  if (!force) {
    const hit = await getSellThrough();
    if (hit?.report?.end === end && Date.now() - (hit.at || 0) < TTL_MS) {
      return json(200, { available: true, cached: true, builtAt: hit.at, ...hit.report });
    }
  }

  try {
    const report = await fetchBrandSellThrough(end);

    /* null means ShopifyQL is unavailable on this plan, not that anything
     * broke. The page hides the panel rather than showing an error. */
    if (!report) return json(200, { available: false });

    const at = Date.now();
    // A cache write must never cost the caller their answer.
    try {
      await setSellThrough({ at, report });
    } catch (err) {
      console.log(`[sellthrough] cache write skipped: ${err.message}`);
    }

    return json(200, { available: true, cached: false, builtAt: at, ...report });
  } catch (err) {
    /* Rate limited or otherwise unreachable. If there is anything cached at
     * all, stale beats nothing — the panel says how old it is. */
    const hit = await getSellThrough().catch(() => null);
    if (hit?.report) {
      return json(200, {
        available: true, cached: true, stale: true, builtAt: hit.at, ...hit.report,
      });
    }
    return json(502, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/sellthrough' };
