# Order Mix — build and operations handover

Everything needed to run, change, deploy and debug the CLB XXIII Order Mix dashboard, plus the history that explains why several pieces look the way they do.

`README.md` is the five-minute version. This is the whole thing.

- **Live:** https://leadrecon.netlify.app (password gated)
- **Repo:** `github.com/Kishore180907/Test-Recon_dashboard`, branch `main`
- **Host:** Netlify project `leadrecon`, team `Test`, free plan
- **Store:** `clb-xxiii.myshopify.com`, timezone `America/New_York`

---

## 1. What it does

Splits store revenue three ways and lets you click into the orders behind each number.

| Bucket | Rule |
|---|---|
| **Ecommerce** | Not a draft order, no staff credit note. The customer served themselves, through any digital channel — Online Store, Shop app, StockX, Facebook & Instagram, Marketplace Connect, Shopify Mobile. See `ECOMMERCE_APPS` in `lib/classify.js`. |
| **Assisted** | A human moved the sale along — a staff credit note on the order, or a draft order whose customer journey shows a marketing or ad touchpoint. |
| **Draft** | A draft order where **both** touchpoints are Direct. Nobody's marketing brought them in; someone at the store wrote the order up. |

POS is excluded from all three and shown once as a reference figure. It is 90%+ of order volume and would drown everything else.

The bucket's internal key is still `online` throughout the API, the payload and the daily series — only the label changed. Renaming the key would break every stored payload and both test suites for no gain.

**Reconciling against Shopify Analytics.** The tiles sum `netPaymentSet` — cash actually collected, after refunds. Shopify's `net_sales` is gross minus discounts minus returns, *before* shipping and tax, and counts unpaid draft invoices at full value. The two will not match, and the gap is roughly the size of your open drafts. Shopify's own "E-Commerce" channel line is narrower still: it excludes Shop app, StockX and draft orders, which this dashboard counts. Compare the **Non-POS revenue** strip, never a single tile, against **all channels minus POS locations**.

Each order carries first click, last click, traffic source, how it converted, the campaign, and whether Meta was billing for that campaign at the time.

**This is near-real-time, not live.** The header states how old the data is. **Refresh now** pulls immediately.

### The rule that took the most iteration

Draft and Assisted overlap heavily — most draft orders carry a staff credit note, so a naive rule puts nearly every draft in Assisted and empties the Draft tile. The store's actual question is *who created the demand*, so the split is attribution:

> A draft order keeps the Draft credit only when both touchpoints are Direct. If either touchpoint came from a marketing or ad platform, the sale was marketing-influenced and belongs in Assisted.

An order with no journey data at all counts as neutral and stays in Draft — Shopify simply never resolved a source, which is not evidence of marketing. `DRAFT_ATTRIBUTION_RULE.neutralSources` in `lib/classify.js` is where that judgement lives; drop `'no journey data'` from the list to flip it.

---

## 2. Architecture

The browser never talks to Shopify or Meta. Three jobs with very different time budgets do:

```
                    ┌──────────────────────────────────────────┐
   Shopify Admin ──▶│  backfill-background   up to 15 min      │
   GraphQL          │  one-time 90-day seed, cursor checkpoint │──┐
                    └──────────────────────────────────────────┘  │
                    ┌──────────────────────────────────────────┐  │
   Shopify + Meta ─▶│  scheduled-sync        every 15 min, 30s │──┤
                    │  only what changed since the watermark   │  │
                    └──────────────────────────────────────────┘  │
                                                                  ▼
                                                        ┌───────────────────┐
                                                        │  Netlify Blobs    │
                                                        │  orders / ads /   │
                                                        │  meta             │
                                                        └───────────────────┘
                                                                  │
                    ┌──────────────────────────────────────────┐  │
   Browser ────────▶│  data                  ~200 ms           │◀─┘
                    │  reads blobs, classifies, aggregates     │
                    │  NEVER calls Shopify                     │
                    └──────────────────────────────────────────┘
```

That split is the whole trick. Netlify has no always-on server and caps regular functions at 10 seconds. Fetching 90 days of orders takes minutes, so it happens on a schedule inside a background function's 15-minute budget, and the read path the browser hits is a blob fetch that cannot time out.

### Storage layout

Netlify Blobs, which survives deploys and cold starts. Three stores:

