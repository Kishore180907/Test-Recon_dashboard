/* =============================================================================
 *  Shopify Admin GraphQL client + order fetcher
 * ========================================================================== */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

function endpoint() {
  const shop = process.env.SHOPIFY_SHOP;
  if (!shop) throw new Error('SHOPIFY_SHOP is not set (e.g. clb-xxiii.myshopify.com)');
  return `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST a GraphQL query, with retry on throttling and 5xx. */
export async function gql(query, variables = {}, attempt = 0) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error('SHOPIFY_ADMIN_TOKEN is not set');

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
  customer { displayName }
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

export async function shopInfo() {
  const data = await gql(`{ shop { name myshopifyDomain currencyCode ianaTimezone } }`);
  return data.shop;
}
