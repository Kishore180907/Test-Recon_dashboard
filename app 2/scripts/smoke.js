/* End-to-end smoke test of the Netlify function handlers, run in-process
 * against the local blob store. Run:  npm run smoke */

process.env.MOCK_DATA = '1';
process.env.LOCAL_BLOBS = '1';
process.env.SHOPIFY_SHOP = 'clb-xxiii.myshopify.com';
process.env.STORE_TIMEZONE = 'America/New_York';
process.env.DASHBOARD_PASSWORD = 'smoke-pw';
process.env.SESSION_SECRET = 'smoke-salt';

import fs from 'node:fs/promises';
import path from 'node:path';

await fs.rm(path.join(process.cwd(), '.blobs'), { recursive: true, force: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const data = (await import('../netlify/functions/data.mjs')).default;
const appconfig = (await import('../netlify/functions/appconfig.mjs')).default;
const status = (await import('../netlify/functions/status.mjs')).default;
const login = (await import('../netlify/functions/login.mjs')).default;
const backfill = (await import('../netlify/functions/backfill-background.mjs')).default;
const syncNow = (await import('../netlify/functions/sync-now.mjs')).default;
const gate = (await import('../netlify/edge-functions/gate.js')).default;
const report = (await import('../netlify/functions/report.mjs')).default;
const reportview = (await import('../netlify/functions/reportview.mjs')).default;
const { COVERAGE_DAYS } = await import('../lib/sync.js');

const BASE = 'https://dash.example.com';
const req = (p, init) => new Request(BASE + p, init);
const body = async (res) => res.json();

/* ---- 1. cold store: /api/data must refuse, not crash --------------------- */
let res = await data(req('/api/data?start=2026-08-11&end=2026-08-17'));
check('cold store returns 503 needs-backfill', res.status === 503);
check('cold store flags needsBackfill to the UI', (await body(res)).needsBackfill === true);

/* ---- 2. backfill seeds storage ------------------------------------------ */
res = await backfill(req('/api/backfill', { method: 'POST' }));
check('backfill completes', (await res.text()) === 'done');

res = await status(req('/api/status'));
let st = await body(res);
check('status reports ready after backfill', st.ready === true, `backfill=${st.backfill.status}`);
/* 430 days since 2026-10-02 — a year plus a run-up, so Year to date is whole
 * on 1 January and a year-on-year comparison has something behind it. Asserted
 * against the library rather than a literal, so the two cannot drift. */
check('status reports the coverage window',
  st.coverage.days === COVERAGE_DAYS, JSON.stringify(st.coverage));
check('the coverage window spans more than a year',
  COVERAGE_DAYS > 365, `${COVERAGE_DAYS} days`);

/* ---- 3. data now serves the payload -------------------------------------- */
res = await data(req('/api/data?start=2026-08-11&end=2026-08-17'));
check('data returns 200 once seeded', res.status === 200);
const payload = await body(res);
const b = payload.buckets;
const sum = b.online.revenue + b.assisted.revenue + b.draft.revenue;
check('tiles sum to the non-POS total through the HTTP layer',
  Math.abs(sum - payload.totals.nonPosRevenue) < 0.005,
  `${sum.toFixed(2)} vs ${payload.totals.nonPosRevenue.toFixed(2)}`);
check('payload carries a sync timestamp for the age label', Boolean(payload.syncedAt));
check('drill-down rows carry the attribution columns',
  b.online.orders.every((o) =>
    'orderNumber' in o && 'netSale' in o && 'firstClick' in o && 'lastClick' in o && 'trafficSource' in o));
check('drill-down rows carry the sales channel and device',
  b.online.orders.every((o) => 'salesChannel' in o && 'device' in o));

/* ---- 3b. the Meta Ads join over HTTP -------------------------------------- */
check('the sync pulls Meta insights alongside orders',
  payload.metaAds?.rowsInRange > 0, `${payload.metaAds?.rowsInRange} campaign-days`);
check('the payload carries the campaign comparison',
  Array.isArray(payload.campaigns) && payload.campaigns.length > 0,
  `${payload.campaigns?.length} campaigns`);
check('every compared campaign is present on at least one side',
  payload.campaigns.every((c) => c.inMeta || c.inShopify));
check('Meta totals reconcile with the per-campaign rows',
  Math.abs(payload.ads.spend - payload.campaigns.reduce((s, c) => s + c.metaSpend, 0)) < 0.005,
  `${payload.ads.spend.toFixed(2)}`);
check('at least one campaign shows an attribution gap worth reasoning about',
  payload.campaigns.some((c) => c.attributionGap > 0));

/* ---- 3c. the journey endpoint --------------------------------------------- */
{
  const journey = (await import('../netlify/functions/journey.mjs')).default;
  const call = (id) => journey(req(`/api/journey?id=${encodeURIComponent(id)}`));

  const ok = await call('gid://shopify/Order/900000000002');
  check('journey returns 200 for a real order', ok.status === 200);
  const jb = await body(ok);
  check('journey returns collapsed steps and a summary',
    Array.isArray(jb.steps) && jb.steps.length > 0 && jb.summary.sessions > jb.summary.steps,
    `${jb.summary.sessions} sessions -> ${jb.summary.steps} steps`);
  check('journey surfaces the hidden paid click over HTTP', jb.summary.hiddenPaid === true);
  check('journey carries the staff credit from the order note',
    jb.steps[jb.steps.length - 1].creditedTo === 'Shy');
  check('journey carries the previous order and lifetime value over HTTP',
    jb.customer?.previousOrder?.orderNumber === '#16008' &&
    jb.customer?.orders === 4 && jb.customer?.spend === 50270,
    `${jb.customer?.orders} orders, prev ${jb.customer?.previousOrder?.orderNumber}`);

  // The id reaches a GraphQL query, so anything that is not an order id is
  // refused before it gets there.
  for (const bad of ['', 'nope', 'gid://shopify/Customer/1', 'gid://shopify/Order/1 OR 1=1']) {
    check(`journey rejects a bad id (${bad || 'empty'})`, (await call(bad)).status === 400);
  }
  check('journey 404s for an order that does not exist',
    (await call('gid://shopify/Order/900000000999')).status === 404);
}

/* ---- 3d. Shopify's channel report over HTTP -------------------------------- */
{
  const channels = (await import('../netlify/functions/channels.mjs')).default;
  const call = (s, e) => channels(req(`/api/channels?start=${s}&end=${e}`));

  const ok = await call('2026-08-01', '2026-08-31');
  check('channels returns 200', ok.status === 200);
  const cb = await body(ok);
  check('channels reports the Shopify E-Commerce figure',
    Math.abs(cb.ecommerce.netSales - 108124.65) < 0.005,
    `${cb.ecommerce?.netSales}`);
  check('channels keeps draft and POS out of the ecommerce figure',
    cb.draft.netSales > 0 && cb.pos.netSales > 0);

  // The drill-down overlay: order -> Shopify's real channel, over HTTP.
  check('channels returns the per-order map',
    cb.orderChannels && Object.keys(cb.orderChannels).length > 0,
    `${Object.keys(cb.orderChannels || {}).length} orders`);
  check('the per-order map separates phone drafts from desk drafts',
    /^shopify mobile/i.test(cb.orderChannels['#27790'] || '') &&
    cb.orderChannels['#27806'] === 'Draft Orders');

  // Both values are interpolated into a ShopifyQL string, so bad input is
  // refused before it gets there.
  for (const [s, e] of [['nope', '2026-08-31'], ['2026-08-01', 'x'], ['', '']]) {
    check(`channels rejects a bad range (${s || 'empty'}, ${e || 'empty'})`,
      (await call(s, e)).status === 400);
  }
  check('channels rejects a reversed range',
    (await call('2026-08-31', '2026-08-01')).status === 400);
}

/* ---- 4. validation -------------------------------------------------------- */
check('bad dates are rejected', (await data(req('/api/data?start=nope&end=2026-08-17'))).status === 400);
check('reversed ranges are rejected',
  (await data(req('/api/data?start=2026-08-17&end=2026-08-11'))).status === 400);
check('a range older than coverage is rejected',
  (await data(req('/api/data?start=2020-01-01&end=2026-08-17'))).status === 400);

/* ---- 5. the retired overlay parameter -------------------------------------
 * ?exclusive=false used to count assisted orders twice. It is gone along with
 * its UI toggle; an old bookmark carrying it must get the real numbers rather
 * than an error or the old double-counted ones.
 * -------------------------------------------------------------------------- */
const ov = await body(await data(req('/api/data?start=2026-08-11&end=2026-08-17&exclusive=false')));
check('the retired exclusive=false parameter is ignored, not honoured',
  ov.buckets.assisted.orderCount === b.assisted.orderCount &&
  Math.abs(ov.totals.nonPosRevenue - payload.totals.nonPosRevenue) < 0.005);
check('tiles still sum to the non-POS total when it is passed',
  Math.abs((ov.buckets.online.revenue + ov.buckets.assisted.revenue + ov.buckets.draft.revenue)
    - ov.totals.nonPosRevenue) < 0.005);

/* ---- 6. config ------------------------------------------------------------ */
const cfg = await body(await appconfig(req('/api/config')));
check('config exposes the sync interval', cfg.syncIntervalMinutes === 15);
check('config exposes the assisted rule', typeof cfg.assistedRule.mode === 'string');
check('config default range is the past 7 days',
  cfg.defaults.start < cfg.defaults.end && cfg.coverage.start <= cfg.defaults.start);

/* ---- 7. manual refresh ---------------------------------------------------- */
res = await syncNow(req('/api/sync-now', { method: 'POST' }));
check('sync-now succeeds', res.status === 200, JSON.stringify(await body(res)).slice(0, 90));
check('sync-now rejects GET', (await syncNow(req('/api/sync-now'))).status === 405);

/* ---- 8. the gate ---------------------------------------------------------- */
const next = () => new Response('PASSTHROUGH');
const ctx = { next };

res = await gate(req('/'), ctx);
check('an unauthenticated page request gets the login screen', res.status === 401);
check('the login screen is HTML', (res.headers.get('content-type') || '').includes('text/html'));

res = await gate(req('/api/data'), ctx);
check('an unauthenticated API request gets 401 JSON', res.status === 401);

res = await gate(req('/api/login', { method: 'POST' }), ctx);
check('the login endpoint itself is reachable', (await res.text()) === 'PASSTHROUGH');

res = await login(req('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'wrong' }),
}));
check('a wrong password is refused', res.status === 401);

res = await login(req('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'smoke-pw' }),
}));
check('the right password logs in', res.status === 200);
const setCookie = res.headers.get('set-cookie') || '';
check('the session cookie is HttpOnly, Secure and SameSite',
  /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite/i.test(setCookie));

