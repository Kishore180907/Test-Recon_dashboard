/* =============================================================================
 *  Shopify Admin GraphQL client + order fetcher
 * ========================================================================== */

import { getAccessToken, invalidateToken } from './token.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

function endpoint() {
  const shop = process.env.SHOPIFY_SHOP;
  if (!shop) throw new Error('SHOPIFY_SHOP is not set (e.g. clb-xxiii.myshopify.com)');
  return `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST a GraphQL query, with retry on throttling and 5xx. */
export async function gql(query, variables = {}, attempt = 0) {
  const token = await getAccessToken();

  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    if (attempt < 4) {
      await sleep(500 * 2 ** attempt);
      return gql(query, variables, attempt + 1);
    }
    throw err;
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await sleep(retryAfter ? retryAfter * 1000 : 700 * 2 ** attempt);
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  }

  // A short-lived client-credentials token can lapse mid-run. One forced
  // re-exchange distinguishes an expired token from genuinely wrong scopes.
  if (res.status === 401 && attempt < 2) {
    invalidateToken();
    await getAccessToken({ force: true });
    return gql(query, variables, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();

  const throttled = (body.errors || []).some(
    (e) => e?.extensions?.code === 'THROTTLED' || /throttl/i.test(e?.message || '')
  );
  if (throttled && attempt < 5) {
    await sleep(1200 * 2 ** attempt);
    return gql(query, variables, attempt + 1);
  }

  // Field-level permission errors are tolerated (the field comes back null);
  // only a total absence of data is fatal.
  if (!body.data) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  }

  // Stay well clear of the leaky-bucket limit.
  const status = body.extensions?.cost?.throttleStatus;
  if (status && status.currentlyAvailable < status.maximumAvailable * 0.2) {
    await sleep(1000);
  }

  return body.data;
}

const ORDER_FIELDS = `
  id
  name
  createdAt
  updatedAt
  processedAt
  cancelledAt
  test
  note
  tags
  sourceName
  app { name }
  channelInformation { channelDefinition { handle channelName subChannelName } }
  retailLocation { name }
  physicalLocation { name }
  displayFinancialStatus
  customer {
    displayName
    numberOfOrders
    amountSpent { amount currencyCode }
  }
  netPaymentSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount } }
  currentSubtotalPriceSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  customerJourneySummary {
    ready
    momentsCount { count precision }
    customerOrderIndex
    daysToConversion
    firstVisit {
      occurredAt
      landingPage
      referrerUrl
      source
      sourceType
      sourceDescription
      utmParameters { source medium campaign content term }
    }
    lastVisit {
      occurredAt
      landingPage
      referrerUrl
      source
      sourceType
      sourceDescription
      utmParameters { source medium campaign content term }
    }
  }
`;

const ORDERS_QUERY = `
  query Orders($first: Int!, $after: String, $q: String!) {
    orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT, reverse: false) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

const num = (v) => (v == null || v === '' ? 0 : Number(v));

function visit(v) {
  if (!v) return null;
  const utm = v.utmParameters || null;
  return {
    occurredAt: v.occurredAt || null,
    landingPage: v.landingPage || null,
    referrerUrl: v.referrerUrl || null,
    source: v.source || null,
    sourceType: v.sourceType || null,
    sourceDescription: v.sourceDescription || null,
    utmSource: utm?.source || null,
    utmMedium: utm?.medium || null,
    utmCampaign: utm?.campaign || null,
  };
}

