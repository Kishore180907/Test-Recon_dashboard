/* GET /api/journey?id=gid://shopify/Order/123
 * -----------------------------------------------------------------------
 * The one endpoint that talks to Shopify on a page request, and it does so
 * deliberately: journeys are fetched for the single order somebody just opened,
 * never for the whole window. A single-order query is small and fast, where
 * asking for sessions during the bulk sync would multiply the cost of every
 * page and grow every month shard to serve a panel most orders never have
 * opened.
 *
 * The edge gate has already checked the session cookie before this runs.
 */

import { fetchOrderJourney, ORDER_GID } from '../../lib/shopify.js';
import { buildJourney } from '../../lib/journey.js';
import { creditedTo } from '../../lib/classify.js';

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const id = new URL(req.url).searchParams.get('id') || '';

  // Validated rather than passed through: this value reaches a GraphQL query,
  // and only an order id has any business being there.
  if (!ORDER_GID.test(id)) {
    return json(400, { error: 'id must be a Shopify order id' });
  }

  try {
    const raw = await fetchOrderJourney(id);
    if (!raw) return json(404, { error: 'No such order' });

    const journey = buildJourney(raw.moments, {
      createdAt: raw.createdAt,
      netPayment: raw.netPayment,
      currency: raw.currency,
      creditedTo: creditedTo({ note: raw.note }),
    });

    return json(200, {
      id: raw.id,
      orderNumber: raw.orderNumber,
      ready: raw.ready,
      touchpoints: raw.touchpoints,
      daysToConversion: raw.daysToConversion,
      ...journey,
    });
  } catch (err) {
    return json(502, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/journey' };