const cookie = setCookie.split(';')[0];
res = await gate(req('/', { headers: { cookie } }), ctx);
check('a valid cookie is let through', (await res.text()) === 'PASSTHROUGH');

// Flip the final character to a guaranteed-different one. Replacing it with a
// fixed '0' was a no-op whenever the signature already ended in '0', so this
// check passed or failed depending on the random cookie. (selftest.js had the
// same bug for its token and was fixed the same way.)
const tamperedCookie = cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0');
res = await gate(req('/', { headers: { cookie: tamperedCookie } }), ctx);
check('a tampered cookie is refused', res.status === 401);

/* ---- shared findings, end to end -----------------------------------------
 * Create a report through the real endpoint, open it through the real public
 * one, revoke it, and open it again. The whole promise of the feature is that
 * step three works without a session and step four stops working for everyone.
 * -------------------------------------------------------------------------- */
res = await report(req('/api/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    start: '2026-08-11', end: '2026-08-17', bucket: 'assisted',
    cmpMode: 'prev_period', title: 'Assisted is understated', note: 'Check the invoice links.',
  }),
}));
check('a report is created', res.status === 201);
const made = await body(res);
check('the report link is absolute and on this host',
  made.url === `${BASE}/r/${made.id}`, made.url);
check('the report id is 128 bits of hex', /^[0-9a-f]{32}$/.test(made.id));

