/* =============================================================================
 *  SELL-THROUGH BY BRAND
 *  ---------------------------------------------------------------------------
 *  Everything this dashboard knows about inventory. It is the only part of the
 *  app that reads Shopify's `inventory` dataset rather than orders, because
 *  stock on hand is not in the order stream at all — the app stores orders, and
 *  no amount of order history tells you what is still sitting in the warehouse.
 *
 *  WHY TWO SELL-THROUGH NUMBERS
 *
 *  Shopify computes sell-through over whatever window you ask for:
 *
 *      units sold in window / (units sold in window + units still on hand)
 *
 *  The window is doing a lot of work in that formula. Measured over 30 days
 *  against ~6,000 units of standing stock, this store's best brand came out at
 *  29.8% and most sat between 6% and 9% — not because anything is wrong, but
 *  because a month of sales is small next to the shelf.
 *
 *  The published benchmarks people quote (80%+ excellent, 60–80% healthy,
 *  40–50% the luxury norm, under 40% trouble) were written for the whole life
 *  of the stock, not a rolling month. Judged against those bands, a 30-day
 *  number paints every brand in the building as failing. So this module fetches
 *  BOTH and keeps them apart:
 *
 *    lifetime  — no date bounds. This is what the benchmark bands grade.
 *    windows   — 30/60/90 day. Velocity: is it moving NOW. Ungraded on purpose.
 *
 *  The companion figures are what turn a percentage into a decision, and for a
 *  high-value resale book the money one matters more than the rate:
 *  `capitalOnHand` is the retail value of what has not sold. A brand can post a
 *  respectable lifetime rate and still have seven figures stranded on the shelf.
 * ========================================================================== */

import { gql } from './shopify.js';

/* Rows come back as OBJECTS keyed by column name and parseErrors is a list of
 * strings — both verified against the live API, both unlike what the docs
 * imply. Pinned by a test in selftest.js. */
const SHOPIFYQL = `
  query BrandSellThrough($q: String!) {
    shopifyqlQuery(query: $q) {
      tableData {
        columns { name dataType }
        rows
      }
      parseErrors
    }
  }
`;

/** Windows offered beside the lifetime figure, in days. */
export const STR_WINDOWS = [30, 60, 90];

/**
 * Benchmark bands, graded against LIFETIME sell-through only.
 *
 * `min` is inclusive. Ordered strongest first; the first match wins.
 * Exported so the UI and the tests share one definition of "good".
 */
export const STR_BANDS = [
  { key: 'excellent', min: 0.80, label: 'Excellent',
    note: 'Selling out. Worth testing a higher ask or a lower payout — this rate suggests money left on the table.' },
  { key: 'healthy', min: 0.60, label: 'Healthy',
    note: 'The resale sweet spot: priced right and moving without markdowns.' },
  { key: 'luxury', min: 0.40, label: 'Luxury norm',
    note: 'Normal for primary luxury, where scarcity is the point. In resale it means capital is sitting.' },
  { key: 'watch', min: 0, label: 'Below benchmark',
    note: 'Overpriced, out of season, or simply not wanted.' },
];

export function bandFor(rate) {
  /* Guarded before Number(), because Number(null) and Number('') are both 0 —
   * which is finite, and would grade a brand we have NO rate for as "below
   * benchmark". Missing is not the same as bad, and a brand that Shopify
   * reported nothing for must come back ungraded. */
  if (rate == null || rate === '') return null;
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  return STR_BANDS.find((b) => r >= b.min) || STR_BANDS[STR_BANDS.length - 1];
}

