/* POST|GET /api/backfill — one-time seed of the coverage window.
 * -----------------------------------------------------------------------
 * Background function: 15 minutes of runtime instead of the usual 10 seconds.
 * The Shopify cursor is checkpointed to storage after every page, so if a run
 * is cut short it resumes exactly where it stopped rather than starting over.
 * When it nears its time budget it re-invokes itself and hands off the cursor.
 */

import { fetchOrdersPage, buildBackfillQuery, fetchOrderChannels } from '../../lib/shopify.js';
import { localDayToUTC } from '../../lib/timezone.js';
import { upsertOrders, getBackfill, setBackfill, setWatermark, setOrderChannels } from '../../lib/repo.js';
import { coverageWindow, COVERAGE_DAYS, syncMetaAds } from '../../lib/sync.js';

const TIME_BUDGET_MS = 12 * 60 * 1000; // leave slack inside the 15-minute cap
const PAGE_SIZE = Number(process.env.BACKFILL_PAGE_SIZE) || 100;
const HARD_PAGE_CAP = 400;

export default async (req) => {
  const url = new URL(req.url);
  const restart = url.searchParams.get('restart') === '1';
  const startedAt = Date.now();

  let state = await getBackfill();
  if (restart || !state || state.status === 'error') {
    state = null;
  }
  if (state?.status === 'done' && !restart) {
    console.log('[backfill] already done');
    return new Response('already done');
  }
  if (state?.status === 'running' && Date.now() - (state.heartbeatAt || 0) < 90_000) {
    console.log('[backfill] another run is active');
    return new Response('already running');
  }

  const cover = coverageWindow();
  const q = buildBackfillQuery({
    startISO: localDayToUTC(cover.start, 'start'),
    endISO: localDayToUTC(cover.end, 'end'),
  });

  let cursor = state?.cursor ?? null;
  let pages = state?.pages ?? 0;
  let nonPos = state?.nonPos ?? 0;
  let pos = state?.pos ?? 0;

  const write = (extra) =>
    setBackfill({
      status: 'running',
      coverage: cover,
      days: COVERAGE_DAYS,
      cursor,
      pages,
      nonPos,
      pos,
      startedAt: state?.startedAt || new Date().toISOString(),
      heartbeatAt: Date.now(),
      ...extra,
    });

  await write({});

  try {
    for (;;) {
      const page = await fetchOrdersPage({ q, after: cursor, pageSize: PAGE_SIZE });
      const merged = await upsertOrders(page.orders);
      nonPos += merged.nonPos;
      pos += merged.pos;
      pages += 1;
      cursor = page.endCursor;

      await write({});
      console.log(`[backfill] page ${pages} · +${merged.nonPos} non-POS · +${merged.pos} POS`);

      if (!page.hasNextPage) {
        await setBackfill({
          status: 'done',
          coverage: cover,
          days: COVERAGE_DAYS,
          cursor: null,
          pages,
          nonPos,
          pos,
          startedAt: state?.startedAt || new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        // Seed Meta over the same window while we are here. It is one request
        // for the whole 90 days, and doing it now means the campaign comparison
        // is populated the first time the dashboard loads rather than waiting
        // for the next cron tick. Never throws — see syncMetaAds.
        const meta = await syncMetaAds({ coverage: cover, seeded: false });
        console.log(
          meta.ok
            ? `[backfill] meta · ${meta.rows} campaign-days · ${meta.campaigns} campaigns`
            : `[backfill] meta skipped · ${meta.reason}${meta.error ? ` · ${meta.error}` : ''}`
        );

        // Seed the order -> sales channel map too. Without it the first render
        // buckets mobile-app drafts as Draft, and the Ecommerce tile is short by
        // the size of that channel until the next sync.
        let channels = null;
        try {
          const map = await fetchOrderChannels(cover.start, cover.end);
          if (map.size) {
            channels = { count: map.size, at: Date.now() };
            await setOrderChannels(Object.fromEntries(map));
          }
          console.log(`[backfill] channels · ${map.size} orders`);
        } catch (err) {
          console.log(`[backfill] channels skipped · ${err.message}`);
        }

        await setWatermark({
          lastSyncAt: Date.now(),
          lastSyncISO: new Date().toISOString(),
          by: 'backfill',
          fetched: nonPos + pos,
          nonPos,
          pos,
          meta,
          channels,
          coverage: { ...cover, days: COVERAGE_DAYS },
        });
        console.log(`[backfill] done · ${pages} pages · ${nonPos} non-POS · ${pos} POS`);
        return new Response('done');
      }

      if (pages >= HARD_PAGE_CAP) {
        await write({ status: 'error', error: `page cap ${HARD_PAGE_CAP} reached` });
        return new Response('page cap reached', { status: 500 });
      }

      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        console.log('[backfill] time budget reached — handing off');
        await handOff(url);
        return new Response('handed off');
      }
    }
  } catch (err) {
    console.error('[backfill] failed', err);
    await write({ status: 'error', error: String(err?.message || err) });
    return new Response('error', { status: 500 });
  }
};

/** Re-invoke this same background function so it can pick up the saved cursor. */
async function handOff(url) {
  const next = new URL('/api/backfill', url.origin);
  await fetch(next, {
    method: 'POST',
    headers: { 'x-admin-key': process.env.ADMIN_KEY || '' },
  }).catch((e) => console.error('[backfill] hand-off failed', e));
}

export const config = { path: '/api/backfill' };
