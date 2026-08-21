# CLB XXIII — Order Mix

Near-real-time revenue split for the store: **Online**, **Assisted**, **Draft** — each tile clickable through to the orders behind it, with first click, last click and traffic source per order.

Runs on Netlify's free tier: static page + functions + Blobs.

---

## How it stays current

The browser never talks to Shopify. Three separate jobs do:

| | What it is | Runs for | Job |
|---|---|---|---|
| `backfill-background` | Background function | up to 15 min | One-time seed of the 90-day window. Checkpoints its Shopify cursor after every page, so a run that gets cut short resumes instead of restarting. |
| `scheduled-sync` | Scheduled function | every 15 min | Pulls only orders whose `updated_at` moved since the last sync. Normally a handful of orders. |
| `data` | Regular function | ~200 ms | Reads storage, classifies, aggregates, returns JSON. **Makes no Shopify calls**, so the 10-second function ceiling never applies to it. |

That split is what makes 90 days work on a platform with no always-on server. The expensive work happens on a schedule with a 15-minute budget; the read path is a blob fetch.

Storage is Netlify Blobs, which survives deploys and cold starts:

```
orders   m/<YYYY-MM>   { orderId: order }              non-POS orders, in full
orders   p/<YYYY-MM>   { YYYY-MM-DD: {revenue,orders} } POS, collapsed to day totals
meta     watermark     last successful sync
meta     backfill      cursor + progress
meta     lock          stops a cron tick and a manual refresh overlapping
```

POS is 90%+ of order volume and the dashboard only ever shows it as one reference figure, so it is collapsed to per-day totals. That keeps every month shard small enough to read and rewrite well inside a function's time budget.

**This is near-real-time, not live.** Data is as old as the last sync — the header says exactly how old, and **Refresh now** pulls immediately when you need current numbers.

---

## Deploying

### 1. Push to GitHub

```bash
git init && git add -A && git commit -m "Order Mix dashboard"
gh repo create clb23-dashboard --private --source=. --push
```

### 2. Create the Netlify site

Netlify → **Add new site → Import an existing project** → pick the repo.
Build settings come from `netlify.toml`; nothing to fill in.

### 3. Set environment variables

**Site configuration → Environment variables.** The Shopify token only ever lives here — it is read server-side and never reaches the browser.

| Variable | Value |
|---|---|
| `SHOPIFY_SHOP` | `clb-xxiii.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | your custom app's `shpat_…` token |
| `DASHBOARD_PASSWORD` | the shared login password |
| `SESSION_SECRET` | any long random string |
| `ADMIN_KEY` | any long random string |

Optional: `COVERAGE_DAYS` (default 90), `SYNC_CRON` (default `*/15 * * * *`), `SYNC_INTERVAL_MINUTES` (default 15), `STORE_TIMEZONE` (default `America/New_York`).

If `DASHBOARD_PASSWORD` is missing the gate refuses every request rather than failing open.

### 4. Seed it once

Open the site, sign in, and click **Run backfill**. It runs in the background — a 90-day seed takes a few minutes and the page picks up progress on its own.

Equivalently: `curl -X POST https://<your-site>.netlify.app/api/backfill -H "x-admin-key: $ADMIN_KEY"`

The 15-minute cron takes over from there.

### 5. Check it

- Header shows **updated just now**
- The three tiles sum to **Non-POS revenue** in the strip below them
- Spot-check one order number against Shopify admin

To re-seed from scratch later: `POST /api/backfill?restart=1`.

---

## Cost

Netlify's free plan is 300 credits/month; functions bill at 10 credits per GB-hour.

| | ≈ credits/month |
|---|---|
| Sync every 15 min | 16 |
| Dashboard polling (one tab, 8 h/day) | 8 |
| **Total** | **~25 of 300** |

Dropping to a 30-minute sync halves the first line. Running it every minute would cost ~240 and crowd out builds and bandwidth, which is why 15 minutes is the default.

---

## The assisted rule

**`lib/classify.js` is the only file you need to edit to change how orders are bucketed.**

The shipped rule is a placeholder inferred from live order notes — `Credit to Erik`, `Credit: Ruby`, `Credit: JR`. Five signals are wired up and individually switchable:

| Signal | Default | Matches |
|---|---|---|
| `noteCredit` | **on** | a staff-credit note on the order |
| `tags` | off | order carries `assisted`, `clienteling`, … |
| `draftOrigin` | off | every draft order counts as assisted |
| `lastClickChannel` | off | last click came from email or SMS |
| `draftInvoiceLanding` | off | checkout was a draft-order invoice link |

`mode: 'any'` = assisted if any enabled signal matches; `'all'` = every one must.

**Exclusive vs Overlay.** Exclusive (default) pulls an assisted order out of Online/Draft so the three tiles sum to the non-POS total. Overlay counts it in both, so the tiles deliberately sum to more.

POS is excluded from all three tiles and shown only as a reference figure — both bucket rules are "non-POS".

---

## Working on it locally

```bash
npm install

npm run check          # 29 unit checks — no credentials needed
npm run smoke          # 27 end-to-end checks against the real handlers

MOCK_DATA=1 npm run dev:local     # fixture data at localhost:8787
npm run dev:local                 # real Shopify (needs .env)
npm run dev                       # netlify dev, if you have the CLI
```

`dev:local` runs the same function handlers Netlify runs, backed by `./.blobs` on disk, so you can work on the dashboard without the Netlify CLI or any cloud setup.

---

## Layout

```
public/index.html                          the dashboard (single file)
netlify/functions/data.mjs                 GET  /api/data     read + aggregate
netlify/functions/appconfig.mjs            GET  /api/config
netlify/functions/status.mjs               GET  /api/status
netlify/functions/sync-now.mjs             POST /api/sync-now  Refresh now
netlify/functions/scheduled-sync.mjs       cron, every 15 min
netlify/functions/backfill-background.mjs  POST /api/backfill
netlify/functions/login.mjs                POST /api/login
netlify/edge-functions/gate.js             password gate, in front of everything
lib/classify.js                            <-- bucket rules live here
lib/shopify.js                             Admin GraphQL client
lib/repo.js                                storage layout
lib/blobs.js                               Netlify Blobs / local disk
lib/payload.js                             stored orders -> dashboard JSON
lib/sync.js                                incremental sync
lib/auth.js                                session cookie signing
```

## Known limits

- Ranges older than `COVERAGE_DAYS` are refused — that data was never stored. Raise it and re-run the backfill.
- Scheduled functions only run on published production deploys, not deploy previews.
- Shopify's `staffMember` field needs the `read_users` scope, which the custom app doesn't have. Not required: staff credit is read from order notes instead.
