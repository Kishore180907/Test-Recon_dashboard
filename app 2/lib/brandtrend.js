/* =============================================================================
 *  ONE BRAND, WEEK BY WEEK
 *  ---------------------------------------------------------------------------
 *  The sell-through table answers "how much of this brand has sold" with a
 *  single percentage. That number cannot tell you which direction the brand is
 *  moving, and direction is the whole question: a brand at 40% that is clearing
 *  thirty units a week needs nothing done to it, and a brand at 40% that has
 *  not moved a unit since July needs a markdown this month.
 *
 *  So clicking a brand asks for its last thirteen weeks and draws two lines:
 *
 *    unitsSold    — how many left the building that week.
 *    unitsOnHand  — how many were still there at the end of it.
 *
 *  They are deliberately plotted together. Units sold alone looks like noise;
 *  next to a stock line that barely slopes, it reads as what it is. The money
 *  view swaps in net sales for the same weeks, because a brand can shift plenty
 *  of cheap units and still not pay for its shelf.
 *
 *  Both series come from the same two datasets the panel already uses, filtered
 *  to one vendor, so nothing here can disagree with the table above it.
 * ========================================================================== */

import { gql } from './shopify.js';
import { windowStart } from './sellthrough.js';

const SHOPIFYQL = `
  query BrandTrend($q: String!) {
    shopifyqlQuery(query: $q) {
      tableData {
        columns { name dataType }
        rows
      }
      parseErrors
    }
  }
`;

/** Days of history behind the chart. Thirteen weeks — a quarter. */
export const TREND_DAYS = 90;

/** The name the table gives products Shopify left without a vendor. */
export const NO_BRAND = 'No brand set';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Make a vendor name safe to sit inside a ShopifyQL string literal.
 *
 * This is the only place in the app where a user-supplied string reaches a
 * query language, so it is handled as an injection risk rather than a naming
 * quirk. Single quotes are doubled, which is how the literal escapes itself;
 * anything that could end the statement or start a new clause — quotes we
 * cannot pair, backslashes, newlines, control characters — means the name is
 * refused outright. A brand nobody can chart is a far smaller problem than a
 * query somebody else gets to finish writing.
 *
 * @returns {string|null} the escaped literal body, or null if unsafe.
 */
export function escapeVendor(name) {
  const s = String(name ?? '');
  if (!s.trim()) return null;
  if (s.length > 200) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\"]/.test(s)) return null;
  return s.replace(/'/g, "''");
}

async function ql(q, tag) {
  let data;
  try {
    data = await gql(SHOPIFYQL, { q });
  } catch (err) {
    console.log(`[brandtrend] ${tag} failed: ${err.message}`);
    return null;
  }
  const res = data?.shopifyqlQuery;
  if (res?.parseErrors?.length) {
    console.log(`[brandtrend] ${tag} parse error: ${JSON.stringify(res.parseErrors[0])}`);
    return null;
  }
  const rows = res?.tableData?.rows;
  return Array.isArray(rows) ? rows : null;
}

/**
 * Thirteen weeks of one brand.
 *
 * @param {string} brand  vendor name exactly as the table shows it.
 * @param {string} end    YYYY-MM-DD, the last day of the range.
 * @returns {Promise<object|null>} null when the brand cannot be queried.
 */
export async function fetchBrandTrend(brand, end) {
  if (process.env.MOCK_DATA === '1') {
    const { SAMPLE_TREND } = await import('../fixtures/sample-trend.js');
    return SAMPLE_TREND(brand, end);
  }

  /* The blank-vendor group is a real row in the table — it holds stock and it
   * books sales — but `product_vendor = ''` matches nothing in ShopifyQL, so
   * there is no honest chart to draw for it. Say so rather than draw a flat
   * line at zero and let someone read it as "this brand is dead". */
  if (brand === NO_BRAND) {
    return { brand, end, weeks: [], unavailable: 'no-vendor' };
  }

  const vendor = escapeVendor(brand);
  if (!vendor) return null;

  const since = windowStart(end, TREND_DAYS);
  const where = `WHERE product_vendor = '${vendor}'`;
  const range = `TIMESERIES week SINCE ${since} UNTIL ${end}`;

  // Sequential, same as the panel: these hit the rate-limited analytics API.
  const invRows = await ql(
    `FROM inventory SHOW ending_inventory_units, inventory_units_sold, sell_through_rate ` +
    `${where} ${range}`, 'inventory');

  if (!invRows) return null;

  const salesRows = await ql(
    `FROM sales SHOW gross_sales, net_sales, sales_reversals ${where} ${range}`, 'sales');

  return shapeTrend({ brand, end, since, invRows, salesRows });
}

/**
 * Merge the inventory and sales timeseries into one row per week.
 *
 * Split out from the fetch so the tests can drive it with fixed rows. The two
 * queries are asked for the same range, but they are still merged by week key
 * rather than zipped by position: an empty week is missing from one series and
 * present in the other often enough that pairing by index would silently slide
 * every later week onto the wrong date.
 */
export function shapeTrend({ brand, end, since, invRows, salesRows }) {
  const byWeek = new Map();

  const weekFor = (k) => {
    if (!byWeek.has(k)) {
      byWeek.set(k, {
        week: k,
        unitsSold: 0,
        unitsOnHand: 0,
        rate: null,
        grossSales: 0,
        netSales: 0,
        reversals: 0,
      });
    }
    return byWeek.get(k);
  };

  const keyOf = (r) => String(r?.week ?? r?.day ?? '').slice(0, 10);

  for (const r of invRows || []) {
    const k = keyOf(r);
    if (!k) continue;
    const w = weekFor(k);
    w.unitsSold = num(r.inventory_units_sold);
    w.unitsOnHand = num(r.ending_inventory_units);
    const rate = r.sell_through_rate;
    w.rate = rate == null || rate === '' ? null : num(rate);
  }

  for (const r of salesRows || []) {
    const k = keyOf(r);
    if (!k) continue;
    const w = weekFor(k);
    w.grossSales = num(r.gross_sales);
    w.netSales = num(r.net_sales);
    // Shopify reports reversals as a negative. Stored as a magnitude so the
    // chart and the table never have to agree on a sign convention.
    w.reversals = Math.abs(num(r.sales_reversals));
  }

  const weeks = [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));

  const sum = (f) => weeks.reduce((t, w) => t + f(w), 0);
  const grossSales = sum((w) => w.grossSales);
  const reversals = sum((w) => w.reversals);

  return {
    brand,
    end,
    since,
    weeks,
    totals: {
      unitsSold: sum((w) => w.unitsSold),
      grossSales,
      netSales: sum((w) => w.netSales),
      reversals,
      returnRate: grossSales > 0 ? reversals / grossSales : null,
      // Where the stock stood at each end of the range, so the panel can say
      // "down 94 units" without the caller re-deriving it from the series.
      startOnHand: weeks.length ? weeks[0].unitsOnHand : null,
      endOnHand: weeks.length ? weeks[weeks.length - 1].unitsOnHand : null,
    },
  };
}