```
orders   m/<YYYY-MM>   { orderId: order }                    non-POS orders, in full
orders   p/<YYYY-MM>   { YYYY-MM-DD: {entries,orders,revenue} }  POS, collapsed to day totals
ads      a/<YYYY-MM>   { "<date>|<campaignId>": insightRow } Meta campaign-days
meta     watermark     last successful sync + what it did
meta     backfill      cursor, page count, progress
meta     lock          stops a cron tick and a manual refresh overlapping
meta     shopify-token cached client-credentials token + expiry
```

Month sharding keeps each read-modify-write small enough to finish inside a function's budget. A 90-day window touches at most four shards.

POS orders are keyed by order id inside each day bucket and the day total is re-derived on every write, so re-syncing the same order updates its amount instead of double-counting it.

**`meta` here means metadata, not Meta the advertiser.** The ad data lives in `ads`. The names predate the Meta integration and renaming the store would orphan everything already written under it.

### Two rules that are load-bearing

Both were learned in production and both have a comment in the source saying so. Do not undo either without reading section 8.

1. **Every blob read uses strong consistency.** Eventually-consistent reads broke a read-modify-write and silently dropped 19 days of orders.
2. **The Blobs store handle is rebuilt on every call, never cached at module scope.** A cached handle closes over an auth token that expires while a warm container keeps reusing it.

---

## 3. Every file

```
public/index.html                          the entire dashboard — markup, CSS, JS, guide
public/guide/*.png                         six screenshots the in-page guide uses
public/favicon.svg

netlify/edge-functions/gate.js             password gate, runs in front of everything
netlify/functions/data.mjs                 GET  /api/data      read + classify + aggregate
netlify/functions/appconfig.mjs            GET  /api/config    rules and defaults for the UI
netlify/functions/status.mjs               GET  /api/status    sync + backfill health
netlify/functions/sync-now.mjs             POST /api/sync-now  the Refresh now button
netlify/functions/scheduled-sync.mjs       cron, every 15 minutes
netlify/functions/backfill-background.mjs  POST /api/backfill  one-time 90-day seed
netlify/functions/login.mjs                POST /api/login

lib/classify.js      ← THE ONLY FILE TO EDIT TO CHANGE BUCKETING
lib/payload.js       stored orders → the JSON the dashboard renders; the Meta join
lib/repo.js          storage layout, month shards, watermark, lock
lib/blobs.js         Netlify Blobs in production, ./.blobs on disk locally
lib/shopify.js       Admin GraphQL client, order normalisation
lib/meta.js          Meta Graph API client and the campaign join key
lib/token.js         Shopify credentials — static token or client-credentials exchange
lib/sync.js          incremental sync, coverage window, the Meta pass
lib/auth.js          session cookie signing (Web Crypto, runs in Node and Deno)
lib/timezone.js      store-local dates — every date in the app is New York, not UTC

fixtures/sample-orders.js   34 real non-POS orders + 6 POS, Aug 11–17
fixtures/sample-meta.js     matching Meta campaign-days, in raw Graph API shape

scripts/selftest.js         55 unit checks, no credentials needed
scripts/smoke.js            32 end-to-end checks against the real handlers
scripts/dev-server.js       runs the real function handlers locally against ./.blobs
scripts/capture-guide.mjs   regenerates the guide screenshots

netlify.toml         build, function timeouts, the cron, security headers
.env.example         every variable, documented
```

### Where to make common changes

| Want to change | Edit |
|---|---|
| What counts as Assisted or Draft | `lib/classify.js` — nothing else reads those rules |
| How far back the dashboard can look | `COVERAGE_DAYS` env var, then re-run the backfill |
| Sync frequency | `netlify.toml` `[functions."scheduled-sync"] schedule` **and** `SYNC_INTERVAL_MINUTES` (the header label) |
| A column in the order table | `public/index.html` `renderTable()`, and `slim()` in `lib/payload.js` to supply the field |
| The in-page guide | the `<section>` blocks inside `#guide-body` in `public/index.html` |
| Guide screenshots | `npm run guide:capture` against a local dev server |

---

## 4. Environment variables

Set in **Netlify → Site configuration → Environment variables**. Never in the repo — `.gitignore` excludes `.env`, and secrets are read server-side only and never reach the browser.

### Currently set

| Variable | Purpose |
|---|---|
| `SHOPIFY_SHOP` | `clb-xxiii.myshopify.com` — the permanent myshopify domain, not `clb23.com` |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard app client id |
| `SHOPIFY_CLIENT_SECRET` | exchanged for a ~24h token the app refreshes itself |
| `DASHBOARD_PASSWORD` | the shared login password |
| `SESSION_SECRET` | any long random string; changing it signs everyone out |
| `ADMIN_KEY` | lets the backfill re-invoke itself past the edge gate |

