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
const { isPOS, isDraft, isAssisted, isMarketingTouched, bucketOf, isEcommerceChannel } = await import('../lib/classify.js');
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

/* ---- classification ------------------------------------------------------- */
// The store's rule: a draft order keeps the Draft credit only when both
// touchpoints are direct. A marketing-touched draft is credited to Assisted.
const wantBucket = (o) => {
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
