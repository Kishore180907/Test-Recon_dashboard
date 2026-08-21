/* =============================================================================
 *  Turn stored orders into the JSON the dashboard renders.
 *  Pure functions — no network, no storage. This is what makes the read path
 *  fast enough to never brush a function timeout.
 * ========================================================================== */

import { annotate } from './classify.js';
import { localDateOf } from './timezone.js';

function emptyBucket() {
  return { revenue: 0, orderCount: 0, refunded: 0, orders: [] };
}

export function buildPayload({
  orders,
  posTotals,
  start,
  end,
  exclusive = true,
  meta = {},
}) {
  const buckets = {
    online: emptyBucket(),
    assisted: emptyBucket(),
    draft: emptyBucket(),
  };

  const all = [];
  for (const raw of orders) {
    if (raw.test) continue;
    const o = annotate(raw, { exclusive });
    if (o.bucket === 'pos') continue; // POS never reaches storage, but be safe
    all.push(o);
    const b = buckets[o.bucket];
    if (!b) continue;
    b.revenue += o.netPayment;
    b.refunded += o.refunded;
    b.orderCount += 1;
    b.orders.push(slim(o));
  }

  // Overlay view: assisted re-lists orders that also live in online/draft.
  if (!exclusive) {
    const a = emptyBucket();
    for (const o of all) {
      if (!o.isAssisted) continue;
      a.revenue += o.netPayment;
      a.refunded += o.refunded;
      a.orderCount += 1;
      a.orders.push(slim(o));
    }
    buckets.assisted = a;
  }

  for (const b of Object.values(buckets)) {
    b.orders.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
    b.avgOrderValue = b.orderCount ? b.revenue / b.orderCount : 0;
  }

  const nonPosRevenue =
    buckets.online.revenue + buckets.assisted.revenue + buckets.draft.revenue;
  const nonPosOrders =
    buckets.online.orderCount + buckets.assisted.orderCount + buckets.draft.orderCount;

  return {
    range: { start, end },
    exclusive,
    ...meta,
    totals: {
      nonPosRevenue,
      nonPosOrders,
      posRevenue: posTotals.revenue,
      posOrders: posTotals.orders,
      allRevenue: nonPosRevenue + posTotals.revenue,
    },
    buckets: { ...buckets, pos: { ...emptyBucket(), ...posTotals, orderCount: posTotals.orders } },
    daily: dailySeries(all),
    sources: sourceBreakdown(all),
  };
}

function slim(o) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    adminUrl: o.adminUrl,
    createdAt: o.createdAt,
    customerName: o.customerName,
    netSale: o.netPayment,
    totalPrice: o.totalPrice,
    refunded: o.refunded,
    currency: o.currency,
    financialStatus: o.financialStatus,
    cancelled: Boolean(o.cancelledAt),
    channelName: o.channelName || o.appName || o.sourceName,
    isAssisted: o.isAssisted,
    isDraft: o.isDraft,
    creditedTo: o.creditedTo,
    touchpoints: o.touchpoints,
    daysToConversion: o.daysToConversion,
    firstClick: o.firstVisit
      ? {
          source: o.firstClickSource,
          detail: o.firstVisit.sourceDescription,
          campaign: o.firstVisit.utmCampaign,
          landingPage: o.firstVisit.landingPage,
          referrerUrl: o.firstVisit.referrerUrl,
          occurredAt: o.firstVisit.occurredAt,
        }
      : null,
    lastClick: o.lastVisit
      ? {
          source: o.lastClickSource,
          detail: o.lastVisit.sourceDescription,
          campaign: o.lastVisit.utmCampaign,
          landingPage: o.lastVisit.landingPage,
          referrerUrl: o.lastVisit.referrerUrl,
          occurredAt: o.lastVisit.occurredAt,
        }
      : null,
    trafficSource: o.lastClickSource,
  };
}

function dailySeries(all) {
  const byDay = new Map();
  for (const o of all) {
    const day = localDateOf(o.createdAt);
    if (!byDay.has(day)) byDay.set(day, { day, online: 0, assisted: 0, draft: 0 });
    byDay.get(day)[o.bucket] += o.netPayment;
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function sourceBreakdown(all) {
  const m = new Map();
  for (const o of all) {
    const k = o.lastClickSource || 'Unknown';
    if (!m.has(k)) m.set(k, { source: k, revenue: 0, orders: 0 });
    const row = m.get(k);
    row.revenue += o.netPayment;
    row.orders += 1;
  }
  return [...m.values()].sort((a, b) => b.revenue - a.revenue);
}