### Not set — code defaults apply

`COVERAGE_DAYS` 90 · `SYNC_INTERVAL_MINUTES` 15 · `STORE_TIMEZONE` America/New_York · `SHOPIFY_API_VERSION` 2026-07 · `BACKFILL_PAGE_SIZE` 100

### Meta Ads — not set yet, required for the campaign panel

| Variable | Value |
|---|---|
| `META_ACCESS_TOKEN` | a system-user token with `ads_read`, expiry Never |
| `META_AD_ACCOUNT_ID` | `785918962523487` (CLB XXIII) |

To create the token: business.facebook.com → Business settings → Users → System users → Add. Assign assets → Ad accounts → `785918962523487` with *View performance*. Generate token, scope `ads_read`, expiry Never.

Until both are set the campaign panel hides itself, `/api/status` reports `metaAds.credentials: "none"`, and every other number is unaffected.

> **Netlify only picks up environment changes on a new deploy.** Adding a variable does nothing until you redeploy. This catches everyone.

### Shopify credentials — two routes, and why we're on the second

`lib/token.js` picks automatically:

- `SHOPIFY_ADMIN_TOKEN` set → used as-is. A permanent `shpat_…` token from an admin-created custom app. Simpler, but **Shopify stopped allowing new custom apps to be created as of 1 January 2026**, which closed this route off for us.
- `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` → exchanged for a token via the client-credentials grant. Shopify issues roughly 24-hour tokens, so the app caches one in the `meta` store with its expiry and refreshes ten minutes before it lapses. Every function shares that cache, so it is fetched about once a day rather than once per invocation.

Scopes needed: `read_orders`, `read_all_orders` (required for anything older than 60 days), `read_draft_orders`, `read_customers`. `read_users` is deliberately **not** requested — it would give Shopify's `staffMember` field, but staff credit is read from order notes instead.

The client-credentials grant only issues tokens for an app that is **installed on the store**. An app with zero installs returns `400 Oauth error app_not_installed`, and installing it needs store-owner permission — a staff account gets "Ask the store owner to install this app".

---

## 5. Deploying

### The pipeline

Push to `main` → Netlify builds from base directory `app 2` → publishes to `leadrecon.netlify.app`. There is no build step worth the name: the build command is `echo`, and all Netlify really does is bundle seven functions and one edge function with esbuild. About 18 seconds end to end.

### Netlify build settings

| Setting | Value |
|---|---|
| Base directory | `app 2` |
| Functions directory | `app 2/netlify/functions` |
| Build command | from `netlify.toml` — `echo 'static site — functions build themselves'` |
| Publish directory | from `netlify.toml` — `public`, resolved to `app 2/public` |
| Auto publishing | on |

### Standing up a fresh copy

1. Push the repo to GitHub.
2. Netlify → **Add new site → Import an existing project** → pick the repo. Build settings come from `netlify.toml`.
3. Set the environment variables from section 4.
4. Open the site, sign in, click **Run backfill** — or
   `curl -X POST https://<site>.netlify.app/api/backfill -H "x-admin-key: $ADMIN_KEY"`.
   A 90-day seed is roughly 29 pages and finishes in well under a minute; the page picks up progress on its own.
5. The 15-minute cron takes over.

To re-seed from scratch later: `POST /api/backfill?restart=1`.

### Checking a deploy worked

- Header reads **updated just now**
- The three tiles sum exactly to **Non-POS revenue** in the strip below them
- Spot-check one order number against Shopify admin
- `/api/status` → `ready: true`, `credentials` not `"none"`

### Two deploy traps already hit

**Builds always run — on purpose.** `netlify.toml` sets `ignore = "/bin/false"`. Netlify normally skips a build when nothing changed inside the base directory, but it decides that with a `git diff` against the base directory, and this base directory is named `app 2`. The space breaks the match, so the diff found nothing and Netlify cancelled **every push for two days** with *"no content change"* while the site quietly kept serving a commit from 21 August. GitHub showed the fixes merged; none of them were live. Exiting non-zero tells Netlify never to skip. The build is a two-second echo, so nothing is lost by always running it — but see section 7, because it does mean every push costs a deploy.

**Renaming `app 2` is the real fix.** The folder is named that because of a macOS duplicate-rename. Rename it, clear the base directory setting to match, and the `ignore` line can come out.

---

## 6. Running it day to day

### Endpoints

