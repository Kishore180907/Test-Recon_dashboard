/* =============================================================================
 *  Offline preview fixture for the sell-through panel. Run with MOCK_DATA=1.
 *
 *  These are REAL figures, pulled from the live store on 2026-09-22 via
 *  ShopifyQL, trimmed to the brands worth exercising. Invented numbers would
 *  have hidden the thing that mattered most here: the gap between lifetime and
 *  30-day sell-through on a book this deep. Chrome Hearts really does sit at
 *  68.8% lifetime and 7.9% over thirty days, with $1.69M still on the shelf.
 * ========================================================================== */

import { shapeBrands, windowStart, STR_WINDOWS } from '../lib/sellthrough.js';

// [vendor, endingUnits, unitsSold, sellThroughRate, daysRemaining, endingValue]
const LIFETIME = [
  ['Chrome Hearts', 662, 1459, 0.6879, 348, 1686087.08],
  ['Louis Vuitton', 876, 507, 0.3666, 496, 1459480.60],
  ['Nike', 2255, 4960, 0.6875, 384, 575935.28],
  ['Air Jordan', 2884, 7501, 0.7223, 333, 571285.08],
  ['Amiri', 352, 290, 0.4517, 406, 211251.96],
  ['Supreme', 965, 3788, 0.7970, 71, 71074.34],
  ['Vale', 375, 907, 0.7075, 305, 46202.15],
  ['Godspeed', 200, 561, 0.7372, 351, 22338.18],
  ['Bravest Studios', 389, 1587, 0.8031, 131, 15973.02],
  ['Adidas', 449, 1434, 0.7616, 210, 14280.00],
  ['CLB XXIII', 272, 950, 0.7774, 452, 4197.85],
  ['YZY', 23, 409, 0.9468, 38, 1210.04],
  ['Fear of God Essentials', 68, 843, 0.9254, 29, 3120.00],
  ['Popmart', 0, 783, 1.0, 0, 0],
  ['', 41, 96, 0.7007, 120, 10183.66],
];

// 30-day window, same store, same day. The rates collapse because a month of
// sales is small next to the shelf — the whole reason the panel keeps the two
// numbers apart.
const W30 = [
  ['Chrome Hearts', 591, 51, 0.0794, 348],
  ['Louis Vuitton', 645, 39, 0.0570, 496],
  ['Nike', 1012, 79, 0.0724, 384],
  ['Air Jordan', 1189, 107, 0.0826, 333],
  ['Amiri', 338, 25, 0.0689, 406],
  ['Supreme', 959, 407, 0.2980, 71],
  ['Vale', 356, 35, 0.0895, 305],
  ['Godspeed', 199, 17, 0.0787, 351],
  ['Bravest Studios', 301, 69, 0.1865, 131],
  ['Adidas', 380, 44, 0.1038, 210],
  ['CLB XXIII', 256, 17, 0.0623, 452],
  ['YZY', 23, 18, 0.4390, 38],
  ['Fear of God Essentials', 61, 52, 0.4602, 29],
  ['Popmart', 0, 12, 1.0, 0],
  ['', 41, 9, 0.1800, 120],
];

const scale = (rows, factor) => rows.map(([v, onHand, sold, rate, days]) => {
  const s = Math.round(sold * factor);
  const r = s + onHand > 0 ? s / (s + onHand) : 0;
  return [v, onHand, s, Number(r.toFixed(4)), days];
});

// [vendor, grossSales, netSales, reversals, discounts] over the 90-day window.
const SALES = [
  ['Chrome Hearts', 369370.47, 306102.40, -44742.55, -18525.52],
  ['Air Jordan', 164774.61, 154928.61, -6441.94, -3404.06],
  ['Louis Vuitton', 136834.23, 115806.57, -4170.00, -16857.66],
  ['Nike', 78200.90, 72292.83, -2320.00, -3588.07],
  ['Supreme', 55990.37, 50246.13, -1828.00, -3916.24],
  ['Vale', 25018.65, 23477.45, -895.00, -646.20],
  ['Amiri', 23300.00, 19065.96, -2665.00, -1569.04],
  ['Bravest Studios', 21300.00, 20741.23, -240.00, -318.77],
  ['Godspeed', 10540.00, 10164.00, -170.00, -206.00],
  ['Adidas', 9800.00, 9420.00, -180.00, -200.00],
  ['YZY', 16900.00, 15940.00, 0, -960.00],
  ['CLB XXIII', 3100.00, 2980.00, -40.00, -80.00],
  ['Fear of God Essentials', 8400.00, 8120.00, -120.00, -160.00],
  ['Popmart', 2400.00, 2400.00, 0, 0],
  ['', 8758.24, 10183.66, 1730.84, -305.42],
];

const inv = (rows) => rows.map(([v, onHand, sold, rate, days, value]) => ({
  product_vendor: v,
  ending_inventory_units: onHand,
  inventory_units_sold: sold,
  sell_through_rate: rate,
  days_of_inventory_remaining: days,
  ending_inventory_value: value ?? 0,
}));

const sal = (rows) => rows.map(([v, gross, net, rev, disc]) => ({
  product_vendor: v,
  gross_sales: gross,
  net_sales: net,
  sales_reversals: rev,
  discounts: disc,
}));

export function SAMPLE_SELLTHROUGH(end = '2026-09-22') {
  return shapeBrands({
    lifetimeRows: inv(LIFETIME),
    windows: {
      30: inv(W30),
      // 60 and 90 are the 30-day shape scaled up — enough to exercise the
      // window switch without inventing a second month of real history.
      60: inv(scale(W30, 1.9)),
      90: inv(scale(W30, 2.7)),
    },
    salesRows: sal(SALES),
    end,
    salesSince: windowStart(end, Math.max(...STR_WINDOWS)),
  });
}
