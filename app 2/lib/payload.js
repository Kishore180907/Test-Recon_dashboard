/* =============================================================================
 *  Turn stored orders into the JSON the dashboard renders.
 *  Pure functions — no network, no storage. This is what makes the read path
 *  fast enough to never brush a function timeout.
 * ========================================================================== */

import { annotate, deviceLabel } from './classify.js';
import { campaignKey } from './meta.js';
import { localDateOf } from './timezone.js';

function emptyBucket() {
  return { revenue: 0, orderCount: 0, refunded: 0, orders: [] };
}

export function buildPayload({
  orders,
  posTotals,
  metaInsights = [],
  start,
  end,
  exclusive = true,
  // Order name -> Shopify's own sales channel, from Shopify Analytics. The
  // Admin API cannot distinguish a draft written in the mobile app from one
  // written at a desk, so this is what puts mobile-app orders in Ecommerce
  // rather than Draft. Empty is safe: orders keep their Admin-API bucket.
  orderChannels = null,
  meta = {},
}) {
  const buckets = {
    online: emptyBucket(),
    assisted: emptyBucket(),
    draft: emptyBucket(),
  };

  // Campaigns Meta actually billed for in this window. Built before the order
  // loop so every order can be stamped with whether its campaign is one of them.
  const adSpendByKey = rollUpMeta(metaInsights);

  // Accepts a Map or a plain object, so callers can pass either the lib's Map
  // or the JSON the endpoint sends.
  const channelOf = (name) => {
    if (!orderChannels || !name) return '';
    return (orderChannels instanceof Map
      ? orderChannels.get(name)
      : orderChannels[name]) || '';
  };

  const all = [];
  for (const raw of orders) {
    if (raw.test) continue;
    // Stamped before annotate() so bucketOf() can see it.
    const withChannel = { ...raw, salesChannel: channelOf(raw.orderNumber) };
    const o = annotate(withChannel, { exclusive });
    if (o.bucket === 'pos') continue; // POS never reaches storage, but be safe
    all.push(o);
    const b = buckets[o.bucket];
    if (!b) continue;
    b.revenue += o.netPayment;
    b.refunded += o.refunded;
    b.orderCount += 1;
    b.orders.push(slim(o, adSpendByKey));
  }

  // Overlay view: assisted re-lists orders that also live in online/draft.
  if (!exclusive) {
    const a = emptyBucket();
    for (const o of all) {
      if (!o.isAssisted) continue;
      a.revenue += o.netPayment;
      a.refunded += o.refunded;
      a.orderCount += 1;
      a.orders.push(slim(o, adSpendByKey));
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
    campaigns: campaignBreakdown(all, adSpendByKey),
    ads: adTotals(adSpendByKey),
  };
}

/* =============================================================================
 *  META ADS JOIN
 * -----------------------------------------------------------------------------
 *  Meta reports per campaign per day. Shopify reports per order, with the Meta
 *  campaign name on the customer journey. So the only sound join is campaign to
 *  campaign — see the header of lib/meta.js for why matching on purchase time
 *  is not possible, however much it sounds like it should be.
 * ========================================================================== */

/** Collapse day rows into one entry per campaign. */
function rollUpMeta(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const key = r.campaignKey || campaignKey(r.campaignName);
    if (!key) continue;
    if (!m.has(key)) {
      m.set(key, {
        key,
        campaign: r.campaignName,
        spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0,
      });
    }
    const row = m.get(key);
    row.spend += r.spend || 0;
    row.impressions += r.impressions || 0;
    row.clicks += r.clicks || 0;
    row.purchases += r.purchases || 0;
    row.purchaseValue += r.purchaseValue || 0;
  }
  return m;
}

/** The campaign an order should be credited to: last touch first, then first. */
function orderCampaign(o) {
  return o.lastVisit?.utmCampaign || o.firstVisit?.utmCampaign || null;
}

/**
 * Shopify last-click next to Meta's own claim, per campaign.
 *
 * The two columns are expected to disagree, and the disagreement is the point.
 * Meta counts view-through and cross-device conversions that never carry a utm
 * back to the storefront, so Shopify hands those to Direct. A campaign where
 * Meta reports purchases and Shopify reports none is not a broken join — it is
 * the case for treating a "Direct" order in that window as ad-influenced.
 */