| Route | Method | What it does |
|---|---|---|
| `/api/data?start=&end=&exclusive=` | GET | The dashboard payload. Reads storage only. |
| `/api/status` | GET | Sync age, backfill state, credential mode. |
| `/api/config` | GET | Rules and defaults the UI renders. |
| `/api/sync-now` | POST | Refresh now. 26-second timeout. |
| `/api/backfill?restart=1` | POST | Re-seed. Background function, needs `x-admin-key`. |
| `/api/login` | POST | Issues the session cookie. |

### Access

An edge function gates `/*`. No valid cookie means the login screen for a page request and `401 JSON` for an API request. Sessions are signed with HMAC over `SESSION_SECRET` using Web Crypto, which is why the same code runs in both the Node functions and the Deno edge runtime. If `DASHBOARD_PASSWORD` is missing the gate refuses everything rather than failing open.

### Local development

```bash
npm install

npm run check          # 55 unit checks, no credentials
npm run smoke          # 32 end-to-end checks against the real handlers

MOCK_DATA=1 npm run dev:local     # fixture data at localhost:8787
npm run dev:local                 # real Shopify, needs .env
```

`dev:local` runs the same handlers Netlify runs, backed by `./.blobs` on disk. No Netlify CLI, no cloud setup, no credentials. `MOCK_DATA=1` also serves the Meta fixture, so the campaign join works offline.

Run both suites before every push. They catch the two regressions that have actually happened here — stale-read data loss and bucket misclassification — and they cost nothing.

---

## 7. Cost

Netlify free plan: **300 credits/month**. The only thing that meaningfully consumes them is deploys.

Measured on this project, billing period 30 July – 29 August:

| | |
|---|---|
| Production deploys | 17 deploys · **255 credits** |
| Web requests | 433 requests · 0.1 |
| Compute (functions, including the cron) | 0.5 |
| Bandwidth | <1 |

**A deploy costs about 15 credits, flat.** An 18-second build costs the same as a five-minute one — it is per deploy, not per second. Everything the dashboard does while running — the sync, page loads, blob storage — came to 0.6 credits in a month. Running it is effectively free; the entire bill is development churn.

Two consequences:

- **Turning off auto publishing saves nothing.** Locking a site stops a build going *live*; the build still runs and still bills.
- **Batch your pushes.** Cancelled builds appear not to bill, but every real one does. Committing four files in four commits costs four times what one commit costs.

The single biggest saving available: work from a real local clone instead of GitHub's web uploader. The web uploader commits one directory at a time, which is why one afternoon's work became thirteen deploys.

---

## 8. Things that broke, and why the fix looks like that

Read this before "simplifying" anything in the list.

**Stale reads silently deleted 19 days of orders.** The backfill writes one page at a time and each page is a read-modify-write on the same month shard, seconds apart. Eventually-consistent reads returned a stale copy, and writing it back dropped everything the earlier pages had added — 462 orders fetched, a fraction stored, and no error anywhere. Fixed by reading with strong consistency, with a regression test that splits the fixture into four batches and asserts every order survives.

**A cached store handle took the dashboard down.** `/api/data` started returning `500 Failed to decode token: Token expired` while the backfill, reading the same shards, was fine. The Blobs store handle was cached at module scope, and it closes over the auth token from the invocation that created it. `/api/data` is polled every two minutes by any open dashboard, so its container never went cold and kept reusing an expired token; rarely-invoked functions got a cold container and a fresh token every time. That asymmetry is the whole tell. The handle is now rebuilt on every call — `getStore()` only parses environment config, so it is cheap.

**A location check swallowed 30 draft orders.** `isPOS()` treated any order with a retail location as POS. Plenty of non-POS orders carry one — a draft written up in a store, an online order fulfilled from one — so those orders fell out of every bucket. Shopify showed 39 drafts; the dashboard showed 9. Every genuine POS order carries `sourceName: 'pos'`, app `Point of Sale` and channel handle `pos`, so the location test bought nothing and cost accuracy.

**The scheduled sync never ran.** `scheduled-sync.mjs` declared `config = { schedule: process.env.SYNC_CRON || '*/15 * * * *' }`. Netlify reads an in-code config by parsing the source at build time rather than executing it, so a computed expression is not something it can recognise as a cron string. The function deployed, appeared healthy, and was simply never registered on a schedule — no invocations across the whole 24-hour log retention window, and a watermark whose last writer was always a manual refresh. Found while writing this document, by noticing the dashboard was eleven hours stale.

