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
const {
  upsertOrders, readOrders, readPosTotals, monthsBetween,
  setWatermark, getWatermark, acquireLock, releaseLock,
} = await import('../lib/repo.js');
const { buildPayload } = await import('../lib/payload.js');
const { isPOS, isDraft, isAssisted } = await import('../lib/classify.js');
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

/* ---- the payload ---------------------------------------------------------- */
const range = { start: '2026-08-11', end: '2026-08-17' };
const orders = await readOrders(range.start, range.end);
const posTotals = await readPosTotals(range.start, range.end);

const ex = buildPayload({ orders, posTotals, ...range, exclusive: true });
const ov = buildPayload({ orders, posTotals, ...range, exclusive: false });

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
check('classifiers agree with the buckets', page.orders.every((o) => {
  if (isPOS(o)) return true;
  const assisted = isAssisted(o);
  const draft = isDraft(o);
  const want = assisted ? 'assisted' : draft ? 'draft' : 'online';
  const found = ['online', 'assisted', 'draft'].find((k) =>
    b[k].orders.some((x) => x.id === o.id));
  return !found || found === want;
}));

/* ---- auth ----------------------------------------------------------------- */
process.env.DASHBOARD_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-salt';
const token = await auth.issueToken();
check('a freshly issued session token verifies', await auth.verifyToken(token));
check('a tampered token is rejected', !(await auth.verifyToken(token.replace(/.$/, '0'))));
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

/* -------------------------------------------------------------------------- */
console.log(`\n${failures ? `${failures} FAILED` : 'All checks passed'}\n`);
process.exit(failures ? 1 : 0);
