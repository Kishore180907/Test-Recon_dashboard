/* =============================================================================
 *  Offline preview fixture — 34 REAL non-POS CLB XXIII orders (Aug 11–17, 2026)
 *  plus 6 representative POS orders, so the dashboard can be demoed before the
 *  Shopify token is wired up. Run with MOCK_DATA=1.
 *
 *  Long fulfillment-photo blocks in order notes are truncated; every other
 *  value is verbatim from the Admin API.
 * ========================================================================== */

// [name, createdAt, src, app, status, customer, netPayment, totalPrice,
//  subtotal, refunded, discounts, note, moments, days, first, last, cancelled]
// visit = [occurredAt, landingPage, referrerUrl, source, sourceDescription,
//          utmSource, utmMedium, utmCampaign]  (null for none)

const V = (a) =>
  a
    ? {
        occurredAt: a[0], landingPage: a[1], referrerUrl: a[2], source: a[3],
        sourceType: null, sourceDescription: a[4],
        utmParameters: a[5] ? { source: a[5], medium: a[6], campaign: a[7], content: null, term: null } : null,
      }
    : null;

/** Stable pseudo-history: 1 to 5 orders, derived from the customer name. */
const CUSTOMER_ORDERS = (name) => {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return (h % 5) + 1;
};

const rows = [
  ['#27003','2026-08-11T04:17:45Z','web','Online Store','VOIDED','Anais Garcia',0,33,0,0,0,null,1,1,
    ['2026-08-11T04:12:39Z','https://www.clb23.com/checkouts/cn/hWNFWBoaPNf1NO4g3uVgLutu/en-do',null,'direct','1st session was direct to your store'],
    ['2026-08-11T04:12:39Z','https://www.clb23.com/checkouts/cn/hWNFWBoaPNf1NO4g3uVgLutu/en-do',null,'direct','1st session was direct to your store'],
    '2026-08-11T04:17:53Z'],
  ['#27004','2026-08-11T05:49:13Z','3890849','Shop','PAID','Charles Vickers',33,33,18,0,0,'',0,null,null,null,null],
  ['#27005','2026-08-11T13:56:09Z','shopify_draft_order','Draft Orders','PAID','Enzo Commeau',600,600,550,0,0,'Credit: Shy',9,29,
    ['2026-07-13T15:26:16Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],
    ['2026-08-11T13:55:21Z','https://www.clb23.com/checkouts/do/461d105ddbb1ed1ecd376100ce49ed46/en-fr',null,'direct','Converted after a direct visit'],null],
  ['#27029','2026-08-11T22:23:17Z','web','Online Store','VOIDED','Fresca Kiley',0,700,0,0,15,null,6,1,
    ['2026-08-10T15:29:47Z','https://www.clb23.com/','https://www.clb23.com/checkouts/cn/hWNFTIY7gDLsF3zqYVjDjUGe/en-us','direct','1st session was direct to your store'],
    ['2026-08-11T22:23:15Z','https://www.clb23.com/checkouts/cn/hWNFWNqsHQXnzQ9NEUJDYFGC/en-us/thank-you',null,'direct','Converted after a direct visit'],
    '2026-08-11T22:23:25Z'],
  ['#27041','2026-08-12T00:04:17Z','web','Online Store','PAID','michael marji',179.65,179.65,150,0,0,'📸 Fulfillment Photo Uploaded (Aug 17, 2026)',1,1,
    ['2026-08-12T00:03:52Z','https://www.clb23.com/products/gallery-dept-grailed-tee-in-grey','https://instagram.com/','Instagram','1st session from Instagram','facebook','paid_social','CLB_Broad_Catalog_AJ_07/31'],
    ['2026-08-12T00:03:52Z','https://www.clb23.com/products/gallery-dept-grailed-tee-in-grey','https://instagram.com/','Instagram','1st session from Instagram','facebook','paid_social','CLB_Broad_Catalog_AJ_07/31'],null],
  ['#27042','2026-08-12T03:49:13Z','3890849','Shop','REFUNDED','Jaden Poydras',0,35.74,0,35.74,0,null,0,null,null,null,'2026-08-12T17:21:09Z'],
  ['#27055','2026-08-12T21:44:26Z','web','Online Store','PAID','Sarah Weber',165,165,150,0,0,'',1,1,
    ['2026-08-12T21:42:39Z','https://www.clb23.com/products/air-jordan-1-low-w-black-university-blue',null,'ChatGPT','1st session from ChatGPT','chatgpt.com','feed',null],
    ['2026-08-12T21:42:39Z','https://www.clb23.com/products/air-jordan-1-low-w-black-university-blue',null,'ChatGPT','1st session from ChatGPT','chatgpt.com','feed',null],null],
  ['#27057','2026-08-12T22:05:41Z','shopify_draft_order','Draft Orders','PAID','Andrew Benavides',200,200,200,0,0,null,3,6,
    ['2026-08-07T00:32:05Z','https://www.clb23.com/cart',null,'an unknown source','1st session from an unknown source','Klaviyo',null,null],
    ['2026-08-12T22:05:09Z','https://shop.app/checkout/56857362521/do/db5a598ecdec5872f6a004f86d114813/en-us/shoppay',null,'direct','Converted after a direct visit'],null],
  ['#27070','2026-08-13T04:52:36Z','web','Online Store','VOIDED','Yo Tu',0,105,0,0,0,null,1,1,
    ['2026-08-13T04:50:12Z','https://www.clb23.com/','https://www.google.com/','Google','1st session from Google'],
    ['2026-08-13T04:50:12Z','https://www.clb23.com/','https://www.google.com/','Google','1st session from Google'],
    '2026-08-13T04:52:43Z'],
  ['#27075','2026-08-13T15:56:21Z','web','Online Store','PAID','Kai Moore',19.41,19.41,18,0,0,'',3,1,
    ['2026-08-13T03:36:43Z','https://www.clb23.com/','https://www.google.com/','Google','1st session from Google'],
    ['2026-08-13T15:53:15Z','https://www.clb23.com/products/supreme-hanes-crew-socks-in-white-1-pair-clbxxiii','https://www.clb23.com/search','direct','Converted after a direct visit'],null],
  ['#27079','2026-08-13T16:32:53Z','web','Online Store','PAID','Avery Lawton',135,135,120,0,0,'',1,1,
    ['2026-08-13T16:31:38Z','https://www.clb23.com/checkouts/cn/hWNFXNed68YGAQ66bmNWbSwE/en','https://www.google.com/','Google','1st session from Google','Klaviyo','email','E3 - Last Chance Test #1'],
    ['2026-08-13T16:31:38Z','https://www.clb23.com/checkouts/cn/hWNFXNed68YGAQ66bmNWbSwE/en','https://www.google.com/','Google','1st session from Google','Klaviyo','email','E3 - Last Chance Test #1'],null],
  ['#27091','2026-08-13T19:27:24Z','web','Online Store','PAID','Dilynn Sydeny',46.36,46.36,43,0,0,null,1,1,
    ['2026-08-13T18:55:46Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],
    ['2026-08-13T18:55:46Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],null],
  ['#27118','2026-08-14T08:32:10Z','web','Online Store','PAID','vardan hakobyan',2083.18,2083.18,1950,0,0,'',2,1,
    ['2026-08-14T04:01:35Z','https://www.clb23.com/products/chrome-hearts-ch-logo-sweatshorts-in-black-clbxxiii','https://instagram.com/','Instagram','1st session from Instagram','facebook','paid_social','CLB_Broad_Catalog_AJ_07/31'],
    ['2026-08-14T08:26:37Z','https://www.clb23.com/products/chrome-hearts-ch-logo-sweatshorts-in-black-clbxxiii','https://instagram.com/','Instagram','Converted after a visit from Instagram','facebook','paid_social','CLB_Broad_Catalog_AJ_07/31'],null],
  ['#27119','2026-08-14T14:40:18Z','3890849','Shop','PAID','sultan forbes(customs)',50,50,35,0,0,'',0,null,null,null,null],
  ['#27170','2026-08-14T21:33:00Z','web','Online Store','PAID','troy tam',340,340,325,0,0,'',1,1,
    ['2026-08-14T21:30:17Z','https://www.clb23.com/products/supreme-box-logo-hooded-sweatshirt-in-orange','https://instagram.com/','Instagram','1st session from Instagram','facebook','paid_social','CLB_Broad_Catalog_AJ_06/19'],
    ['2026-08-14T21:30:17Z','https://www.clb23.com/products/supreme-box-logo-hooded-sweatshirt-in-orange','https://instagram.com/','Instagram','1st session from Instagram','facebook','paid_social','CLB_Broad_Catalog_AJ_06/19'],null],
  ['#27183','2026-08-14T22:33:05Z','web','Online Store','PAID','jayla davis',19.41,19.41,18,0,0,null,2,6,
    ['2026-08-08T20:39:56Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],
    ['2026-08-14T22:24:20Z','https://www.clb23.com/',null,'direct','Converted after a direct visit'],null],
  ['#27186','2026-08-14T22:51:28Z','shopify_draft_order','Draft Orders','PARTIALLY_REFUNDED','Ebay',941.57,955.21,955.21,13.64,44.79,'Credit: Jonathan Rice\nCheck Gmail for shipping label',0,null,null,null,null],
  ['#27206','2026-08-15T02:32:52Z','web','Online Store','PAID','Alissa Pates',46.36,46.36,43,0,0,null,13,19,
    ['2026-07-26T16:40:19Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],
    ['2026-08-15T02:16:49Z','https://www.clb23.com/',null,'direct','Converted after a direct visit'],null],
  ['#27207','2026-08-15T11:51:52Z','web','Online Store','PAID','Christopher Williams JR',120,120,0,0,75,null,7,1,
    ['2026-08-14T04:44:54Z','https://www.clb23.com/products/amiri-slashed-jeans-in-deep-classic-wash',null,'an unknown source','1st session from an unknown source','ig','social','CLB_Broad_Catalog_AJ_07/31'],
    ['2026-08-15T11:50:10Z','https://www.clb23.com/checkouts/cn/hWNFfM1Ej1rVl5smLXMcZNQI/en-us/','https://www.clb23.com/','direct','Converted after a direct visit'],
    '2026-08-17T14:14:45Z'],
  ['#27227','2026-08-15T17:34:15Z','shopify_draft_order','Draft Orders','PAID','Daniel Nwabeke',2245.44,2245.44,2245.44,0,0,'',0,null,null,null,null],
  ['#27232','2026-08-15T17:41:27Z','shopify_draft_order','Draft Orders','PAID','Daniel Nwabeke',2074.56,2074.56,2054.56,0,0,'Credit: Ruby',1,1,
    ['2026-08-15T17:40:35Z','https://www.clb23.com/checkouts/do/0b6ffb3bec9f733417c779bf6645ac8d/en-us',null,'direct','1st session was direct to your store'],
    ['2026-08-15T17:40:35Z','https://www.clb23.com/checkouts/do/0b6ffb3bec9f733417c779bf6645ac8d/en-us',null,'direct','1st session was direct to your store'],null],
  ['04-H02XF04X63','2026-08-15T20:16:47Z','137182019585','StockX','PAID','Harrison',133.84,133.84,133.84,0,0,null,0,null,null,null,null],
  ['#27278','2026-08-15T22:19:12Z','web','Online Store','PAID','Marques Aiken',306.38,306.38,270,0,0,'',7,13,
    ['2026-08-02T16:41:22Z','https://www.clb23.com/products/air-jordan-10-retro-solefly-10th-anniversary','https://facebook.com/','https://facebook.com/','1st session from facebook.com','facebook','paid_social','CLB_Broad_Catalog_AJ_06/19'],
    ['2026-08-15T22:15:40Z','https://www.clb23.com/products/air-jordan-3-retro-og-rare-air','https://facebook.com/','https://facebook.com/','Converted after a visit from facebook.com','facebook','paid_social','CLB_Broad_Catalog_AJ_06/19'],null],
  ['#27302','2026-08-16T05:40:33Z','web','Online Store','PAID','Chelsea Caldwell',0,0,0,0,18,null,3,1,
    ['2026-08-16T01:11:40Z','https://www.clb23.com/pages/customer-experience-survey',null,'email','1st session from an email','Klaviyo','email',null],
    ['2026-08-16T05:37:10Z','https://www.clb23.com/','https://www.google.com/','Google','Converted after a visit from Google'],null],
  ['#27315','2026-08-16T18:01:21Z','web','Online Store','PAID','Jessica Blair',143.38,278.13,133,0,0,null,1,1,
    ['2026-08-16T17:58:54Z','https://www.clb23.com/','https://www.google.com/','Google','1st session from Google'],
    ['2026-08-16T17:58:54Z','https://www.clb23.com/','https://www.google.com/','Google','1st session from Google'],null],
  ['#27323','2026-08-16T18:33:20Z','web','Online Store','PAID','Matthew Glose',277.64,277.64,240,0,0,'',20,8,
    ['2026-08-09T00:17:26Z','https://www.clb23.com/pages/first-sale-sign-up',null,'an unknown source','1st session from an unknown source','ig','paid_social','CLB_Sale_Signup_08/06'],
    ['2026-08-16T18:31:33Z','https://www.clb23.com/','https://shopify.com/','https://shopify.com/','Converted after a visit from shopify.com'],null],
  ['#27327','2026-08-16T19:08:28Z','shopify_draft_order','Draft Orders','PAID','Galyna Kuznietsova',1500,1500,1500,0,120,'Credit: JR',8,27,
    ['2026-07-21T04:22:43Z','https://www.clb23.com/products/chrome-hearts-triple-cross-ch-flocked-sweatpants-in-black-clbxxiii',null,'direct','1st session was direct to your store'],
    ['2026-08-16T19:08:05Z','https://shop.app/checkout/56857362521/do/9ea2b0fdbfa563703cba910459af000a/en-gb/shoppay','https://mail.google.com/','email','Converted after a visit from an email'],null],
  ['#27333','2026-08-16T19:21:10Z','shopify_draft_order','Draft Orders','PAID','KT Eric',3085,3085,3085,0,373.18,'Credit to Erik\n\n📸 Fulfillment Photo Uploaded (Aug 16, 2026)',1,1,
    ['2026-08-16T19:20:26Z','https://shop.app/checkout/56857362521/do/f5963ff3f831ab120752a1f8d4af7a09/en-gb/shoppay',null,'direct','1st session was direct to your store'],
    ['2026-08-16T19:20:26Z','https://shop.app/checkout/56857362521/do/f5963ff3f831ab120752a1f8d4af7a09/en-gb/shoppay',null,'direct','1st session was direct to your store'],null],
  ['#27334','2026-08-16T19:26:03Z','shopify_draft_order','Draft Orders','PAID','KT Eric',1400,1400,1400,0,283.18,'Credit to Erik',1,1,
    ['2026-08-16T19:21:19Z','https://www.clb23.com/','https://www.clb23.com/checkouts/do/f5963ff3f831ab120752a1f8d4af7a09/en-gb/thank-you','direct','1st session was direct to your store'],
    ['2026-08-16T19:21:19Z','https://www.clb23.com/','https://www.clb23.com/checkouts/do/f5963ff3f831ab120752a1f8d4af7a09/en-gb/thank-you','direct','1st session was direct to your store'],null],
  ['#27374','2026-08-16T23:39:19Z','web','Online Store','PAID','Delaquan Brookshire',144.11,144.11,120,0,0,'',1,1,
    ['2026-08-16T23:37:05Z','https://www.clb23.com/collections/blind-love','https://www.google.com/','Google','1st session from Google'],
    ['2026-08-16T23:37:05Z','https://www.clb23.com/collections/blind-love','https://www.google.com/','Google','1st session from Google'],null],
  ['#27375','2026-08-17T02:23:44Z','web','Online Store','PAID','Jonathan Harnisch',4000,4000,4000,0,133.18,'',5,1,
    ['2026-08-08T16:10:11Z','https://www.clb23.com/','https://www.clb23.com/checkouts/cn/hWNFQIUYH854FplYb2OcHoUa/en-us/thank-you','direct',null],
    ['2026-08-17T02:15:38Z','https://www.clb23.com/products/chrome-hearts-vertical-logo-hat-in-black','https://facebook.com/','https://facebook.com/','1st session from facebook.com','fb','paid_social','CLB_Sales_LV_ P9 _40_07/16'],null],
  ['#27376','2026-08-17T03:51:18Z','web','Online Store','PAID','Jeramey Weise',320,320,320,0,15,'',1,1,
    ['2026-08-17T03:47:45Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],
    ['2026-08-17T03:47:45Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],null],
  ['#27394','2026-08-17T19:07:44Z','3890849','Shop','PAID','Jasmine Davis',53.16,53.16,36,0,0,null,0,null,null,null,null],
  ['#27415','2026-08-17T22:51:31Z','web','Online Store','PAID','Javana Bradford',134.75,134.75,125,0,0,'Credit: Ruby',1,1,
    ['2026-08-17T22:48:17Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],
    ['2026-08-17T22:48:17Z','https://www.clb23.com/',null,'direct','1st session was direct to your store'],null],

  // --- representative POS orders (excluded from all three panels) -----------
  ['#27412','2026-08-17T22:32:50Z','pos','Point of Sale','PAID','Walk-in',26.95,26.95,25,0,0,null,0,null,null,null,null],
  ['#27413','2026-08-17T22:45:44Z','pos','Point of Sale','PAID','Walk-in',58.22,58.22,54,0,0,null,0,null,null,null,null],
  ['#27414','2026-08-17T22:48:49Z','pos','Point of Sale','PAID','Walk-in',38.44,38.44,36,0,0,null,0,null,null,null,null],
  ['#27416','2026-08-17T22:53:49Z','pos','Point of Sale','PAID','Walk-in',53.91,53.91,50,0,0,null,0,null,null,null,null],
  ['#27300','2026-08-16T18:10:00Z','pos','Point of Sale','PAID','Walk-in',412.5,412.5,375,0,0,null,0,null,null,null,null],
  ['#27250','2026-08-15T19:02:00Z','pos','Point of Sale','PAID','Walk-in',188.1,188.1,171,0,0,null,0,null,null,null,null],
];

const CHANNELS = {
  web: { handle: 'web', channelName: 'Online Store', subChannelName: 'Online Store' },
  pos: { handle: 'pos', channelName: 'Point of Sale', subChannelName: 'Point of Sale' },
  '3890849': { handle: 'shop', channelName: 'Shop', subChannelName: 'Shop' },
};

export const SAMPLE_ORDERS = rows.map((r, i) => {
  const [name, createdAt, src, app, status, customer, net, total, sub, ref, disc,
    note, moments, days, first, last, cancelled] = r;
  return {
    id: `gid://shopify/Order/900000000${String(i).padStart(3, '0')}`,
    name,
    createdAt,
    updatedAt: createdAt,
    cancelledAt: cancelled || null,
    test: false,
    note,
    tags: [],
    sourceName: src,
    app: { name: app },
    channelInformation: CHANNELS[src] ? { channelDefinition: CHANNELS[src] } : null,
    retailLocation: src === 'pos' ? { name: 'Kenwood Towne Centre' } : null,
    physicalLocation: src === 'pos' ? { name: 'Kenwood Towne Centre' } : null,
    displayFinancialStatus: status,
    /* Repeat customers, so the offline preview exercises the ordinal sub-line
     * rather than showing "first order" on every row. Deterministic from the
     * name so a given customer keeps the same history across runs. */
    customer: {
      displayName: customer,
      numberOfOrders: String(CUSTOMER_ORDERS(customer)),
      amountSpent: { amount: String(CUSTOMER_ORDERS(customer) * 480), currencyCode: 'USD' },
    },
    netPaymentSet: { shopMoney: { amount: String(net), currencyCode: 'USD' } },
    totalPriceSet: { shopMoney: { amount: String(total) } },
    currentSubtotalPriceSet: { shopMoney: { amount: String(sub) } },
    totalRefundedSet: { shopMoney: { amount: String(ref) } },
    totalDiscountsSet: { shopMoney: { amount: String(disc) } },
    customerJourneySummary: {
      ready: true,
      momentsCount: { count: moments, precision: 'EXACT' },
      customerOrderIndex: CUSTOMER_ORDERS(customer),
      daysToConversion: days,
      firstVisit: V(first),
      lastVisit: V(last),
    },
  };
});