Declaring the schedule in `netlify.toml` under `[functions."scheduled-sync"]` **did not fix it** — the toml block is kept because it documents the intent, but Netlify still did not fire the function. Only a **string literal in the function's own `config` export** works. Change the interval by editing that literal, not by adding an environment variable; there deliberately is no env var for it, because that is the trap that caused this.

**Netlify cancelled every push for two days.** See section 5.

**A test that passed or failed depending on luck.** The "a tampered token is rejected" check flipped the signature's last character to `'0'` — a no-op whenever the signature already ended in `'0'`. Now it flips to a guaranteed-different character.

**A false alarm worth remembering.** Order #27652 looked missing from every bucket. It was not: Shopify's admin dates it 22 August because it was created at 00:42 UTC, which is 20:42 on the 22nd in New York. Every date in this app is store-local. When an order looks like it is in the wrong day, check the timezone before checking the code.

---

## 9. The Meta Ads join

### What is and is not possible

Meta's Insights API reports **aggregates — per campaign, per day**. It never returns an order id, an email, or a timestamp for an individual purchase. So an order cannot be matched to a Meta purchase "by the time and date it happened": there is no per-purchase record on Meta's side to match against, and two orders in the same hour are indistinguishable in the response.

What joins cleanly is the **campaign**. Shopify records `utm_campaign` on the customer journey and it is the Meta campaign name verbatim. Verified against live data: `CLB_Broad_Catalog_AJ_06/19` and `CLB_Broad_Catalog_500_07/24` appear identically on both sides, and the latter's Meta purchase value of $405.75 is order #27657 to the cent.

The join key (`campaignKey()` in `lib/meta.js`) is deliberately punctuation- and encoding-insensitive. Meta names carry stray spaces the ad manager typed — `CLB_Sales_LV_ P9 _40_07/16` — while the same name arrives from Shopify URL-encoded. Decoding happens **before** collapsing, because a percent escape looks alphanumeric once the percent sign is stripped and `07%2F16` would otherwise key as `07-2f16`.

### Reading the comparison

The two columns are **expected to disagree**, and the disagreement is the point. Meta counts view-through and cross-device purchases that reach the storefront with no campaign attached, which Shopify then credits to Direct. A campaign where Meta reports purchases and Shopify reports none is not a broken join — it is the case for treating a Direct order in that window as ad-influenced.

Worked example from the live account, 17–23 August:

| Campaign | Meta | Shopify last click | Gap |
|---|---|---|---|
| CLB_Broad_Catalog_AJ_06/19 | 4 purchases · $3,480 · $870 spend | 3 · $1,690 | +1 |
| CLB_Broad_Catalog_500_07/24 | 1 · $405.75 · $176 spend | 2 · $1,222.31 | −1 |
| CLB_Sales_LV_ P9 _40_07/16 | 5 · $3,679 · $262 spend · 14.0× | 0 | +5 |

That last row is the interesting one: five purchases Shopify credits somewhere else entirely.

### How it refreshes

The backfill seeds the full 90 days in one request. Each 15-minute sync re-pulls a **trailing seven days**, because Meta keeps revising a day's numbers for roughly 72 hours as attribution settles — re-reading only "today" would leave figures on screen that Ads Manager has since corrected. Rows are keyed by date + campaign id so a re-sync overwrites rather than accumulates.

`syncMetaAds()` never throws. Meta is supplementary evidence; if the token lapses the order dashboard must still render. The failure is recorded in the watermark so `/api/status` can say so out loud instead of leaving stale ad numbers looking current.

---

## 10. Known limits

- Ranges older than `COVERAGE_DAYS` are refused — that data was never stored. Raise it and re-run the backfill.
- Scheduled functions only run on published production deploys, not deploy previews.
- Shopify's `staffMember` needs the `read_users` scope we do not request. Staff credit comes from order notes instead.
- Netlify function logs are retained for 24 hours. Anything older is gone.
- The repo is public. Nothing secret is in it, but it should be private.
- `clb23-dashboard-netlify_1.zip` is still committed at the repo root and should be deleted.

## 11. Open items

| | |
|---|---|
| **Push the string-literal cron in `scheduled-sync.mjs`** | committed locally, not yet deployed — until it ships the sync only runs when someone presses Refresh now |
| Add `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID`, then redeploy | campaign panel stays hidden until then |
| Rename `app 2`, clear the base directory, drop the `ignore` line | removes the deploy trap at its root |
| Move to a local git clone | one commit per change instead of one per directory |
| Make the repo private, delete the committed zip | |
