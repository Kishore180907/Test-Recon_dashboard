/* GET /api/brand-trend?brand=<name>[&end=YYYY-MM-DD][&refresh=1]
 * -----------------------------------------------------------------------
 * Thirteen weeks of one brand, for the chart that opens when a row in the
 * sell-through table is clicked.
 *
 * Separate from /api/sellthrough rather than bundled into it: the panel lists
 * 255 brands and nobody opens more than a handful, so fetching every brand's
 * history up front would turn one slow call into five hundred. This is asked
 * for one brand at a time, when someone actually clicks.
 *
 * Cached per brand for the same reason the panel is — two ShopifyQL calls
 * against a rate-limited endpoint — and a stale answer is served in preference
 * to an error, with the age reported so the chart can say how old it is.
 *
 * The edge gate has already checked the session cookie before this runs.
 */

import { fetchBrandTrend } from '../../lib/brandtrend.js';
import { getBrandTrend, setBrandTrend } from '../../lib/repo.js';
import { todayLocal } from '../../lib/timezone.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TTL_MS = Number(process.env.TREND_TTL_MS) || 60 * 60 * 1000;

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);
  const brand = (url.searchParams.get('brand') || '').trim();
  const end = url.searchParams.get('end') || todayLocal();
  const force = url.searchParams.get('refresh') === '1';

  if (!brand) return json(400, { error: 'brand is required' });
  if (brand.length > 200) return json(400, { error: 'brand is too long' });
  if (!DATE_RE.test(end)) return json(400, { error: 'end must be YYYY-MM-DD' });

  if (!force) {
    const hit = await getBrandTrend(brand);
    if (hit?.report?.end === end && Date.now() - (hit.at || 0) < TTL_MS) {
      return json(200, { available: true, cached: true, builtAt: hit.at, ...hit.report });
    }
  }

  try {
    const report = await fetchBrandTrend(brand, end);

    /* null means the query could not be run at all — an unusable brand name or
     * ShopifyQL being unavailable. The chart says so instead of drawing zeros. */
    if (!report) return json(200, { available: false });

    const at = Date.now();
    try {
      await setBrandTrend(brand, { at, report });
    } catch (err) {
      console.log(`[brandtrend] cache write skipped: ${err.message}`);
    }

    return json(200, { available: true, cached: false, builtAt: at, ...report });
  } catch (err) {
    const hit = await getBrandTrend(brand).catch(() => null);
    if (hit?.report) {
      return json(200, {
        available: true, cached: true, stale: true, builtAt: hit.at, ...hit.report,
      });
    }
    return json(502, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/brand-trend' };