function host(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Human-readable traffic source, best signal first:
 *   explicit UTM tagging  >  Shopify's resolved source  >  referrer host  >  Direct
 * Shopify sometimes stores a URL or the literal string "an unknown source" in
 * `source`; both are cleaned up here.
 */
export function trafficSourceOf(v) {
  if (!v) return 'No journey data';

  if (v.utmSource) {
    return v.utmMedium ? `${v.utmSource} / ${v.utmMedium}` : v.utmSource;
  }

  let src = v.source || null;
  if (src && /^https?:\/\//i.test(src)) src = host(src);
  if (src && /^an unknown source$/i.test(src)) src = null;
  if (src && src.toLowerCase() !== 'direct') return src;

  const ref = v.referrerUrl ? host(v.referrerUrl) : null;
  const own = (process.env.SHOPIFY_STOREFRONT_HOST || 'clb23.com').replace(/^www\./, '');
  if (ref && !ref.endsWith(own)) return ref;

  if (src) return 'Direct';
  return 'Unknown';
}

function normalize(n) {
  const j = n.customerJourneySummary || {};
  const first = visit(j.firstVisit);
  const last = visit(j.lastVisit);
  return {
    id: n.id,
    orderNumber: n.name,
    adminUrl: `https://admin.shopify.com/store/${(process.env.SHOPIFY_SHOP || '').replace(
      '.myshopify.com',
      ''
    )}/orders/${(n.id || '').split('/').pop()}`,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    cancelledAt: n.cancelledAt,
    test: Boolean(n.test),
    note: n.note || '',
    tags: n.tags || [],
    sourceName: n.sourceName || '',
    appName: n.app?.name || '',
    channelHandle: n.channelInformation?.channelDefinition?.handle || '',
    channelName: n.channelInformation?.channelDefinition?.channelName || '',
    retailLocationName: n.retailLocation?.name || n.physicalLocation?.name || '',
    financialStatus: n.displayFinancialStatus || '',
    customerName: n.customer?.displayName || '',
    /* Repeat-customer signal. customerOrderIndex was already being fetched and
     * thrown away; numberOfOrders and amountSpent are scalars hanging off a
     * customer object the query already traverses, so all three are free. The
     * previous order itself is NOT here: that needs a nested orders connection,
     * which is exactly the per-page cost the journey fetch avoids. It is loaded
     * on demand instead, in fetchOrderJourney. */
    customerOrders: Number(n.customer?.numberOfOrders) || null,
    customerSpend: num(n.customer?.amountSpent?.amount),
    orderIndex: j.customerOrderIndex ?? null,
    currency: n.netPaymentSet?.shopMoney?.currencyCode || 'USD',

    netPayment: num(n.netPaymentSet?.shopMoney?.amount),
    totalPrice: num(n.totalPriceSet?.shopMoney?.amount),
    subtotal: num(n.currentSubtotalPriceSet?.shopMoney?.amount),
    refunded: num(n.totalRefundedSet?.shopMoney?.amount),
    discounts: num(n.totalDiscountsSet?.shopMoney?.amount),

    journeyReady: j.ready ?? null,
    touchpoints: j.momentsCount?.count ?? null,
    daysToConversion: j.daysToConversion ?? null,
    firstVisit: first,
    lastVisit: last,
    firstClickSource: trafficSourceOf(first),
    lastClickSource: trafficSourceOf(last),
  };
}

/**
 * Fetch every order matching a Shopify search query, following pagination.
 * `onPage` is called with each normalized page so callers can stream progress.
 */
export async function fetchOrdersByQuery(q, { pageSize = 50, maxPages = 200 } = {}) {
  const out = [];
  let after = null;
  let pages = 0;

  while (pages < maxPages) {
    const data = await gql(ORDERS_QUERY, { first: pageSize, after, q });
    const conn = data.orders;
    for (const node of conn.nodes) out.push(normalize(node));
    pages += 1;
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return out;
}

/**
 * One page at a time, so the backfill can checkpoint its cursor to storage and
 * resume where it stopped if the run is cut short.
 */
export async function fetchOrdersPage({ q, after = null, pageSize = 100 }) {
  if (process.env.MOCK_DATA === '1') {
    const all = await mockOrders();
    return { orders: all, hasNextPage: false, endCursor: null };
  }
  const data = await gql(ORDERS_QUERY, { first: pageSize, after, q });
  const conn = data.orders;
  return {
    orders: conn.nodes.map(normalize),
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
  };
}

async function mockOrders() {
  const { SAMPLE_ORDERS } = await import('../fixtures/sample-orders.js');
  return SAMPLE_ORDERS.map(normalize);
}

/** Search query for a whole coverage window, used by the backfill. */
export function buildBackfillQuery({ startISO, endISO }) {
  return buildRangeQuery({ startISO, endISO });
}

/** ISO strings that Shopify's search syntax accepts. */
function iso(d) {
  return new Date(d).toISOString();
}

export function buildRangeQuery({ startISO, endISO, updatedSinceISO }) {
  const parts = [`created_at:>='${iso(startISO)}'`, `created_at:<='${iso(endISO)}'`];
  if (updatedSinceISO) parts.push(`updated_at:>='${iso(updatedSinceISO)}'`);
  return parts.join(' AND ');
}

export async function fetchOrdersInRange({ startISO, endISO, updatedSinceISO, maxPages = 200 }) {
  // Offline preview: MOCK_DATA=1 serves the bundled fixture instead of Shopify.
  if (process.env.MOCK_DATA === '1') {
    const s = new Date(startISO).getTime();
    const e = new Date(endISO).getTime();
    const { SAMPLE_ORDERS } = await import('../fixtures/sample-orders.js');
    return SAMPLE_ORDERS.filter((o) => {
      const t = new Date(o.createdAt).getTime();
      return t >= s && t <= e;
    }).map(normalize);
  }
  return fetchOrdersByQuery(buildRangeQuery({ startISO, endISO, updatedSinceISO }), { maxPages });
}

/* =============================================================================
 *  One order's full customer journey.
 * -----------------------------------------------------------------------------
 *  Fetched on demand, never during the bulk sync. A nested moments connection
 *  multiplies the cost of every order in a page, and the backfill already pulls
 *  100 orders at a time — asking for 40 sessions each would blow the query cost
 *  budget and grow every month shard several times over, all to serve a panel
 *  most orders never have opened. One order at a time is a small, cheap query.
 * ========================================================================== */
const JOURNEY_QUERY = `
  query Journey($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      id
      name
      createdAt
      note
      netPaymentSet { shopMoney { amount currencyCode } }
      customer {
        displayName
        numberOfOrders
        amountSpent { amount currencyCode }
        # Two, not one: customer.lastOrder returns THIS order for anything
        # recent, so it can never answer "what did they buy before?". Taking
        # the two most recent and dropping the current one does.
        # (GraphQL comments are #. A JS block comment here is a parse error.)
        orders(first: 2, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            netPaymentSet { shopMoney { amount currencyCode } }
          }
        }
      }
      customerJourneySummary {
        ready
        momentsCount { count precision }
        daysToConversion
        moments(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            occurredAt
            ... on CustomerVisit {
              landingPage
              referrerUrl
              source
              sourceType
              sourceDescription
              utmParameters { source medium campaign content term }
            }
          }
        }
      }
    }
  }
`;

/** Shopify order GID. Validated before it ever reaches the API. */
export const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

/**
 * Every session Shopify attributed to this order, oldest first.
 *
 * Pages because journeys get long: the longest in a 50-order sample ran to 59
 * sessions. `maxPages` caps a pathological one rather than looping forever.
 */
export async function fetchOrderJourney(id, { pageSize = 50, maxPages = 4 } = {}) {
  if (process.env.MOCK_DATA === '1') {
    const { SAMPLE_JOURNEYS } = await import('../fixtures/sample-journeys.js');
    const hit = SAMPLE_JOURNEYS[id];
    if (!hit) return null;
    return { ...hit, moments: hit.moments.map(visit) };
  }

  if (!ORDER_GID.test(String(id || ''))) {
    throw new Error('Not a Shopify order id');
  }

  const moments = [];
  let after = null;
  let head = null;

  for (let page = 0; page < maxPages; page += 1) {
    const data = await gql(JOURNEY_QUERY, { id, first: pageSize, after });
    const o = data.order;
    if (!o) return null;

    if (!head) {
      const c = o.customer || {};
      const prior = (c.orders?.nodes || []).find((n) => n.id !== o.id) || null;
      head = {
        id: o.id,
        orderNumber: o.name,
        createdAt: o.createdAt,
        note: o.note || '',
        netPayment: num(o.netPaymentSet?.shopMoney?.amount),
        currency: o.netPaymentSet?.shopMoney?.currencyCode || 'USD',
        customerName: c.displayName || '',
        customerOrders: Number(c.numberOfOrders) || null,
        customerSpend: num(c.amountSpent?.amount),
        previousOrder: prior
          ? {
              orderNumber: prior.name,
              createdAt: prior.createdAt,
              netPayment: num(prior.netPaymentSet?.shopMoney?.amount),
              currency: prior.netPaymentSet?.shopMoney?.currencyCode || 'USD',
              adminUrl: `https://admin.shopify.com/store/${(process.env.SHOPIFY_SHOP || '').replace(
                '.myshopify.com',
                ''
              )}/orders/${(prior.id || '').split('/').pop()}`,
            }
          : null,
        ready: o.customerJourneySummary?.ready ?? null,
        touchpoints: o.customerJourneySummary?.momentsCount?.count ?? null,
        daysToConversion: o.customerJourneySummary?.daysToConversion ?? null,
      };
    }

    const conn = o.customerJourneySummary?.moments;
    for (const n of conn?.nodes || []) moments.push(visit(n));

    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return { ...head, moments };
}

export async function shopInfo() {
  const data = await gql(`{ shop { name myshopifyDomain currencyCode ianaTimezone } }`);
  return data.shop;
}

/* =============================================================================
 *  SHOPIFY'S OWN CHANNEL REPORT
 * -----------------------------------------------------------------------------
 *  The three tiles are an OPERATIONAL split, computed from order fields. This is
 *  something different and deliberately kept apart: Shopify Analytics' own
 *  sales_channel report, fetched verbatim so the dashboard can show the number
 *  the admin shows, with no reclassification.
 *
 *  Why it cannot be derived from the orders we already store: Shopify reports a
 *  "Shopify Mobile for iPhone" channel for drafts written up on a phone, but the
 *  Admin API returns those orders as plain `sourceName: 'shopify_draft_order'`,
 *  app 'Draft Orders'. The device is simply not in the order payload. Only
 *  ShopifyQL knows it. That one channel was $56,636 across 17 orders in August —
 *  the entire gap between our Ecommerce tile and Shopify's E-Commerce line.
 *
 *  `net_sales` is Shopify's definition: gross − discounts − returns, BEFORE
 *  shipping and tax, and it counts unpaid draft invoices at full value. That is
 *  NOT the same as the tiles' netPayment (cash collected). Never add the two.
 * ========================================================================== */

/* Channels that make up Shopify's "E-Commerce" line — the exact set the admin
 * lists: Facebook & Instagram, Marketplace Connect, Online Store, Shop, Shopify
 * Mobile for iPhone, StockX.
 *
 * It is NOT "everything except POS". Draft Orders is its own channel in Shopify
 * and sits OUTSIDE E-Commerce; including it gives $166,241.71 instead of the
 * $108,124.65 the admin reports. Both POS and Draft Orders are therefore
 * excluded, and each is reported separately below.
 *
 * Matching is a case-insensitive prefix so "Shopify Mobile for iPhone" and any
 * future "... for Android" both land in the same place. */
export const NON_ECOMMERCE_CHANNELS = ['point of sale', 'draft orders'];

const channelClass = (name) => {
  const s = String(name ?? '').trim().toLowerCase();
  if (s.startsWith('point of sale')) return 'pos';
  if (s.startsWith('draft orders')) return 'draft';
  return 'ecommerce';
};

// Verified against the live Admin API: rows come back as OBJECTS keyed by
// column name (not positional arrays), and parseErrors is a list of strings.
// Both differ from what the docs imply, so this shape is pinned by a test.
const SHOPIFYQL_QUERY = `
  query ChannelSales($q: String!) {
    shopifyqlQuery(query: $q) {
      tableData {
        columns { name dataType }
        rows
      }
      parseErrors
    }
  }
`;

/**
 * Net sales per sales channel for a date range, straight from Shopify Analytics.
 *
 * Returns { channels: [{ channel, orders, netSales }], ecommerce: {...},
 * pos: {...} } or null when the store's plan does not expose ShopifyQL. A null
 * return is not an error — the caller just hides the row.
 */
export async function fetchChannelSales(startDate, endDate) {
  if (process.env.MOCK_DATA === '1') {
    const { SAMPLE_CHANNELS } = await import('../fixtures/sample-channels.js');
    return SAMPLE_CHANNELS(startDate, endDate);
  }

  const q =
    `FROM sales SHOW orders, net_sales GROUP BY sales_channel ` +
    `SINCE ${startDate} UNTIL ${endDate}`;

  let data;
  try {
    data = await gql(SHOPIFYQL_QUERY, { q });
  } catch (err) {
    console.log(`[channels] ShopifyQL unavailable: ${err.message}`);
    return null;
  }

  const res = data?.shopifyqlQuery;
  if (res?.parseErrors?.length) {
    console.log(`[channels] parse error: ${res.parseErrors[0].message}`);
    return null;
  }

  const rows = res?.tableData?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;

  const channels = rows.map((r) => ({
    channel: String(r.sales_channel ?? '').trim() || 'Unknown',
    orders: Number(r.orders) || 0,
    netSales: Number(r.net_sales) || 0,
  }));

  const tally = (list) =>
    list.reduce(
      (a, c) => ({ orders: a.orders + c.orders, netSales: a.netSales + c.netSales }),
      { orders: 0, netSales: 0 },
    );

  const of = (kind) => channels.filter((c) => channelClass(c.channel) === kind);

  /* The Shopify Mobile tile's whole reason for existing. Shopify reports this
   * channel for draft orders staff wrote up on a phone, but the Admin API hands
   * those same orders back as plain drafts — app 'Draft Orders', sourceName
   * 'shopify_draft_order', channelInformation null, sourceIdentifier null,
   * publication null, customAttributes empty. Every field that could name the
   * device is empty (verified against #27790, a $12,500 order). So this figure
   * cannot be derived from stored orders at any price; it can only be asked for.
   *
   * Prefix match so a future "... for Android" lands here too. */
  const mobileRows = channels.filter((c) => /^shopify mobile/i.test(c.channel));

  return {
    channels: channels.sort((a, b) => b.netSales - a.netSales),
    ecommerce: tally(of('ecommerce')),
    draft: tally(of('draft')),
    pos: tally(of('pos')),
    mobile: {
      ...tally(mobileRows),
      // Named so the tile can label itself with whatever Shopify actually calls
      // the channel, rather than hardcoding "for iPhone".
      label: mobileRows[0]?.channel || 'Shopify Mobile',
      present: mobileRows.length > 0,
    },
  };
}
