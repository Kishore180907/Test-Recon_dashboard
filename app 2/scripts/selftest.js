/* Sanity checks on storage + bucketing. Run:  npm run check
 * Uses the bundled fixture and the local filesystem blob backend, so it needs
 * no Shopify credentials and no Netlify. */

process.env.MOCK_DATA = '1';
process.env.LOCAL_BLOBS = '1';
process.env.SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || 'clb-xxiii.myshopify.com';
process.env.STORE_TIMEZONE = process.env.STORE_TIMEZONE || 'America/New_York';

import fs from 'node:fs/promises';
import path from 'node:path';

// Fresh store for every run.
await fs.rm(path.join(process.cwd(), '.blobs'), { recursive: true, force: true });

const { fetchOrdersPage } = await import('../lib/shopify.js');
const { fetchCampaignInsights, campaignKey } = await import('../lib/meta.js');
const {
  upsertOrders, readOrders, readPosTotals, monthsBetween,
  upsertMetaInsights, readMetaInsights,
  setWatermark, getWatermark, acquireLock, releaseLock,
} = await import('../lib/repo.js');
const { buildPayload } = await import('../lib/payload.js');
const { isPOS, isDraft, isAssisted, isMarketingTouched, bucketOf, isEcommerceChannel, deviceLabel, isEbayOrder, isMobileAppChannel } = await import('../lib/classify.js');
const { localDateOf } = await import('../lib/timezone.js');
const auth = await import('../lib/auth.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const near = (a, b) => Math.abs(a - b) < 0.005;

/* ---- seed storage exactly the way the backfill does ---------------------- */
const page = await fetchOrdersPage({ q: '', after: null, pageSize: 250 });
const merged = await upsertOrders(page.orders);
await setWatermark({ lastSyncAt: Date.now(), lastSyncISO: new Date().toISOString(), by: 'test' });

check('fixture loaded', page.orders.length > 0, `${page.orders.length} orders`);
check('POS orders are collapsed, not stored whole', merged.pos > 0, `${merged.pos} POS`);
check('non-POS orders are stored whole', merged.nonPos > 0, `${merged.nonPos} non-POS`);

/* ---- idempotency: re-syncing the same page must not double anything ------ */
const before = await readPosTotals('2026-08-01', '2026-08-31');
await upsertOrders(page.orders);
const after = await readPosTotals('2026-08-01', '2026-08-31');
check('re-syncing the same orders does not double POS revenue',
  near(before.revenue, after.revenue), `${before.revenue.toFixed(2)} vs ${after.revenue.toFixed(2)}`);

const reread = await readOrders('2026-08-01', '2026-08-31');
check('re-syncing the same orders does not duplicate non-POS orders',
  reread.length === new Set(reread.map((o) => o.id)).size);

/* ---- multi-batch upsert: the backfill writes one page at a time ----------- */
// Regression guard: a stale read during the read-modify-write on a month shard
// silently drops everything the earlier pages added. Split the fixture into
// batches and assert every order survives.
{
  await fs.rm(path.join(process.cwd(), '.blobs', 'orders'), { recursive: true, force: true });
  const all = page.orders;
  const size = Math.ceil(all.length / 4);
  for (let i = 0; i < all.length; i += size) {
    await upsertOrders(all.slice(i, i + size));
  }
  const stored = await readOrders('2026-01-01', '2026-12-31');
  const expected = all.filter((o) => !o.test && !isPOS(o)).length;
  check('every order survives a page-by-page backfill',
    stored.length === expected, `${stored.length} stored vs ${expected} expected`);

  const posAfter = await readPosTotals('2026-01-01', '2026-12-31');
  const posExpected = all.filter((o) => !o.test && isPOS(o))
    .reduce((sum, o) => sum + o.netPayment, 0);
  check('POS day-totals survive a page-by-page backfill',
    near(posAfter.revenue, posExpected), `${posAfter.revenue.toFixed(2)} vs ${posExpected.toFixed(2)}`);
}

/* ---- Meta Ads insights ---------------------------------------------------- */
const adRows = await fetchCampaignInsights({ since: '2026-08-01', until: '2026-08-31' });
await upsertMetaInsights(adRows);
check('Meta insights load and store', adRows.length > 0, `${adRows.length} campaign-days`);

{
  const before = await readMetaInsights('2026-08-01', '2026-08-31');
  await upsertMetaInsights(adRows);
  const after = await readMetaInsights('2026-08-01', '2026-08-31');
  const sum = (list) => list.reduce((s, r) => s + r.spend, 0);
  // Meta revises recent days for ~72h, so every sync re-sends days already
  // stored. Keyed by date+campaign, a re-sync must overwrite, never accumulate.
  check('re-syncing the same Meta days overwrites instead of accumulating',
    before.length === after.length && near(sum(before), sum(after)),
    `${before.length}/${sum(before).toFixed(2)} vs ${after.length}/${sum(after).toFixed(2)}`);
}

check('Meta rows outside the range are filtered out',
  (await readMetaInsights('2026-08-11', '2026-08-12')).every((r) => r.date >= '2026-08-11' && r.date <= '2026-08-12'));

// The live account has campaign names with stray spaces the ad manager typed,
// and Shopify hands the same name back URL-encoded. Both must land on one key.
check('the join key survives spacing and encoding differences',
  campaignKey('CLB_Sales_LV_ P9 _40_07/16') === campaignKey('CLB_Sales_LV_+P9+_40_07%2F16'));
check('the join key matches the names seen identically on both sides',
  campaignKey('CLB_Broad_Catalog_AJ_06/19') === 'clb-broad-catalog-aj-06-19');
check('the join key keeps distinct campaigns distinct',
  campaignKey('CLB_Broad_Catalog_AJ_06/19') !== campaignKey('CLB_Broad_Catalog_AJ_07/31'));

/* ---- the payload ---------------------------------------------------------- */
const range = { start: '2026-08-11', end: '2026-08-17' };
const orders = await readOrders(range.start, range.end);
const posTotals = await readPosTotals(range.start, range.end);
const metaInsights = await readMetaInsights(range.start, range.end);

const ex = buildPayload({ orders, posTotals, metaInsights, ...range, exclusive: true });
const ov = buildPayload({ orders, posTotals, metaInsights, ...range, exclusive: false });

/* ---- the channel map moves money between tiles -----------------------------
 * End-to-end proof that the stamp works through buildPayload, not just in
 * bucketOf: the same orders, with and without the map, must shift revenue from
 * Draft into Ecommerce and leave the non-POS total untouched.
 * -------------------------------------------------------------------------- */
{
  const { SAMPLE_ORDER_CHANNELS } = await import('../fixtures/sample-channels.js');
  const withMap = buildPayload({
    orders, posTotals, metaInsights, ...range, exclusive: true,
    orderChannels: SAMPLE_ORDER_CHANNELS(),
  });

  /* Revenue leaves Draft. Where it lands depends on the order: a staff credit
   * note still wins, so a phone-written order credited to someone goes to
   * Assisted, not Ecommerce. In this fixture every mobile draft is credited,
   * which is representative — that is how the store actually works. */
  const leftDraft = ex.buckets.draft.revenue - withMap.buckets.draft.revenue;
  check('the channel map moves revenue out of Draft', leftDraft > 0, `−${leftDraft.toFixed(2)}`);

  const gained =
    (withMap.buckets.online.revenue - ex.buckets.online.revenue) +
    (withMap.buckets.assisted.revenue - ex.buckets.assisted.revenue);
  check('every dollar that leaves Draft lands in Ecommerce or Assisted',
    near(gained, leftDraft), `${gained.toFixed(2)} vs ${leftDraft.toFixed(2)}`);

check('the non-POS total is unchanged by reclassification',
    near(ex.totals.nonPosRevenue, withMap.totals.nonPosRevenue));

  /* The eBay fixture order, end to end. #27420 is a draft with both touchpoints
   * Direct, so without the eBay override it sits in Draft — the draft
   * attribution rule decides it before the credit note is ever consulted. With
   * the channel map stamping 'eBay' onto it, it must be in Ecommerce instead.
   * Its credit note is what proves the override is unconditional: the note
   * would otherwise make this an Assisted sale the moment any marketing touch
   * appeared in its journey. */
  {
    const find = (p) => {
      for (const k of ['online', 'assisted', 'draft']) {
        if (p.buckets[k].orders.some((o) => o.orderNumber === '#27420')) return k;
      }
      return null;
    };
    check('without the map the eBay order falls into Draft',
      find(ex) === 'draft', String(find(ex)));
    check('with the map the eBay order is Ecommerce',
      find(withMap) === 'online', String(find(withMap)));

    const row = withMap.buckets.online.orders.find((o) => o.orderNumber === '#27420');
    check('the eBay row names its channel', row?.salesChannel === 'eBay', String(row?.salesChannel));
    check('the eBay row carries no device label', row?.device == null, String(row?.device));
  }
  check('order counts move too',
    withMap.buckets.draft.orderCount < ex.buckets.draft.orderCount);

  // An uncredited mobile-app order must reach Ecommerce, not Assisted — the
  // fixture is all credited, so this is checked directly.
  check('an uncredited mobile-app draft reaches Ecommerce',
    bucketOf({ sourceName: 'shopify_draft_order', appName: 'Draft Orders', note: '',
      salesChannel: 'Shopify Mobile for iPhone',
      firstClickSource: 'Direct', lastClickSource: 'Direct' }) === 'online');

  const all = ['online', 'assisted', 'draft'].flatMap((k) => withMap.buckets[k].orders);
  const phones = all.filter((o) => o.device === 'Shopify iPhone');
  check('mobile-app rows carry the device label', phones.length > 0, `${phones.length} rows`);
  check('every mobile-app row is out of the Draft bucket',
    withMap.buckets.draft.orders.every((o) => o.device !== 'Shopify iPhone'));
  check('rows carry Shopify’s channel name',
    phones.every((o) => /^shopify mobile/i.test(o.salesChannel || '')));

  /* Without the map no order can be identified as phone-written, so nothing is
   * labelled "Shopify iPhone" and nothing moves out of Draft. Desk drafts still
   * read "Shopify desktop" — that label comes from being a draft at all, which
   * the Admin API does know. */
  const bare = ['online', 'assisted', 'draft'].flatMap((k) => ex.buckets[k].orders);
  check('no map means nothing is labelled as phone-written',
    bare.every((o) => o.device !== 'Shopify iPhone'));
  check('no map still labels desk-written drafts',
    ex.buckets.draft.orders.every((o) => o.device === 'Shopify desktop'));
}

/* ---- the Shopify/Meta join ------------------------------------------------ */
{
  const byKey = new Map(ex.campaigns.map((c) => [c.key, c]));

  check('a campaign on both sides is marked matched',
    byKey.get('clb-broad-catalog-aj-06-19')?.matched === true);

  check('a campaign Shopify saw but Meta never billed is not matched',
    byKey.get('clb-sale-signup-08-06')?.inShopify === true &&
    byKey.get('clb-sale-signup-08-06')?.inMeta === false);

  // The whole point of the join: Meta counts view-through and cross-device
  // purchases that never carry a utm back to the storefront, so they surface as
  // a campaign with Meta purchases and no Shopify orders.
  const metaOnly = byKey.get('clb-broad-catalog-500-07-24');
  check('a Meta-only campaign surfaces as an attribution gap',
    metaOnly?.inMeta === true && metaOnly?.inShopify === false && metaOnly.metaPurchases > 0,
    `gap ${metaOnly?.attributionGap}`);

  check('campaign spend totals match the stored rows',
    near(ex.ads.spend, metaInsights.reduce((s, r) => s + r.spend, 0)),
    `${ex.ads.spend.toFixed(2)}`);

  check('ROAS is purchase value over spend',
    near(ex.ads.roas, ex.ads.purchaseValue / ex.ads.spend));

  const allOrders = ['online', 'assisted', 'draft'].flatMap((k) => ex.buckets[k].orders);
  const backed = allOrders.filter((o) => o.adBacked);
  check('orders on a campaign Meta billed for are marked ad-backed',
    backed.length > 0 && backed.every((o) => o.adSpend > 0), `${backed.length} orders`);
  check('an order with no campaign is never marked ad-backed',
    allOrders.filter((o) => !o.campaign).every((o) => !o.adBacked));
}

// Without Meta data the payload must still build — the ad columns just go empty.
{
  const bare = buildPayload({ orders, posTotals, ...range });
  check('the payload builds with no Meta data at all',
    bare.ads.campaigns === 0 && bare.campaigns.every((c) => !c.inMeta));
  check('bucket totals are identical with and without Meta data',
    near(bare.totals.nonPosRevenue, ex.totals.nonPosRevenue));
}

const b = ex.buckets;
const sum = b.online.revenue + b.assisted.revenue + b.draft.revenue;

check('exclusive buckets sum to the non-POS total',
  near(sum, ex.totals.nonPosRevenue), `${sum.toFixed(2)} vs ${ex.totals.nonPosRevenue.toFixed(2)}`);

check('exclusive order counts sum to the non-POS count',
  b.online.orderCount + b.assisted.orderCount + b.draft.orderCount === ex.totals.nonPosOrders);

check('POS revenue is reported but kept out of the three panels',
  ex.totals.posRevenue > 0 && !near(ex.totals.allRevenue, ex.totals.nonPosRevenue));

const ids = new Set();
let dupes = 0;
for (const k of ['online', 'assisted', 'draft']) {
  for (const o of b[k].orders) { if (ids.has(o.id)) dupes += 1; ids.add(o.id); }
}
check('no order appears in two buckets in exclusive mode', dupes === 0, `${dupes} duplicates`);

check('no POS order reaches the three panels',
  [...b.online.orders, ...b.draft.orders, ...b.assisted.orders]
    .every((o) => !/point of sale/i.test(o.channelName || '')));

check('overlay assisted is a superset of exclusive assisted',
  ov.buckets.assisted.orderCount >= b.assisted.orderCount);

check('overlay total exceeds or equals the exclusive total',
  ov.buckets.online.revenue + ov.buckets.assisted.revenue + ov.buckets.draft.revenue
    >= ex.totals.nonPosRevenue - 0.005);

/* ---- range filtering ------------------------------------------------------ */
check('every returned order falls inside the requested range',
  orders.every((o) => {
    const d = localDateOf(o.createdAt);
    return d >= range.start && d <= range.end;
  }));

const narrow = await readOrders('2026-08-11', '2026-08-12');
check('a narrower range returns fewer or equal orders', narrow.length <= orders.length);

check('daily series days all fall inside the range',
  ex.daily.every((r) => r.day >= range.start && r.day <= range.end));

check('daily series totals match the bucket totals',
  near(ex.daily.reduce((s, r) => s + r.online + r.assisted + r.draft, 0), ex.totals.nonPosRevenue));

/* ---- month sharding ------------------------------------------------------- */
check('monthsBetween spans year boundaries',
  monthsBetween('2025-11-05', '2026-02-10').join(',') === '2025-11,2025-12,2026-01,2026-02');
check('monthsBetween handles a single month',
  monthsBetween('2026-08-01', '2026-08-31').join(',') === '2026-08');
check('a 90-day window touches at most 4 shards',
  monthsBetween('2026-05-23', '2026-08-20').length <= 4);

/* ---- storage metadata ----------------------------------------------------- */
check('watermark round-trips', Boolean((await getWatermark())?.lastSyncAt));

const first = await acquireLock('a');
const second = await acquireLock('b');
await releaseLock();
const third = await acquireLock('c');
await releaseLock();
check('the sync lock keeps two runs from overlapping', first && !second && third);

/* ---- the per-row day the channel breakdown buckets by ----------------------
 * Each drill-down row carries its own store-local day. The "Ecommerce by
 * channel" chart groups rows by it and draws them against the daily series, so
 * if the two ever disagreed a line would sit under the wrong date. Deriving the
 * day in the browser instead would use the VIEWER's timezone and do exactly
 * that for anyone outside America/New_York.
 * -------------------------------------------------------------------------- */
{
  const rows = ['online', 'assisted', 'draft'].flatMap((k) => ex.buckets[k].orders);

  check('every drill-down row carries a store-local day',
    rows.every((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.day || '')));
  check('the row day matches the timezone helper the series uses',
    rows.every((o) => o.day === localDateOf(o.createdAt)));

  const dayTotals = new Map();
  for (const o of rows) dayTotals.set(o.day, (dayTotals.get(o.day) || 0) + o.netSale);

  check('row days all fall inside the requested range',
    [...dayTotals.keys()].every((d) => d >= range.start && d <= range.end));

  const mismatched = ex.daily.filter((d) =>
    !near(dayTotals.get(d.day) || 0, d.online + d.assisted + d.draft));
  check('every day in the series matches the rows filed under it',
    mismatched.length === 0,
    mismatched.map((d) => d.day).join(' ') || 'all days agree');

  const seriesTotal = ex.daily.reduce((t, d) => t + d.online + d.assisted + d.draft, 0);
  const rowTotal = [...dayTotals.values()].reduce((t, v) => t + v, 0);
  check('rows bucketed by their own day reproduce the daily series total',
    near(seriesTotal, rowTotal), `${rowTotal.toFixed(2)} vs ${seriesTotal.toFixed(2)}`);
}

/* ---- the Ecommerce channel breakdown --------------------------------------
 * The grouping behind the "Ecommerce by channel" chart. Folding, colour
 * assignment and the label fallbacks all have edges worth pinning: the eBay
 * fallback especially, since an eBay order carries no sales channel at all and
 * would otherwise be labelled with its app name, "Draft Orders".
 * -------------------------------------------------------------------------- */
{
  const { channelSeries, chLabel, CH_MAX_SERIES, CH_CAT } =
    await import('../public/channels.js');

  check('an eBay row is labelled eBay, not its "Draft Orders" app name',
    chLabel({ fromEbay: true, channelName: 'Draft Orders', salesChannel: null }) === 'eBay');
  check('a real sales channel is used as-is', chLabel({ salesChannel: 'Shop' }) === 'Shop');
  check('a bare Draft Orders app name is not passed off as a channel',
    chLabel({ channelName: 'Draft Orders' }) === 'Unattributed');
  check('a row with no channel at all is grouped, not dropped',
    chLabel({}) === 'Unattributed');

  const days = ['2026-08-11', '2026-08-12', '2026-08-13'];
  const rows = [];
  // 11 channels, descending order counts, so the fold is exercised.
  for (let c = 0; c < 11; c += 1) {
    for (let n = 0; n < 11 - c; n += 1) {
      rows.push({ day: days[n % days.length], netSale: 10 * (c + 1), salesChannel: `Ch${c}` });
    }
  }
  const byOrders = channelSeries(rows, days, 'orders');
  const byRevenue = channelSeries(rows, days, 'revenue');

  check('channels past the cap fold into one "Other" series',
    byOrders.length === CH_MAX_SERIES + 1, `${byOrders.length} series`);
  check('the fold names how many it swallowed',
    byOrders.some((c) => c.name === 'Other (4)'),
    byOrders.map((c) => c.name).join(', '));
  check('folding loses no orders',
    byOrders.reduce((t, c) => t + c.total, 0) === rows.length);
  check('folding loses no revenue',
    near(byRevenue.reduce((t, c) => t + c.total, 0),
      rows.reduce((t, r) => t + r.netSale, 0)));
  check('no series is ever given a ninth colour',
    byOrders.every((c) => CH_CAT.includes(c.color)));
  check('colours are never reused within one chart',
    new Set(byOrders.map((c) => c.color)).size === byOrders.length);

  /* The rule the Orders/Revenue toggle must not break: colour follows the
   * channel, never its rank. Compared per channel rather than by serialising
   * the map — the two arrays are deliberately ordered differently, so key
   * order says nothing about whether anything was repainted. */
  const colourOf = (list) => new Map(list.map((c) => [c.name, c.color]));
  const co = colourOf(byOrders), cr = colourOf(byRevenue);
  const repainted = [...co.entries()].filter(([n, col]) => cr.get(n) !== col);
  check('switching measure does not repaint a channel',
    repainted.length === 0,
    repainted.map(([n, col]) => `${n}: ${col} -> ${cr.get(n)}`).join(', ') || 'none repainted');
  check('switching measure keeps the same set of channels',
    co.size === cr.size && [...co.keys()].every((n) => cr.has(n)));
  check('switching measure reorders the draw list by the new measure',
    byRevenue[0].total >= byRevenue[byRevenue.length - 1].total);

  check('every series carries one point per day',
    byOrders.every((c) => c.points.length === days.length));
  check('per-day points sum to the series total',
    byOrders.every((c) => near(c.points.reduce((t, v) => t + v, 0), c.total)));
  check('rows outside the plotted days are excluded',
    channelSeries([{ day: '2020-01-01', netSale: 999, salesChannel: 'Ghost' }], days, 'orders')
      .length === 0);
  check('a single-day range still produces one point per series',
    channelSeries(rows, [days[0]], 'orders').every((c) => c.points.length === 1));
  check('an empty range yields no series', channelSeries(rows, [], 'orders').length === 0);

  // Against the real fixture, the breakdown must reconcile with the tile.
  const eco = ex.buckets.online.orders;
  const real = channelSeries(eco, ex.daily.map((d) => d.day), 'revenue');
  check('the channel breakdown reconciles with the Ecommerce tile',
    near(real.reduce((t, c) => t + c.total, 0), ex.buckets.online.revenue),
    `${real.reduce((t, c) => t + c.total, 0).toFixed(2)} vs ${ex.buckets.online.revenue.toFixed(2)}`);
  check('the fixture eBay order shows up under eBay, not Draft Orders',
    real.some((c) => c.name === 'eBay') && !real.some((c) => /draft/i.test(c.name)),
    real.map((c) => c.name).join(', '));
}

/* ---- sell-through by brand -------------------------------------------------
 * The panel's whole reason for existing is that ONE sell-through number is not
 * enough: the benchmark bands only fit the lifetime figure, and the windowed
 * one has to stay out of their way. These pin that apart, along with the
 * derived rates and the combination flags.
 * -------------------------------------------------------------------------- */
{
  const { shapeBrands, bandFor, flagsFor, windowStart, STR_BANDS, STR_WINDOWS,
          CAPITAL_AT_REST, SLOW_DAYS, HIGH_RETURN_RATE } =
    await import('../lib/sellthrough.js');
  const { SAMPLE_SELLTHROUGH } = await import('../fixtures/sample-sellthrough.js');

  // --- the bands -----------------------------------------------------------
  check('80% and over grades Excellent', bandFor(0.80).key === 'excellent');
  check('the sweet spot grades Healthy',
    bandFor(0.60).key === 'healthy' && bandFor(0.799).key === 'healthy');
  check('the luxury band starts at 40%',
    bandFor(0.40).key === 'luxury' && bandFor(0.599).key === 'luxury');
  check('below 40% grades as under benchmark', bandFor(0.399).key === 'watch');
  check('every band carries a label and an explanation',
    STR_BANDS.every((b) => b.label && b.note));
  check('a missing rate grades as nothing rather than as failing',
    bandFor(null) === null && bandFor(undefined) === null);

  // --- windows -------------------------------------------------------------
  check('a 30-day window ends on the day asked for',
    windowStart('2026-09-22', 30) === '2026-08-24', windowStart('2026-09-22', 30));
  check('a 1-day window is that same day', windowStart('2026-09-22', 1) === '2026-09-22');
  check('windows cross a month boundary correctly',
    windowStart('2026-03-01', 30) === '2026-01-31', windowStart('2026-03-01', 30));

  // --- shaping -------------------------------------------------------------
  const rep = SAMPLE_SELLTHROUGH('2026-09-22');
  const by = Object.fromEntries(rep.brands.map((b) => [b.brand, b]));

  check('every brand carries a lifetime rate and a band',
    rep.brands.every((b) => b.lifetimeRate != null && b.band));
  check('every brand carries a value for each window',
    rep.brands.every((b) => STR_WINDOWS.every((d) => b.windows[d] != null)));
  check('brands are ranked by capital on hand, not by rate',
    rep.brands[0].brand === 'Chrome Hearts', rep.brands[0].brand);

  /* The finding the panel is built around: over 30 days the rate collapses,
   * because a month of sales is small next to standing stock. If these ever
   * converged, grading the window against the bands would start to look
   * reasonable — and it is not. */
  const ch = by['Chrome Hearts'];
  check('lifetime and 30-day sell-through are far apart on deep stock',
    ch.lifetimeRate > 0.6 && ch.windows['30'].rate < 0.15,
    `lifetime ${(ch.lifetimeRate * 100).toFixed(1)}% vs 30d ${(ch.windows['30'].rate * 100).toFixed(1)}%`);
  check('the window rate is never used to set the band',
    ch.band === bandFor(ch.lifetimeRate).key && ch.band !== bandFor(ch.windows['30'].rate).key);

  // --- derived numbers -----------------------------------------------------
  check('return rate is reversals over gross',
    near(ch.returnRate, ch.reversals / ch.grossSales),
    `${(ch.returnRate * 100).toFixed(1)}%`);
  check('reversals are stored as a magnitude, not a negative',
    rep.brands.every((b) => b.reversals >= 0));
  check('a brand with no sales in the window has no return rate, not zero',
    rep.brands.every((b) => b.grossSales > 0 || b.returnRate === null));

  check('the store-wide rate is weighted by units, not a mean of percentages',
    near(rep.totals.lifetimeRate,
      rep.totals.unitsSoldLifetime / (rep.totals.unitsSoldLifetime + rep.totals.unitsOnHand)));
  {
    const meanOfPercents =
      rep.brands.reduce((t, b) => t + b.lifetimeRate, 0) / rep.brands.length;
    check('the weighted rate actually differs from the unweighted mean',
      !near(rep.totals.lifetimeRate, meanOfPercents),
      `${(rep.totals.lifetimeRate * 100).toFixed(1)}% vs ${(meanOfPercents * 100).toFixed(1)}%`);
  }
  check('capital on hand totals the brands',
    near(rep.totals.capitalOnHand,
      rep.brands.reduce((t, b) => t + b.capitalOnHand, 0)));

  // --- flags: the combinations --------------------------------------------
  check('deep stock plus slow movement flags stranded capital',
    flagsFor({ capitalOnHand: CAPITAL_AT_REST, daysRemaining: SLOW_DAYS, returnRate: 0 })
      .some((f) => f.key === 'capital-stranded'));
  check('big capital that is still moving is flagged as heavy, not stranded', (() => {
    const f = flagsFor({ capitalOnHand: CAPITAL_AT_REST, daysRemaining: 30, returnRate: 0 });
    return f.some((x) => x.key === 'capital-heavy') && !f.some((x) => x.key === 'capital-stranded');
  })());
  check('slow movement on a small book is flagged as slow, not as capital', (() => {
    const f = flagsFor({ capitalOnHand: 1000, daysRemaining: SLOW_DAYS + 1, returnRate: 0 });
    return f.some((x) => x.key === 'slow') && !f.some((x) => x.key.startsWith('capital'));
  })());
  check('capital and slow are never both claimed for one brand',
    rep.brands.every((b) => {
      const k = b.flags.map((f) => f.key);
      return !(k.includes('slow') && k.some((x) => x.startsWith('capital')));
    }));
  check('a high return rate is flagged',
    flagsFor({ capitalOnHand: 0, daysRemaining: 0, returnRate: HIGH_RETURN_RATE })
      .some((f) => f.key === 'returns'));
  check('selling out fast is flagged too',
    flagsFor({ capitalOnHand: 0, daysRemaining: 20, returnRate: 0, lifetimeRate: 0.9 })
      .some((f) => f.key === 'priced-under'));
  check('a brand with nothing notable carries no flags',
    flagsFor({ capitalOnHand: 1000, daysRemaining: 40, returnRate: 0.01, lifetimeRate: 0.7 })
      .length === 0);
  check('every flag explains itself',
    rep.brands.every((b) => b.flags.every((f) => f.label && f.detail)));

  /* Chrome Hearts is the case that motivated the panel: a respectable lifetime
   * rate, a bad return rate, and $1.69M sitting still. The percentage alone
   * would have said it was fine. */
  check('the healthy-looking brand with stranded capital is caught',
    ch.band === 'healthy'
      && ch.flags.some((f) => f.key === 'capital-stranded')
      && ch.flags.some((f) => f.key === 'returns'),
    ch.flags.map((f) => f.label).join(', '));

  // --- robustness ----------------------------------------------------------
  check('a blank vendor is named rather than dropped',
    rep.brands.some((b) => b.brand === 'No brand set'));
  check('shaping survives a completely empty report', (() => {
    const empty = shapeBrands({ lifetimeRows: [], windows: {}, salesRows: [], end: '2026-09-22' });
    return empty.brands.length === 0 && empty.totals.lifetimeRate === null;
  })());
  check('shaping survives missing window and sales data', (() => {
    const partial = shapeBrands({
      lifetimeRows: [{ product_vendor: 'X', ending_inventory_units: 10,
        inventory_units_sold: 30, sell_through_rate: 0.75,
        days_of_inventory_remaining: 12, ending_inventory_value: 500 }],
      end: '2026-09-22',
    });
    const b = partial.brands[0];
    return b.band === 'healthy' && b.returnRate === null && Object.keys(b.windows).length === 0;
  })());
}

/* ---- per-brand weekly trend ----------------------------------------------
 * The chart that opens when a brand row is clicked. Two things carry real risk
 * here: a vendor name reaching a ShopifyQL string literal, and the merge of two
 * separately-fetched timeseries onto the right weeks.
 * -------------------------------------------------------------------------- */
{
  const { escapeVendor, shapeTrend, NO_BRAND, TREND_DAYS } =
    await import('../lib/brandtrend.js');
  const { SAMPLE_TREND } = await import('../fixtures/sample-trend.js');
  const { SAMPLE_SELLTHROUGH: PANEL } = await import('../fixtures/sample-sellthrough.js');

  // --- injection ------------------------------------------------------------
  check('an ordinary brand name passes through untouched',
    escapeVendor('Chrome Hearts') === 'Chrome Hearts');
  check("an apostrophe is doubled, not stripped",
    escapeVendor("Levi's") === "Levi''s");
  check('a quote-and-clause injection is neutralised by doubling', (() => {
    // The shape that would close the literal and bolt on a second predicate.
    const evil = "x' OR product_vendor != '";
    const out = escapeVendor(evil);
    // Doubling must leave no lone quote that can terminate the literal.
    return out !== null && (out.match(/'/g) || []).length % 2 === 0;
  })());
  check('a newline in a brand name is refused', escapeVendor('a\nb') === null);
  check('a backslash in a brand name is refused', escapeVendor('a\\b') === null);
  check('a control character in a brand name is refused', escapeVendor('a\u0000b') === null);
  check('an empty or whitespace brand is refused',
    escapeVendor('') === null && escapeVendor('   ') === null && escapeVendor(null) === null);
  check('an absurdly long brand is refused', escapeVendor('x'.repeat(201)) === null);

  // --- merging --------------------------------------------------------------
  check('the two series merge by week, not by position', (() => {
    /* The sales series is deliberately missing the middle week — a brand that
     * shipped units but booked no revenue that week. Zipped by index, every
     * later sales figure would land one week early. */
    const t = shapeTrend({
      brand: 'T', end: '2026-09-21', since: '2026-06-24',
      invRows: [
        { week: '2026-09-07', ending_inventory_units: 10, inventory_units_sold: 2, sell_through_rate: 0.17 },
        { week: '2026-09-14', ending_inventory_units: 8, inventory_units_sold: 2, sell_through_rate: 0.2 },
        { week: '2026-09-21', ending_inventory_units: 5, inventory_units_sold: 3, sell_through_rate: 0.38 },
      ],
      salesRows: [
        { week: '2026-09-07', gross_sales: 200, net_sales: 200, sales_reversals: 0 },
        { week: '2026-09-21', gross_sales: 300, net_sales: 250, sales_reversals: -50 },
      ],
    });
    const byWeek = Object.fromEntries(t.weeks.map((w) => [w.week, w]));
    return t.weeks.length === 3
      && byWeek['2026-09-14'].netSales === 0
      && byWeek['2026-09-21'].netSales === 250;
  })());

  check('weeks come back in date order', (() => {
    const t = shapeTrend({
      brand: 'T', end: '2026-09-21',
      invRows: [
        { week: '2026-09-21', ending_inventory_units: 1, inventory_units_sold: 1 },
        { week: '2026-09-07', ending_inventory_units: 3, inventory_units_sold: 1 },
        { week: '2026-09-14', ending_inventory_units: 2, inventory_units_sold: 1 },
      ],
    });
    return t.weeks.map((w) => w.week).join(',') === '2026-09-07,2026-09-14,2026-09-21';
  })());

  check('reversals are stored as a magnitude, however Shopify signs them', (() => {
    const t = shapeTrend({
      brand: 'T', end: '2026-09-21',
      invRows: [{ week: '2026-09-21', ending_inventory_units: 1, inventory_units_sold: 1 }],
      salesRows: [{ week: '2026-09-21', gross_sales: 100, net_sales: 80, sales_reversals: -20 }],
    });
    return t.weeks[0].reversals === 20 && Math.abs(t.totals.returnRate - 0.2) < 1e-9;
  })());

  check('a brand that sold nothing reports no return rate rather than zero', (() => {
    const t = shapeTrend({
      brand: 'T', end: '2026-09-21',
      invRows: [{ week: '2026-09-21', ending_inventory_units: 40, inventory_units_sold: 0 }],
      salesRows: [],
    });
    return t.totals.returnRate === null && t.totals.unitsSold === 0;
  })());

  check('the stock endpoints come from the first and last week', (() => {
    const t = SAMPLE_TREND('Chrome Hearts');
    return t.totals.startOnHand === 684 && t.totals.endOnHand === 590;
  })());

  check('shaping survives no rows at all', (() => {
    const t = shapeTrend({ brand: 'T', end: '2026-09-21', invRows: null, salesRows: null });
    return t.weeks.length === 0 && t.totals.startOnHand === null && t.totals.returnRate === null;
  })());

  check('a row with no week key is skipped rather than keyed as blank', (() => {
    const t = shapeTrend({
      brand: 'T', end: '2026-09-21',
      invRows: [{ ending_inventory_units: 5, inventory_units_sold: 1 },
                { week: '2026-09-21', ending_inventory_units: 4, inventory_units_sold: 1 }],
    });
    return t.weeks.length === 1 && t.weeks[0].week === '2026-09-21';
  })());

  // --- the fixture ----------------------------------------------------------
  {
    const ch = SAMPLE_TREND('Chrome Hearts');
    check('the fixture holds a full quarter of weeks', ch.weeks.length === 14,
      `${ch.weeks.length} weeks`);
    check('the fixture reproduces the live units-sold total',
      ch.totals.unitsSold === 206, String(ch.totals.unitsSold));
    check('TREND_DAYS covers a quarter', TREND_DAYS === 90);

    /* The whole reason the chart plots two lines: the table's lifetime rate for
     * Chrome Hearts reads a comfortable 68.8%, while the stock behind it barely
     * moves. If these ever agree, the second line has stopped earning its place. */
    const sold = ch.totals.unitsSold;
    const stockFall = ch.totals.startOnHand - ch.totals.endOnHand;
    check('units sold and stock drawn-down are different stories',
      sold > 0 && stockFall > 0 && sold > stockFall,
      `${sold} sold vs ${stockFall} off the shelf`);
  }

  check('the blank-vendor group reports why it cannot be charted', (() => {
    const t = SAMPLE_TREND(NO_BRAND);
    return t.unavailable === 'no-vendor' && t.weeks.length === 0;
  })());

  check('every brand in the panel is clickable offline', (() => {
    // The fixture must answer for any brand, or the offline panel has rows that
    // open into an error nobody can reproduce without live credentials.
    return PANEL('2026-09-22').brands.every((b) => {
      const t = SAMPLE_TREND(b.brand);
      return b.brand === 'No brand set' ? t.unavailable === 'no-vendor' : t.weeks.length > 0;
    });
  })());
}

/* ---- classification -------------------------------------------------------
 * An independent restatement of the whole rule, written out longhand so it can
 * disagree with bucketOf() if either drifts. Order matters and mirrors
 * bucketOf: eBay first (unconditional), then the mobile app (yields to a credit
 * note), then the draft attribution split, then assisted.
 * -------------------------------------------------------------------------- */
const wantBucket = (o) => {
  if (isEbayOrder(o)) return 'online';
  if (isMobileAppChannel(o)) return isAssisted(o) ? 'assisted' : 'online';
  if (isDraft(o)) return isMarketingTouched(o) ? 'assisted' : 'draft';
  return isAssisted(o) ? 'assisted' : 'online';
};

check('classifiers agree with the buckets', page.orders.every((o) => {
  if (isPOS(o)) return true;
  const found = ['online', 'assisted', 'draft'].find((k) =>
    b[k].orders.some((x) => x.id === o.id));
  return !found || found === wantBucket(o);
}));

check('a direct-only draft stays in Draft even with a credit note',
  bucketOf({ sourceName: 'shopify_draft_order', note: 'Credit: Ruby',
    firstClickSource: 'Direct', lastClickSource: 'Direct' }) === 'draft');

check('a marketing-touched draft moves to Assisted',
  bucketOf({ sourceName: 'shopify_draft_order', note: 'Credit: Ruby',
    firstClickSource: 'Direct', lastClickSource: 'facebook / paid_social' }) === 'assisted');

check('a draft touched by marketing on first click only moves to Assisted',
  bucketOf({ sourceName: 'shopify_draft_order', note: '',
    firstClickSource: 'Google', lastClickSource: 'Direct' }) === 'assisted');

check('a draft with no journey data stays in Draft',
  bucketOf({ sourceName: 'shopify_draft_order', note: '',
    firstClickSource: 'No journey data', lastClickSource: 'No journey data' }) === 'draft');

check('a non-draft order with a credit note is still Assisted',
  bucketOf({ sourceName: 'web', note: 'Credit to Erik',
    firstClickSource: 'Direct', lastClickSource: 'Direct' }) === 'assisted');

check('a plain web order stays Online',
  bucketOf({ sourceName: 'web', note: '',
    firstClickSource: 'facebook / paid_social', lastClickSource: 'Direct' }) === 'online');

check('the abbreviated "Cred:" note counts as a staff credit',
  isAssisted({ note: 'Cred: Alex', tags: [] }));

check('a draft order with a retail location is not treated as POS',
  !isPOS({ sourceName: 'shopify_draft_order', appName: 'Draft Orders',
    retailLocationName: 'Kenwood Towne Centre' }));

/* ---- mobile-app drafts belong to Ecommerce -------------------------------
 * The Admin API reports these identically to desk-written drafts. Only the
 * salesChannel stamp (from Shopify Analytics) tells them apart, and it must
 * move them out of Draft and into Ecommerce.
 * -------------------------------------------------------------------------- */
{
  const mobileDraft = {
    sourceName: 'shopify_draft_order', appName: 'Draft Orders', note: '',
    salesChannel: 'Shopify Mobile for iPhone',
    firstClickSource: 'Direct', lastClickSource: 'Direct',
  };
  const deskDraft = { ...mobileDraft, salesChannel: 'Draft Orders' };
  const unknownDraft = { ...mobileDraft, salesChannel: '' };

  check('a mobile-app draft buckets to Ecommerce', bucketOf(mobileDraft) === 'online');
  check('a desk-written draft stays in Draft', bucketOf(deskDraft) === 'draft');
  check('a draft with no channel stamp keeps its old bucket',
    bucketOf(unknownDraft) === 'draft');

  check('the device label names the phone', deviceLabel(mobileDraft) === 'Shopify iPhone');
  check('the device label names the desktop', deviceLabel(deskDraft) === 'Shopify desktop');
  check('a storefront order gets no device label',
    deviceLabel({ sourceName: 'web', appName: 'Online Store', salesChannel: 'Online Store' }) === null);
  check('a POS order gets no device label',
    deviceLabel({ sourceName: 'pos', appName: 'Point of Sale', channelHandle: 'pos' }) === null);

  // A credit note still wins: a phone-written order someone is credited for is
  // an assisted sale, not a plain ecommerce one.
  check('a credited mobile-app draft still goes to Assisted',
    bucketOf({ ...mobileDraft, note: 'Credit: JR' }) === 'assisted');

  check('a mobile-app order is never POS',
    bucketOf({ ...mobileDraft, salesChannel: 'Shopify Mobile for Android' }) === 'online');
}

/* ---- eBay is Ecommerce unconditionally ------------------------------------
 * Store rule: an eBay sale is an ecommerce sale regardless of anything else.
 * Stricter than the mobile-app rule directly above, which yields to a credit
 * note. The only thing that outranks eBay is POS.
 *
 * eBay was not selling through this store when the rule was written, so these
 * cover every field the channel could plausibly arrive in.
 * -------------------------------------------------------------------------- */
{
  const base = { note: '', firstClickSource: 'Direct', lastClickSource: 'Direct' };
  const viaChannel = { ...base, sourceName: '987654321', salesChannel: 'eBay' };

  /* The shape eBay ACTUALLY arrives in, copied from live orders #28113/#28114:
   * a hand-written draft against a customer named "Ebay", with every channel
   * field empty. This is the case the first version of the rule missed — it
   * only tested channel fields, so these fell straight into Draft. */
  const realWorld = {
    ...base,
    sourceName: 'shopify_draft_order',
    appName: 'Draft Orders',
    customerName: 'Ebay',
    salesChannel: 'Draft Orders', // what ShopifyQL reports for them
    firstClickSource: 'No journey data',
    lastClickSource: 'No journey data',
  };
  check('a hand-written eBay draft buckets to Ecommerce', bucketOf(realWorld) === 'online');
  check('the live eBay shape is recognised', isEbayOrder(realWorld));
  check('an eBay draft gets no device label', deviceLabel(realWorld) === null);
  check('an identical draft for any other customer stays in Draft',
    bucketOf({ ...realWorld, customerName: 'Marcus Webb' }) === 'draft');

  check('an eBay order buckets to Ecommerce', bucketOf(viaChannel) === 'online');
  check('eBay is recognised via customerName',
    bucketOf({ ...base, sourceName: 'web', customerName: 'Ebay' }) === 'online');

  // The two that matter: neither signal may pull eBay out of Ecommerce.
  check('a credited eBay order stays in Ecommerce',
    bucketOf({ ...viaChannel, note: 'Credit to Erik' }) === 'online');
  check('an eBay order recorded as a draft stays in Ecommerce',
    bucketOf({ ...viaChannel, sourceName: 'shopify_draft_order', appName: 'Draft Orders' }) === 'online');
  check('a marketing-touched eBay draft stays in Ecommerce',
    bucketOf({ ...viaChannel, sourceName: 'shopify_draft_order', appName: 'Draft Orders',
      lastClickSource: 'facebook / paid_social' }) === 'online');
  check('a credited eBay draft stays in Ecommerce',
    bucketOf({ ...viaChannel, sourceName: 'shopify_draft_order', appName: 'Draft Orders',
      note: 'Credit: JR' }) === 'online');

  // Whichever field carries it, the rule fires.
  for (const [field, value] of [
    ['salesChannel', 'eBay'],
    ['channelName', 'eBay Marketplace'],
    ['appName', 'Marketplace Connect - eBay'],
    ['channelHandle', 'ebay'],
    ['sourceName', 'ebay'],
  ]) {
    check(`eBay is recognised via ${field}`,
      bucketOf({ ...base, sourceName: 'web', [field]: value }) === 'online',
      `${value}`);
  }

  check('eBay is matched case-insensitively',
    bucketOf({ ...base, salesChannel: 'EBAY' }) === 'online');

  // Word-boundary matched, so an unrelated substring must not trigger it. Such
  // an order falls through to the ordinary rules — a credit note makes it
  // Assisted, which is what proves eBay's override did not fire.
  check('a lookalike substring does not count as eBay',
    bucketOf({ ...base, appName: 'Storebayside', note: 'Credit to Erik' }) === 'assisted');

  // POS still outranks eBay. Nothing should ever produce this combination, but
  // the ordering is worth pinning so a future edit cannot silently invert it.
  check('POS still outranks eBay',
    bucketOf({ ...base, sourceName: 'pos', appName: 'Point of Sale',
      channelHandle: 'pos', salesChannel: 'eBay' }) === 'pos');

  check('an eBay order gets no device label',
    deviceLabel({ ...viaChannel, sourceName: 'shopify_draft_order', appName: 'Draft Orders' }) === null);

  check('eBay counts as an ecommerce channel', isEcommerceChannel({ appName: 'eBay' }));
}

/* ---- ecommerce channel membership -----------------------------------------
 * Shapes below are copied from live August orders. The app-installed channels
 * (StockX, Marketplace Connect) carry a NUMERIC sourceName and a null channel
 * handle, which is exactly why the match is on app name — a sourceName or
 * handle test would drop them silently.
 * -------------------------------------------------------------------------- */
for (const [label, o] of [
  ['the web storefront',      { sourceName: 'web', appName: 'Online Store', channelHandle: 'web' }],
  ['the Shop app',            { sourceName: '3890849', appName: 'Shop', channelHandle: 'shop' }],
  ['StockX',                  { sourceName: '137182019585', appName: 'StockX', channelHandle: '' }],
  ['Marketplace Connect',     { sourceName: '294412976129', appName: 'Meta', channelHandle: '' }],
  ['Facebook & Instagram',    { sourceName: '111', appName: 'Facebook & Instagram', channelHandle: '' }],
  ['Shopify Mobile',          { sourceName: 'iphone', appName: 'Shopify Mobile for iPhone', channelHandle: '' }],
]) {
  check(`${label} counts as an ecommerce channel`, isEcommerceChannel(o));
}

check('POS is never an ecommerce channel',
  !isEcommerceChannel({ sourceName: 'pos', appName: 'Point of Sale', channelHandle: 'pos' }));

check('a StockX order buckets to Ecommerce, not lost',
  bucketOf({ sourceName: '137182019585', appName: 'StockX', note: '',
    firstClickSource: 'No journey data', lastClickSource: 'No journey data' }) === 'online');

check('a genuine POS order is still POS',
  isPOS({ sourceName: 'pos', appName: 'Point of Sale', channelHandle: 'pos',
    retailLocationName: 'Fairfield Commons' }));

/* ---- customer journey ----------------------------------------------------- */
{
  const { fetchOrderJourney } = await import('../lib/shopify.js');
  const { buildJourney, isPaidMoment, isInvoiceMoment, labelOf } =
    await import('../lib/journey.js');

  const draft = await fetchOrderJourney('gid://shopify/Order/900000000002');
  const j = buildJourney(draft.moments, draft);

  check('a journey loads for a single order', draft.moments.length > 0,
    `${draft.moments.length} sessions`);

  // The whole point: consecutive sessions from one source become one step.
  check('consecutive sessions from the same source collapse',
    j.summary.steps < j.summary.sessions, `${j.summary.sessions} -> ${j.summary.steps}`);

  const repeat = await fetchOrderJourney('gid://shopify/Order/900000000017');
  const rj = buildJourney(repeat.moments, repeat);
  check('a run of near-identical sessions collapses to one step with a count',
    rj.steps.some((s) => s.count >= 7), `max run ${Math.max(...rj.steps.map((s) => s.count))}`);

  // Only real sessions count. The purchase and the previous-order anchor are
  // events this app adds to the timeline, not things Shopify recorded as visits.
  const sessionSteps = (j2) => j2.steps.filter((s) => s.kind === 'visit' || s.kind === 'invoice');
  check('collapsing never loses a session',
    sessionSteps(rj).reduce((n, s) => n + s.count, 0) === repeat.moments.length);

  check('steps come back in chronological order',
    j.steps.every((s, i, a) => i === 0 || new Date(a[i - 1].from) <= new Date(s.from)));

  check('the purchase is the last step', j.steps[j.steps.length - 1].kind === 'purchase');

  // The case the drawer exists for: order #27005's endpoints are both Direct,
  // and a Google Ads click sits in the middle.
  check('a paid click hidden between the endpoints is flagged',
    j.summary.hiddenPaid === true && j.summary.paidTouch === true);
  check('the hidden campaign is named', j.summary.campaigns.includes('24053064435'));
  check('opening the draft invoice is recognised', j.summary.openedInvoice === true);

  // Free Google Shopping traffic must not be counted as advertising spend.
  check('the Google Shopping feed is marketing but not paid',
    isPaidMoment({ utmMedium: 'product_sync' }) === false &&
    isPaidMoment({ utmMedium: 'cpc' }) === true &&
    isPaidMoment({ utmMedium: 'paid_social' }) === true);

  check('a draft invoice landing page is detected',
    isInvoiceMoment({ landingPage: 'https://www.clb23.com/checkouts/do/abc/en-us' }) &&
    !isInvoiceMoment({ landingPage: 'https://www.clb23.com/checkouts/cn/abc/en-us' }));

  check('a bare direct visit is labelled Direct',
    labelOf({ source: 'direct' }) === 'Direct' &&
    labelOf({ source: 'an unknown source' }) === 'Direct');
  check('a URL in the source field is shown as a hostname',
    labelOf({ source: 'https://facebook.com/' }) === 'facebook.com');

  const plain = await fetchOrderJourney('gid://shopify/Order/900000000003');
  const pj = buildJourney(plain.moments, plain);
  check('a single-session order reports nothing hidden',
    pj.summary.hiddenPaid === false && pj.summary.hiddenMarketing === false &&
    pj.summary.steps === 1);

  check('an empty journey still builds', buildJourney([], {}).steps.length === 0);
  check('a journey with no order still builds', buildJourney(draft.moments).steps.length > 0);

  /* ---- repeat-customer context ---- */
  check('the previous order anchors the top of the timeline',
    j.steps[0].kind === 'previous' && j.steps[0].orderNumber === '#16008');
  check('the gap back to the previous order is measured',
    j.steps[0].gapDays > 300, `${j.steps[0].gapDays} days`);
  check('a long-dormant customer is flagged',
    j.customer.dormantDays >= 180 && j.customer.orders === 4);
  check('lifetime spend comes through', j.customer.spend === 50270);

  // The anchor must not be mistaken for a marketing touch or a session.
  check('the anchor is neither paid nor marketing',
    j.steps[0].paid === false && j.steps[0].marketing === false);
  check('the anchor is excluded from the session and step counts',
    j.summary.sessions === draft.moments.length &&
    j.summary.steps === j.steps.filter((s) => s.kind === 'visit' || s.kind === 'invoice').length);

  check('a first-time buyer gets no anchor and no dormancy',
    pj.steps[0].kind !== 'previous' && pj.customer.previousOrder === null &&
    pj.customer.dormantDays === null && pj.customer.orders === 1);
}

/* ---- auth ----------------------------------------------------------------- */
process.env.DASHBOARD_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-salt';
const token = await auth.issueToken();
check('a freshly issued session token verifies', await auth.verifyToken(token));
// Flip the final character to a guaranteed-different one. Replacing it with a
// fixed '0' was a no-op whenever the signature already ended in '0', which made
// this check pass or fail depending on the random token.
const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
check('a tampered token is rejected', !(await auth.verifyToken(tampered)));
check('a token signed under a different password is rejected', await (async () => {
  process.env.DASHBOARD_PASSWORD = 'a-different-password';
  const bad = await auth.verifyToken(token);
  process.env.DASHBOARD_PASSWORD = 'test-password';
  return !bad;
})());
check('the right password is accepted', await auth.checkPassword('test-password'));
check('the wrong password is rejected', !(await auth.checkPassword('nope')));
check('an empty password is rejected', !(await auth.checkPassword('')));
check('cookies parse out of a multi-cookie header',
  auth.readCookie(`other=1; ${auth.COOKIE}=abc; more=2`) === 'abc');

/* ---- Shopify's channel report ---------------------------------------------
 * This is a REFERENCE figure, not a fourth bucket. The checks below pin the two
 * things that make it trustworthy: that Ecommerce means "every channel except
 * POS", and that the Shopify Mobile channel is present — that one channel is
 * the whole reason the report is fetched instead of derived from stored orders.
 * -------------------------------------------------------------------------- */
{
  const { fetchChannelSales } = await import('../lib/shopify.js');
  const rep = await fetchChannelSales('2026-08-01', '2026-08-31');

  check('the channel report loads', Boolean(rep?.channels?.length));

  const sumAll = rep.channels.reduce((s, c) => s + c.netSales, 0);
  check('ecommerce + draft + POS accounts for every channel',
    Math.abs(rep.ecommerce.netSales + rep.draft.netSales + rep.pos.netSales - sumAll) < 0.005,
    `${rep.ecommerce.netSales} + ${rep.draft.netSales} + ${rep.pos.netSales} vs ${sumAll}`);

  // The number the Shopify admin shows on its E-Commerce line. Draft Orders is
  // its own channel and sits outside it — including it would give 166,241.71.
  check('the ecommerce figure matches Shopify’s E-Commerce line',
    Math.abs(rep.ecommerce.netSales - 108124.65) < 0.005,
    `${rep.ecommerce.netSales.toFixed(2)}`);

  check('Draft Orders is reported apart from ecommerce',
    Math.abs(rep.draft.netSales - 58117.06) < 0.005);

  check('POS is reported apart from ecommerce',
    Math.abs(rep.pos.netSales - 218866.6) < 0.005);

  // The channel that cannot be derived from the Admin API. If this ever stops
  // appearing, the tile has lost the reason it exists.
  check('the Shopify Mobile channel is present',
    rep.channels.some((c) => /shopify mobile/i.test(c.channel)));

  /* ---- the Shopify Mobile tile's figures ----------------------------------
   * The tile renders straight off rep.mobile, so its exact shape is pinned.
   * Verified against the live store for August 2026: 17 orders, $56,636. */
  check('the mobile block reports the channel total',
    Math.abs(rep.mobile.netSales - 56636) < 0.005 && rep.mobile.orders === 17,
    `${rep.mobile.orders} orders / ${rep.mobile.netSales}`);

  check('the mobile block carries the channel name for the tile label',
    /^shopify mobile/i.test(rep.mobile.label), rep.mobile.label);

  check('the mobile block flags that the channel exists', rep.mobile.present === true);

  /* Shopify counts this channel INSIDE its E-Commerce line, so the tile is a
   * breakdown of that $108,124.65 — not a fourth number to add to it. It is
   * shown separately only because these orders land in the dashboard's Draft
   * bucket, which is the discrepancy people kept tripping over. */
  check('mobile is part of Shopify’s ecommerce figure, not additional to it',
    rep.mobile.netSales < rep.ecommerce.netSales,
    `${rep.mobile.netSales} inside ${rep.ecommerce.netSales}`);

  /* ---- per-order channels -------------------------------------------------
   * The correction that made the drill-down possible: ShopifyQL groups by
   * order_name as well as sales_channel, so the channel IS knowable per order —
   * including the phone-written drafts the Admin API cannot distinguish. */
  {
    const { fetchOrderChannels } = await import('../lib/shopify.js');
    const byOrder = await fetchOrderChannels('2026-08-01', '2026-08-31');

    check('per-order channels load', byOrder.size > 0, `${byOrder.size} orders`);

    check('a phone-written draft resolves to Shopify Mobile',
      /^shopify mobile/i.test(byOrder.get('#27790') || ''), byOrder.get('#27790'));

    check('a desk-written draft stays Draft Orders',
      byOrder.get('#27806') === 'Draft Orders');

    // Both are drafts to the Admin API. If these ever collapse to one value the
    // overlay has stopped doing its job.
    check('the two draft kinds are told apart',
      byOrder.get('#27790') !== byOrder.get('#27806'));

    check('storefront and marketplace orders keep their own channels',
      byOrder.get('#27739') === 'Online Store' &&
      byOrder.get('04-EEA1P1YY1V') === 'StockX');

    check('every mapped channel is a non-empty string',
      [...byOrder.values()].every((c) => typeof c === 'string' && c.length > 0));
  }

  check('mobile plus the other ecommerce channels equals the ecommerce total',
    Math.abs(
      rep.channels
        .filter((c) => !/^(point of sale|draft orders)/i.test(c.channel))
        .reduce((s, c) => s + c.netSales, 0) - rep.ecommerce.netSales,
    ) < 0.005);

  check('channels come back sorted by net sales',
    rep.channels.every((c, i, a) => i === 0 || a[i - 1].netSales >= c.netSales));
}

/* ---- GraphQL documents ----------------------------------------------------
 * Every query in lib/ is a JS template literal, so a JS comment inside one
 * looks fine to Node, to esbuild and to every mocked test — and then Shopify
 * rejects the whole document with PARSE_ERROR at runtime. That is exactly how
 * the journey drawer shipped broken once. GraphQL comments start with #.
 * -------------------------------------------------------------------------- */
{
  const fsSync = await import('node:fs');
  const dir = new URL('../lib/', import.meta.url);
  let offenders = [];
  for (const f of fsSync.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fsSync.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/`([^`]*)`/g)) {
      const body = m[1];
      if (!/\b(query|mutation)\s+\w+\s*[({]/.test(body)) continue;
      if (/\/\*|\*\/|(^|\s)\/\//.test(body)) {
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  check('no GraphQL document carries a JS comment', offenders.length === 0,
    offenders.join(', '));
}

/* -------------------------------------------------------------------------- */
console.log(`\n${failures ? `${failures} FAILED` : 'All checks passed'}\n`);
process.exit(failures ? 1 : 0);