/** YYYY-MM-DD, n days before `end` (inclusive of the end day). */
export function windowStart(end, days) {
  const d = new Date(`${end}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** One ShopifyQL call. Returns rows, or null when the plan does not expose it. */
async function ql(q, tag) {
  let data;
  try {
    data = await gql(SHOPIFYQL, { q });
  } catch (err) {
    console.log(`[sellthrough] ${tag} failed: ${err.message}`);
    return null;
  }
  const res = data?.shopifyqlQuery;
  if (res?.parseErrors?.length) {
    console.log(`[sellthrough] ${tag} parse error: ${JSON.stringify(res.parseErrors[0])}`);
    return null;
  }
  const rows = res?.tableData?.rows;
  return Array.isArray(rows) ? rows : null;
}

const INVENTORY_COLS =
  'ending_inventory_units, inventory_units_sold, sell_through_rate, ' +
  'days_of_inventory_remaining, ending_inventory_value';

/** Brand key. Shopify leaves the vendor blank on some products; it is a real
 *  group (it had $10k of net sales in the live data), so it is named, not
 *  dropped. */
const vendorOf = (r) => String(r?.product_vendor ?? '').trim() || 'No brand set';

const LIMIT = 250;

/**
 * Sell-through by brand: lifetime, the rolling windows, and the money.
 *
 * @param {string} end  YYYY-MM-DD, the last day of the rolling windows.
 * @returns {Promise<object|null>} null when ShopifyQL is unavailable.
 */
export async function fetchBrandSellThrough(end) {
  if (process.env.MOCK_DATA === '1') {
    const { SAMPLE_SELLTHROUGH } = await import('../fixtures/sample-sellthrough.js');
    return SAMPLE_SELLTHROUGH(end);
  }

  const longest = Math.max(...STR_WINDOWS);
  const salesStart = windowStart(end, longest);

  /* One call per window plus lifetime plus sales. Shopify's analytics endpoint
   * rate-limits, and these run against the same backend, so they go one after
   * another rather than in parallel — the panel is opened on demand and a
   * second of latency costs nothing next to a 429. */
  const lifetimeRows = await ql(
    `FROM inventory SHOW ${INVENTORY_COLS} GROUP BY product_vendor LIMIT ${LIMIT}`,
    'lifetime');

  // Lifetime is the one the bands grade. Without it there is no panel.
  if (!lifetimeRows) return null;

  const windows = {};
  for (const days of STR_WINDOWS) {
    windows[days] = await ql(
      `FROM inventory SHOW ${INVENTORY_COLS} GROUP BY product_vendor ` +
      `SINCE ${windowStart(end, days)} UNTIL ${end} LIMIT ${LIMIT}`,
      `${days}d`);
  }

  /* Returns are money here, not units: ShopifyQL's inventory dataset has no
   * returned-quantity column and the sales dataset has no item-quantity column
   * grouped by vendor. `sales_reversals` over `gross_sales` is the honest
   * version of "how much of what we sold came back". */
  const salesRows = await ql(
    `FROM sales SHOW gross_sales, net_sales, sales_reversals, discounts ` +
    `GROUP BY product_vendor SINCE ${salesStart} UNTIL ${end} LIMIT ${LIMIT}`,
    'sales');

  return shapeBrands({ lifetimeRows, windows, salesRows, end, salesStart });
}

/**
 * Merge the raw ShopifyQL rows into one row per brand.
 *
 * Split out from the fetching so the tests can drive it with fixed rows and
 * assert the merge, the derived rates and the flags without a network call.
 */
export function shapeBrands({ lifetimeRows, windows = {}, salesRows, end, salesStart }) {
  const byVendor = new Map();

  const rowFor = (name) => {
    if (!byVendor.has(name)) {
      byVendor.set(name, {
        brand: name,
        lifetimeRate: null,
        unitsSoldLifetime: 0,
        unitsOnHand: 0,
        capitalOnHand: 0,
        daysRemaining: null,
        windows: {},
        grossSales: 0,
        netSales: 0,
        reversals: 0,
        discounts: 0,
        returnRate: null,
      });
    }
    return byVendor.get(name);
  };

  for (const r of lifetimeRows || []) {
    const b = rowFor(vendorOf(r));
    b.lifetimeRate = num(r.sell_through_rate);
    b.unitsSoldLifetime = num(r.inventory_units_sold);
    b.unitsOnHand = num(r.ending_inventory_units);
    b.capitalOnHand = num(r.ending_inventory_value);
    const days = num(r.days_of_inventory_remaining);
    b.daysRemaining = days > 0 ? days : null;
  }

  for (const [days, rows] of Object.entries(windows)) {
    for (const r of rows || []) {
      const b = rowFor(vendorOf(r));
      b.windows[days] = {
        rate: num(r.sell_through_rate),
        unitsSold: num(r.inventory_units_sold),
        daysRemaining: num(r.days_of_inventory_remaining) || null,
      };
    }
  }

  for (const r of salesRows || []) {
    const b = rowFor(vendorOf(r));
    b.grossSales = num(r.gross_sales);
    b.netSales = num(r.net_sales);
    // Shopify reports reversals as a negative; the magnitude is what matters.
    b.reversals = Math.abs(num(r.sales_reversals));
    b.discounts = Math.abs(num(r.discounts));
    b.returnRate = b.grossSales > 0 ? b.reversals / b.grossSales : null;
  }

  const brands = [...byVendor.values()]
    .map((b) => ({ ...b, band: bandFor(b.lifetimeRate)?.key ?? null, flags: flagsFor(b) }))
    // Ranked by money at rest: the biggest number on the shelf is the thing
    // most worth looking at first, whatever its percentage says.
    .sort((a, b) => b.capitalOnHand - a.capitalOnHand);

  const totals = brands.reduce((t, b) => ({
    capitalOnHand: t.capitalOnHand + b.capitalOnHand,
    unitsOnHand: t.unitsOnHand + b.unitsOnHand,
    unitsSoldLifetime: t.unitsSoldLifetime + b.unitsSoldLifetime,
    netSales: t.netSales + b.netSales,
    grossSales: t.grossSales + b.grossSales,
    reversals: t.reversals + b.reversals,
  }), { capitalOnHand: 0, unitsOnHand: 0, unitsSoldLifetime: 0, netSales: 0, grossSales: 0, reversals: 0 });

  /* Weighted, not averaged. A mean of per-brand percentages would let a brand
   * holding nine units swing the store-wide figure as hard as one holding two
   * thousand. */
  const denom = totals.unitsSoldLifetime + totals.unitsOnHand;
  totals.lifetimeRate = denom > 0 ? totals.unitsSoldLifetime / denom : null;
  totals.returnRate = totals.grossSales > 0 ? totals.reversals / totals.grossSales : null;

  return {
    end,
    salesSince: salesStart,
    windows: STR_WINDOWS,
    bands: STR_BANDS,
    brands,
    totals,
  };
}

/* -----------------------------------------------------------------------------
 * Flags: the COMBINATIONS, not advice.
 * -----------------------------------------------------------------------------
 * Each one names a condition that is only visible when two numbers are read
 * together — which is the whole reason the percentage alone is not enough. What
 * to do about it is deliberately left to the reader.
 * ---------------------------------------------------------------------------*/
export const CAPITAL_AT_REST = 250_000;   // dollars still on the shelf
export const SLOW_DAYS = 180;             // days of stock at current velocity
export const HIGH_RETURN_RATE = 0.10;     // reversals as a share of gross
export const FAST_DAYS = 45;

export function flagsFor(b) {
  const flags = [];

  if (b.capitalOnHand >= CAPITAL_AT_REST && (b.daysRemaining ?? 0) >= SLOW_DAYS) {
    flags.push({
      key: 'capital-stranded',
      label: 'Capital stranded',
      detail: `${money(b.capitalOnHand)} on hand at ${Math.round(b.daysRemaining)} days of stock`,
    });
  } else if (b.capitalOnHand >= CAPITAL_AT_REST) {
    flags.push({
      key: 'capital-heavy',
      label: 'Capital heavy',
      detail: `${money(b.capitalOnHand)} still on the shelf`,
    });
  }

  if ((b.daysRemaining ?? 0) >= SLOW_DAYS && b.capitalOnHand < CAPITAL_AT_REST) {
    flags.push({
      key: 'slow',
      label: 'Slow moving',
      detail: `${Math.round(b.daysRemaining)} days of stock at current velocity`,
    });
  }

  if (b.returnRate != null && b.returnRate >= HIGH_RETURN_RATE) {
    flags.push({
      key: 'returns',
      label: 'High returns',
      detail: `${(b.returnRate * 100).toFixed(1)}% of gross came back — sell-through overstates this brand`,
    });
  }

  if (b.lifetimeRate != null && b.lifetimeRate >= 0.80
      && b.daysRemaining != null && b.daysRemaining <= FAST_DAYS) {
    flags.push({
      key: 'priced-under',
      label: 'Clearing fast',
      detail: `${(b.lifetimeRate * 100).toFixed(0)}% sold through with ${Math.round(b.daysRemaining)} days left`,
    });
  }

  return flags;
}

const money = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
};
