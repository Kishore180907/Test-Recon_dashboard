/* =============================================================================
 *  Offline preview fixture — Shopify Analytics' own sales_channel report.
 *  Run with MOCK_DATA=1.
 *
 *  These are the REAL August 2026 figures from the live store, kept verbatim
 *  because the interesting property is one nobody would invent: Shopify reports
 *  a "Shopify Mobile for iPhone" channel worth $56,636 across 17 orders, and
 *  those same orders come back from the Admin API as ordinary draft orders
 *  (sourceName 'shopify_draft_order', app 'Draft Orders'). The device that
 *  created them is not in the order payload at all.
 *
 *  That single channel is the entire difference between the dashboard's
 *  Ecommerce tile and Shopify's E-Commerce line, which is why this reference
 *  row exists and why it is fetched rather than derived.
 *
 *  net_sales here is Shopify's definition: gross − discounts − returns, BEFORE
 *  shipping and tax, counting unpaid draft invoices at full value. It is NOT
 *  the tiles' netPayment (cash collected). The two must never be summed.
 * ========================================================================== */

const AUGUST_2026 = [
  { channel: 'Point of Sale', orders: 1145, netSales: 218866.6 },
  { channel: 'Draft Orders', orders: 18, netSales: 58117.06 },
  { channel: 'Shopify Mobile for iPhone', orders: 17, netSales: 56636 },
  { channel: 'Online Store', orders: 86, netSales: 43941.08 },
  { channel: 'Shop', orders: 23, netSales: 5849.43 },
  { channel: 'StockX', orders: 12, netSales: 1698.14 },
  { channel: 'Meta', orders: 1, netSales: 0 },
];

const channelClass = (name) => {
  const s = String(name ?? '').trim().toLowerCase();
  if (s.startsWith('point of sale')) return 'pos';
  if (s.startsWith('draft orders')) return 'draft';
  return 'ecommerce';
};

const tally = (list) =>
  list.reduce(
    (a, c) => ({ orders: a.orders + c.orders, netSales: a.netSales + c.netSales }),
    { orders: 0, netSales: 0 },
  );

/**
 * Mirrors fetchChannelSales(). The window is ignored — the fixture always
 * returns the August shape, which is what the tests assert against.
 */
/* Per-order channels, copied from the live August 2026 ShopifyQL response.
 * The Shopify Mobile entries are the interesting ones: the Admin API reports
 * every one of these as a plain draft order, so without this overlay the table
 * would label them "Draft Orders". Order numbers match sample-orders.js where
 * they overlap; the rest exercise the map's fall-through. */
const ORDER_CHANNELS = [
  ['#27790', 'Shopify Mobile for iPhone'],
  ['#26897', 'Shopify Mobile for iPhone'],
  ['#26684', 'Shopify Mobile for iPhone'],
  ['#27530', 'Shopify Mobile for iPhone'],
  ['#26648', 'Shopify Mobile for iPhone'],
  ['#26686', 'Shopify Mobile for iPhone'],
  ['#27875', 'Shopify Mobile for iPhone'],
  ['#27333', 'Shopify Mobile for iPhone'],
  ['#27327', 'Shopify Mobile for iPhone'],
  ['#27334', 'Shopify Mobile for iPhone'],
  ['#26826', 'Shopify Mobile for iPhone'],
  ['#26840', 'Shopify Mobile for iPhone'],
  ['#27005', 'Shopify Mobile for iPhone'],
  ['#26751', 'Shopify Mobile for iPhone'],
  ['#27757', 'Shopify Mobile for iPhone'],
  ['#27703', 'Shopify Mobile for iPhone'],
  ['#27580', 'Shopify Mobile for iPhone'],
  ['#27806', 'Draft Orders'],
  ['#27227', 'Draft Orders'],
  ['#27739', 'Online Store'],
  ['#27843', 'Online Store'],
  ['#27870', 'Online Store'],
  ['#27867', 'Online Store'],
  ['#26925', 'Shop'],
  ['#27844', 'Shop'],
  ['#27632', 'Point of Sale'],
  ['04-EEA1P1YY1V', 'StockX'],
];

/** Mirrors fetchOrderChannels(): order name -> Shopify's sales channel. */
export function SAMPLE_ORDER_CHANNELS() {
  return new Map(ORDER_CHANNELS);
}

export function SAMPLE_CHANNELS() {
  const channels = AUGUST_2026.slice().sort((a, b) => b.netSales - a.netSales);
  const of = (kind) => channels.filter((c) => channelClass(c.channel) === kind);
  const mobileRows = channels.filter((c) => /^shopify mobile/i.test(c.channel));
  return {
    channels,
    ecommerce: tally(of('ecommerce')),
    draft: tally(of('draft')),
    pos: tally(of('pos')),
    mobile: {
      ...tally(mobileRows),
      label: mobileRows[0]?.channel || 'Shopify Mobile',
      present: mobileRows.length > 0,
    },
  };
}
