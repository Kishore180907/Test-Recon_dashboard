/* =============================================================================
 *  ECOMMERCE CHANNEL GROUPING
 *  ---------------------------------------------------------------------------
 *  The rule that turns drill-down rows into the lines drawn by the "Ecommerce
 *  by channel" chart. It lives in its own module rather than inside the page's
 *  inline script so the test suite can import it directly — the folding, the
 *  colour assignment and the label fallbacks all have edge cases that are worth
 *  asserting somewhere other than a browser.
 *
 *  Served straight out of /public, so the page imports it as "/channels.js".
 * ========================================================================== */

/** Seven named channels plus "Other" fills the eight categorical slots. */
export const CH_MAX_SERIES = 7;

/** The validated categorical palette, by CSS custom property. Both themes
 *  define these; see the palette block in index.html for the hexes and what
 *  they were checked against. Assigned in fixed order, never cycled. */
export const CH_CAT = [
  'var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)',
  'var(--cat-5)', 'var(--cat-6)', 'var(--cat-7)', 'var(--cat-8)',
];

/**
 * The channel a row belongs to, named the way the bucketing reasoned about it.
 *
 * Two fallbacks matter:
 *
 *  - An eBay order normally has NO sales channel. It arrives as a hand-written
 *    draft against the "Ebay" customer, so the Admin API calls its app "Draft
 *    Orders". Without the first branch the Ecommerce breakdown would draw a
 *    line labelled "Draft Orders" — a draft, inside the ecommerce chart.
 *  - A bare "Draft Orders" names an app, not a sales channel, so it is not a
 *    useful label here either and becomes "Unattributed".
 *
 * Rows synced before the channel map existed have neither field and are also
 * grouped as "Unattributed" rather than dropped: a missing channel is a fact
 * about the data, not a reason to understate a day.
 */
export function chLabel(o) {
  if (o?.fromEbay) return 'eBay';
  const real = (o?.salesChannel || '').trim();
  if (real) return real;
  const own = (o?.channelName || '').trim();
  if (!own || /^draft orders$/i.test(own)) return 'Unattributed';
  return own;
}

/**
 * Rows -> series[], each carrying one value per day for the chosen measure.
 *
 * Colour is bound to the CHANNEL, not to its rank in the current measure.
 * Slot assignment always ranks by order count, which does not change when the
 * Orders/Revenue toggle flips — otherwise eBay would be green on one view and
 * orange on the other purely because it sells fewer, larger orders, and the
 * reader would have to re-learn the legend on every click. The "Other" fold is
 * decided on that same stable ranking, so its membership cannot change either.
 *
 * @param {Array}  orders  drill-down rows, each with {day, netSale, ...}
 * @param {Array}  days    the days to plot, in order
 * @param {string} metric  'orders' | 'revenue'
 */
export function channelSeries(orders, days, metric) {
  const inRange = new Set(days);
  const byChannel = new Map();

  for (const o of orders) {
    if (!inRange.has(o.day)) continue;
    const name = chLabel(o);
    if (!byChannel.has(name)) {
      byChannel.set(name, { name, count: 0, revenue: 0, perDay: new Map() });
    }
    const c = byChannel.get(name);
    c.count += 1;
    c.revenue += o.netSale || 0;
    const cell = c.perDay.get(o.day) || { count: 0, revenue: 0 };
    cell.count += 1;
    cell.revenue += o.netSale || 0;
    c.perDay.set(o.day, cell);
  }

  // Stable ranking: order count, then name so ties never wobble between runs.
  const ranked = [...byChannel.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const keep = ranked.slice(0, CH_MAX_SERIES);
  const tail = ranked.slice(CH_MAX_SERIES);

  if (tail.length) {
    const other = { name: `Other (${tail.length})`, count: 0, revenue: 0, perDay: new Map() };
    for (const c of tail) {
      other.count += c.count;
      other.revenue += c.revenue;
      for (const [d, cell] of c.perDay) {
        const acc = other.perDay.get(d) || { count: 0, revenue: 0 };
        acc.count += cell.count;
        acc.revenue += cell.revenue;
        other.perDay.set(d, acc);
      }
    }
    keep.push(other);
  }

  const pick = metric === 'revenue' ? 'revenue' : 'count';
  return keep
    .map((c, i) => ({
      name: c.name,
      color: CH_CAT[i],           // slot fixed by the stable ranking above
      total: c[pick],
      points: days.map((d) => (c.perDay.get(d) || { count: 0, revenue: 0 })[pick]),
    }))
    // Draw order follows the current measure so the biggest line sits on top,
    // but each series keeps the colour its channel was assigned.
    .sort((a, b) => b.total - a.total);
}