res = await reportview(req(`/r/${made.id}`));
let page = await res.text();
check('the report page renders for someone with no session', res.status === 200);
check('the report page is not cacheable',
  /no-store/.test(res.headers.get('cache-control') || ''));
check('the report page is not indexable',
  /noindex/.test(res.headers.get('x-robots-tag') || ''));
check('the report page carries the finding', page.includes('Check the invoice links.'));
check('the report page carries the live-view link', page.includes(`${BASE}/#start=2026-08-11`));

/* Figures on the report must equal the figures /api/data serves for the same
 * range. Both go through lib/snapshot.js; this is the check that notices if
 * one of them ever gets its own copy of the read path. */
res = await data(req('/api/data?start=2026-08-11&end=2026-08-17'));
const live = await body(res);
check('the report shows the same assisted revenue as the dashboard',
  page.includes(new Intl.NumberFormat('en-US',
    { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
    .format(live.buckets.assisted.revenue)),
  live.buckets.assisted.revenue.toFixed(2));

res = await reportview(req('/r/' + 'f'.repeat(32)));
check('an unknown report id is a 404', res.status === 404);
res = await reportview(req('/r/not-an-id'));
check('a malformed report id is the same 404', res.status === 404);

res = await report(req(`/api/report?id=${made.id}`, { method: 'DELETE' }));
check('a report can be revoked', res.status === 200);
res = await reportview(req(`/r/${made.id}`));
check('a revoked report stops working for everyone', res.status === 404);
check('a revoked report answers like an unknown one',
  !(await res.text()).includes('Assisted is understated'));

res = await report(req('/api/report'));
check('a revoked report is no longer listed',
  !(await body(res)).reports.some((r) => r.id === made.id));

res = await report(req('/api/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ start: '2019-01-01', end: '2019-01-31' }),
}));
check('a report outside the coverage window is refused', res.status === 400);

/* The create endpoint is behind the gate; the view route is the only thing in
 * front of it. If that ever inverts, the password stops meaning anything. */
res = await gate(req(`/r/${made.id}`), ctx);
check('the report route needs no password', (await res.text()) === 'PASSTHROUGH');
res = await gate(req('/api/report', { method: 'POST' }), ctx);
check('creating a report still needs one', res.status === 401);

/* -------------------------------------------------------------------------- */
console.log(`\n${failures ? `${failures} FAILED` : 'All smoke checks passed'}\n`);
process.exit(failures ? 1 : 0);