function campaignBreakdown(all, adSpendByKey) {
  const m = new Map();

  const ensure = (key, name) => {
    if (!m.has(key)) {
      m.set(key, {
        key,
        campaign: name,
        shopifyOrders: 0,
        shopifyRevenue: 0,
        metaSpend: 0,
        metaClicks: 0,
        metaImpressions: 0,
        metaPurchases: 0,
        metaValue: 0,
        metaRoas: null,
        inMeta: false,
        inShopify: false,
      });
    }
    return m.get(key);
  };

  for (const o of all) {
    const name = orderCampaign(o);
    if (!name) continue;
    const row = ensure(campaignKey(name), name);
    row.inShopify = true;
    row.shopifyOrders += 1;
    row.shopifyRevenue += o.netPayment;
  }

  for (const ad of adSpendByKey.values()) {
    const row = ensure(ad.key, ad.campaign);
    // Meta's spelling wins when both sides have the campaign: it is the name the
    // ad manager will recognise, and Shopify's copy arrives URL-encoded.
    row.campaign = ad.campaign;
    row.inMeta = true;
    row.metaSpend = ad.spend;
    row.metaClicks = ad.clicks;
    row.metaImpressions = ad.impressions;
    row.metaPurchases = ad.purchases;
    row.metaValue = ad.purchaseValue;
    row.metaRoas = ad.spend > 0 ? ad.purchaseValue / ad.spend : null;
  }

  for (const row of m.values()) {
    row.matched = row.inMeta && row.inShopify;
    row.attributionGap = row.metaPurchases - row.shopifyOrders;
  }

  return [...m.values()].sort(
    (a, b) => (b.metaSpend || 0) + b.shopifyRevenue - ((a.metaSpend || 0) + a.shopifyRevenue)
  );
}

function adTotals(adSpendByKey) {
  const t = { campaigns: 0, spend: 0, purchases: 0, purchaseValue: 0, roas: null };
  for (const ad of adSpendByKey.values()) {
    t.campaigns += 1;
    t.spend += ad.spend;
    t.purchases += ad.purchases;
    t.purchaseValue += ad.purchaseValue;
  }
  t.roas = t.spend > 0 ? t.purchaseValue / t.spend : null;
  return t;
}

/**
 * How the sale actually closed — the mechanism, not the marketing source.
 * The other columns already say where the customer came from; this says what
 * they paid through, which is the part that distinguishes a staff-sent invoice
 * from a self-serve checkout.
 */
function convertedVia(o) {
  const landings = `${o.firstVisit?.landingPage || ''} ${o.lastVisit?.landingPage || ''}`;
  if (/\/checkouts\/do\//i.test(landings)) return 'Draft invoice link';
  if (o.isDraft) return 'Draft order';

  const channel = (o.channelName || o.appName || o.sourceName || '').trim();
  if (/^shop$/i.test(channel)) return 'Shop app';
  if (/online store/i.test(channel)) return 'Storefront checkout';
  return channel || 'Unknown';
}

function slim(o, adSpendByKey = new Map()) {
  const campaign = orderCampaign(o);
  const ad = campaign ? adSpendByKey.get(campaignKey(campaign)) : null;

  return {
    id: o.id,
    convertedVia: convertedVia(o),
    campaign,
    // True when Meta was actually billing for this campaign in the window —
    // the difference between "the URL said facebook" and "money was spent".
    adBacked: Boolean(ad && ad.spend > 0),
    adSpend: ad ? ad.spend : null,
    orderNumber: o.orderNumber,
    adminUrl: o.adminUrl,
    createdAt: o.createdAt,
    customerName: o.customerName,
    orderIndex: o.orderIndex ?? null,
    customerOrders: o.customerOrders ?? null,
    customerSpend: o.customerSpend ?? null,
    netSale: o.netPayment,
    totalPrice: o.totalPrice,
    refunded: o.refunded,
    currency: o.currency,
    financialStatus: o.financialStatus,
    cancelled: Boolean(o.cancelledAt),
    channelName: o.channelName || o.appName || o.sourceName,
    // Shopify Analytics' channel for this exact order, and the device it names.
    // Both null when the channel map was unavailable.
    salesChannel: o.salesChannel || null,
    device: deviceLabel(o),
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
