/* GET /api/channels?start=YYYY-MM-DD&end=YYYY-MM-DD
 * -----------------------------------------------------------------------
 * Shopify Analytics' own sales_channel report, passed through untouched.
 *
 * This is NOT the three tiles. The tiles are an operational split computed
 * from order fields (who touched the sale, was it a draft, was it POS). This
 * endpoint answers a different question: what does the Shopify admin say?
 *
 * It exists because the two can never be reconciled from stored orders alone.
 * Shopify reports a "Shopify Mobile for iPhone" channel for draft orders
 * written up on a phone; the Admin API returns those same orders as ordinary
 * drafts with no trace of the device. In August that channel was $56,636 —
 * exactly the gap people kept finding between the dashboard and the admin.
 *
 * Kept out of /api/data on purpose. That endpoint reads storage only and never
 * calls Shopify, which is what guarantees it cannot time out. This one does
 * call Shopify, so it is loaded separately by the page and is allowed to fail
 * without taking the dashboard down with it.
 *
 * The edge gate has already checked the session cookie before this runs.
 */

import { fetchChannelSales } from '../../lib/shopify.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';

  // Both values are interpolated into a ShopifyQL string, so they are validated
  // rather than trusted — only a plain ISO date has any business being there.
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return json(400, { error: 'start and end must be YYYY-MM-DD' });
  }
  if (start > end) return json(400, { error: 'start must be on or before end' });

  try {
    const report = await fetchChannelSales(start, end);

    // null means ShopifyQL is unavailable on this plan, not that anything broke.
    // The page hides the row rather than showing an error.
    if (!report) return json(200, { available: false });

    return json(200, { available: true, range: { start, end }, ...report });
  } catch (err) {
    return json(502, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/channels' };
