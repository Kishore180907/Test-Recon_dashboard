/* =============================================================================
 *  Offline preview fixture — full customer journeys for a few of the orders in
 *  sample-orders.js. Run with MOCK_DATA=1.
 *
 *  Shapes are taken from real journeys on this store, because the interesting
 *  cases are ones nobody would think to invent:
 *
 *    #27005  a draft order whose first and last click are both Direct, with a
 *            PAID Google Ads click (medium=cpc) buried in the middle. This is
 *            the case the drawer exists for. Modelled on live order #27790.
 *    #27206  a dozen near-identical Instagram sessions minutes apart, which is
 *            what the collapsing is for. Modelled on live order #27695.
 *    #27323  a genuinely mixed journey: paid social, then Klaviyo email.
 *    #27029  the boring case, one session, so the drawer stays honest about
 *            orders where there is nothing to reveal.
 * ========================================================================== */

// [occurredAt, landingPage, referrerUrl, source, sourceDescription,
//  utmSource, utmMedium, utmCampaign]
const M = (a) => ({
  occurredAt: a[0],
  landingPage: a[1],
  referrerUrl: a[2],
  source: a[3],
  sourceType: null,
  sourceDescription: a[4],
  utmParameters: a[5] ? { source: a[5], medium: a[6], campaign: a[7], content: null, term: null } : null,
});

const HOME = 'https://www.clb23.com/';
const SHORTS = 'https://www.clb23.com/products/chrome-hearts-matty-boy-patch-shorts';
const INVOICE = 'https://www.clb23.com/checkouts/do/f436b4900de70f2c5b33c11b69ddb974/en-us';

export const SAMPLE_JOURNEYS = {
  /* Draft order. Both endpoints Direct; a Google Ads click on the 14th. */
  'gid://shopify/Order/900000000002': {
    id: 'gid://shopify/Order/900000000002',
    orderNumber: '#27005',
    createdAt: '2026-08-11T13:56:09Z',
    note: 'Credit: Shy',
    netPayment: 600,
    currency: 'USD',
    ready: true,
    touchpoints: 9,
    daysToConversion: 29,
    customerName: 'Enzo Commeau',
    customerOrders: 4,
    customerSpend: 50270,
    /* Modelled on live order #27790: a high-value customer dormant for over a
     * year, back after a paid click. The order count alone would not show that. */
    previousOrder: {
      orderNumber: '#16008',
      createdAt: '2025-06-18T20:23:27Z',
      netPayment: 16500,
      currency: 'USD',
      adminUrl: 'https://admin.shopify.com/store/clb-xxiii/orders/16008',
    },
    moments: [
      M(['2026-07-13T15:26:16Z', HOME, null, 'direct', '1st session was direct to your store']),
      M(['2026-07-13T18:02:44Z', HOME, null, 'direct', null]),
      M(['2026-07-14T02:11:09Z', SHORTS, 'https://www.clb23.com/search', 'direct', null]),
      M(['2026-08-06T02:47:15Z', SHORTS, 'https://www.google.com/', 'Google', null,
         'google', 'product_sync', 'sag_organic']),
      M(['2026-08-09T18:30:02Z', HOME, null, 'direct', null]),
      M(['2026-08-10T04:41:42Z', SHORTS, 'https://www.google.com/', 'Google', null,
         'google', 'cpc', '24053064435']),
      M(['2026-08-10T14:40:42Z', HOME, null, 'direct', null]),
      M(['2026-08-11T13:20:11Z', INVOICE, null, 'direct', null]),
      M(['2026-08-11T13:55:21Z', INVOICE, null, 'direct', 'Converted after a direct visit']),
    ],
  },

  /* Twelve Instagram sessions, most of them seconds apart. */
  'gid://shopify/Order/900000000017': {
    id: 'gid://shopify/Order/900000000017',
    orderNumber: '#27206',
    createdAt: '2026-08-14T22:32:10Z',
    note: '',
    netPayment: 46.36,
    currency: 'USD',
    ready: true,
    touchpoints: 13,
    daysToConversion: 2,
    customerName: 'Marques Aiken',
    customerOrders: 2,
    customerSpend: 352.72,
    previousOrder: {
      orderNumber: '#27102',
      createdAt: '2026-08-02T14:10:00Z',
      netPayment: 306.36,
      currency: 'USD',
      adminUrl: 'https://admin.shopify.com/store/clb-xxiii/orders/27102',
    },
    moments: [
      ...['02:25:20', '02:26:05', '02:27:08', '02:28:22', '02:29:09', '02:29:29'].map((t) =>
        M([`2026-08-13T${t}Z`, SHORTS, 'https://instagram.com/', 'Instagram', null,
           'facebook', 'paid_social', 'CLB_Broad_Catalog_AJ_06/19'])),
      M(['2026-08-13T18:25:59Z', HOME, 'https://instagram.com/', 'Instagram', null,
         'facebook', 'paid_social', 'CLB_Broad_Catalog_AJ_06/19']),
      M(['2026-08-14T09:54:04Z', HOME, null, 'direct', null]),
      ...['09:54:25', '09:56:53', '09:58:50'].map((t) =>
        M([`2026-08-14T${t}Z`, SHORTS, 'https://instagram.com/', 'Instagram', null,
           'facebook', 'paid_social', 'CLB_Broad_Catalog_AJ_06/19'])),
      M(['2026-08-14T22:30:00Z', HOME, null, 'direct', 'Converted after a direct visit']),
    ],
  },

  /* Paid social into email. Both channels really contributed. */
  'gid://shopify/Order/900000000025': {
    id: 'gid://shopify/Order/900000000025',
    orderNumber: '#27323',
    createdAt: '2026-08-16T18:33:00Z',
    note: '',
    netPayment: 277.64,
    currency: 'USD',
    ready: true,
    touchpoints: 20,
    daysToConversion: 8,
    moments: [
      M(['2026-08-09T00:17:26Z', HOME, null, 'an unknown source', '1st session from Instagram',
         'ig', 'paid_social', 'CLB_Sale_Signup_08/06']),
      M(['2026-08-09T01:25:54Z', HOME, null, 'direct', null,
         'ig', 'paid_social', 'CLB_Sale_Signup_08/06']),
      M(['2026-08-12T08:57:29Z', HOME, null, 'direct', null]),
      M(['2026-08-15T12:37:11Z', HOME, null, 'email', null, 'Klaviyo', 'email', null]),
      M(['2026-08-15T15:34:50Z', HOME, null, 'email', null,
         'Klaviyo', 'email', 'CLB_Sale_Signup_08/06']),
      M(['2026-08-16T18:28:38Z', HOME, null, 'direct', 'Converted after a direct visit']),
    ],
  },

  /* One session. Nothing hidden, and the drawer should say so. */
  'gid://shopify/Order/900000000003': {
    id: 'gid://shopify/Order/900000000003',
    orderNumber: '#27029',
    createdAt: '2026-08-11T22:23:17Z',
    note: '',
    netPayment: 0,
    currency: 'USD',
    ready: true,
    touchpoints: 6,
    daysToConversion: 1,
    customerName: 'Fresca Kiley',
    customerOrders: 1,
    customerSpend: 0,
    previousOrder: null,
    moments: [
      M(['2026-08-10T15:29:47Z', HOME, null, 'direct', '1st session was direct to your store']),
    ],
  },
};
