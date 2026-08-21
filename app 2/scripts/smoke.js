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
check('status reports the coverage window', st.coverage.days === 90, JSON.stringify(st.coverage));

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

/* ---- 4. validation -------------------------------------------------------- */
check('bad dates are rejected', (await data(req('/api/data?start=nope&end=2026-08-17'))).status === 400);
check('reversed ranges are rejected',
  (await data(req('/api/data?start=2026-08-17&end=2026-08-11'))).status === 400);
check('a range older than coverage is rejected',
  (await data(req('/api/data?start=2020-01-01&end=2026-08-17'))).status === 400);

/* ---- 5. overlay mode ------------------------------------------------------ */
const ov = await body(await data(req('/api/data?start=2026-08-11&end=2026-08-17&exclusive=false')));
check('overlay mode returns at least as many assisted orders',
  ov.buckets.assisted.orderCount >= b.assisted.orderCount);

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

res = await gate(req('/', { headers: { cookie: cookie.replace(/.$/, '0') } }), ctx);
check('a tampered cookie is refused', res.status === 401);

/* -------------------------------------------------------------------------- */
console.log(`\n${failures ? `${failures} FAILED` : 'All smoke checks passed'}\n`);
process.exit(failures ? 1 : 0);
