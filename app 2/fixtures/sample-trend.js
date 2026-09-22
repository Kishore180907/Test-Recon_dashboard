/* =============================================================================
 *  Offline preview fixture for the per-brand chart. Run with MOCK_DATA=1.
 *
 *  Chrome Hearts is real — thirteen weeks pulled live on 2026-09-22, and worth
 *  keeping verbatim because it is the shape the chart exists to show: a stock
 *  line that falls from 684 to 590 over a quarter while the sell-through
 *  percentage in the table reads a comfortable 68.8%.
 *
 *  Any other brand gets a deterministic series derived from its name, so the
 *  offline panel stays clickable on every row without inventing a second set
 *  of plausible-looking numbers that someone might later mistake for data.
 * ========================================================================== */

import { shapeTrend, TREND_DAYS, NO_BRAND } from '../lib/brandtrend.js';
import { windowStart } from '../lib/sellthrough.js';

// [week, endingUnits, unitsSold, rate]
const CHROME_HEARTS_INV = [
  ['2026-06-22', 684, 3, 0.0044],
  ['2026-06-29', 672, 35, 0.0495],
  ['2026-07-06', 655, 22, 0.0325],
  ['2026-07-13', 652, 14, 0.0210],
  ['2026-07-20', 644, 16, 0.0242],
  ['2026-07-27', 635, 20, 0.0305],
  ['2026-08-03', 628, 17, 0.0264],
  ['2026-08-10', 611, 16, 0.0255],
  ['2026-08-17', 611, 14, 0.0224],
  ['2026-08-24', 597, 12, 0.0197],
  ['2026-08-31', 617, 12, 0.0191],
  ['2026-09-07', 615, 7, 0.0113],
  ['2026-09-14', 608, 13, 0.0209],
  ['2026-09-21', 590, 5, 0.0084],
];

// [week, gross, net, reversals]
const CHROME_HEARTS_SALES = [
  ['2026-06-22', 9800, 9782.69, 0],
  ['2026-06-29', 44019.16, 31804.08, -10586.67],
  ['2026-07-06', 31830, 27365.43, -2750],
  ['2026-07-13', 44075.88, 29513.50, -12030.88],
  ['2026-07-20', 12435, 6171.75, -6185],
  ['2026-07-27', 35455, 28212.25, -6000],
  ['2026-08-03', 40003.78, 31215.21, -5775],
  ['2026-08-10', 22575, 21143.96, -700],
  ['2026-08-17', 17585, 17107, 0],
  ['2026-08-24', 57990, 53025.91, 0],
  ['2026-08-31', 10460, 10066.44, 0],
  ['2026-09-07', 14550, 14374.10, 0],
  ['2026-09-14', 23941.65, 22010.08, -715],
  ['2026-09-21', 4650, 4310, 0],
];

const inv = (rows) => rows.map(([week, onHand, sold, rate]) => ({
  week,
  ending_inventory_units: onHand,
  inventory_units_sold: sold,
  sell_through_rate: rate,
}));

const sal = (rows) => rows.map(([week, gross, net, rev]) => ({
  week,
  gross_sales: gross,
  net_sales: net,
  sales_reversals: rev,
}));

/** Stable small integer from a string, so a given brand always draws the same. */
const seedOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return h;
};

function derived(brand) {
  const seed = seedOf(brand);
  const weeks = CHROME_HEARTS_INV.map(([week], i) => week);
  let onHand = 40 + (seed % 400);
  const invRows = [];
  const salesRows = [];
  for (let i = 0; i < weeks.length; i += 1) {
    const sold = Math.max(0, ((seed + i * 17) % 23) - 3);
    onHand = Math.max(0, onHand - sold + ((seed + i) % 5));
    invRows.push({
      week: weeks[i],
      ending_inventory_units: onHand,
      inventory_units_sold: sold,
      sell_through_rate: sold + onHand > 0 ? Number((sold / (sold + onHand)).toFixed(4)) : 0,
    });
    const gross = sold * (60 + (seed % 900));
    salesRows.push({
      week: weeks[i],
      gross_sales: gross,
      net_sales: Math.round(gross * 0.92 * 100) / 100,
      sales_reversals: i % 4 === 0 ? -Math.round(gross * 0.06 * 100) / 100 : 0,
    });
  }
  return { invRows, salesRows };
}

export function SAMPLE_TREND(brand, end = '2026-09-22') {
  if (brand === NO_BRAND) return { brand, end, weeks: [], unavailable: 'no-vendor' };

  const since = windowStart(end, TREND_DAYS);
  const rows = brand === 'Chrome Hearts'
    ? { invRows: inv(CHROME_HEARTS_INV), salesRows: sal(CHROME_HEARTS_SALES) }
    : derived(brand);

  return shapeTrend({ brand, end, since, ...rows });
}
