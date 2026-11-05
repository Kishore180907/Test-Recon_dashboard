/* =============================================================================
 *  GET /api/budget[?end=YYYY-MM-DD]
 *  ---------------------------------------------------------------------------
 *  What to spend next week, worked out from stored orders and stored Meta
 *  spend. Storage only — it never calls Shopify or Meta, which is what makes it
 *  safe on the render path and is the same rule /api/data follows.
 *
 *  The window is the last seven COMPLETE days. `?end=` moves it for a
 *  back-test; the default is yesterday in store time.
 * ========================================================================== */

import { readOrders, readMetaInsights, getWatermark } from '../../lib/repo.js';
import { isPOS } from '../../lib/classify.js';
import { metaConfigured, metaCredentialMode } from '../../lib/meta.js';
import {
  buildBudgetReport,
  budgetSettings,
  budgetWindow,
  META_JOIN_LOOKBACK_DAYS,
} from '../../lib/budget.js';
import { daysAgoLocal, STORE_TZ } from '../../lib/timezone.js';
import { COVERAGE_DAYS, coverageWindow } from '../../lib/sync.js';
import { shiftDays } from '../../public/ranges.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);
  const asked = url.searchParams.get('end');
  const end = asked || daysAgoLocal(1);

  if (!DATE_RE.test(end)) return json(400, { error: 'end must be YYYY-MM-DD' });

  const today = daysAgoLocal(0);
  if (end >= today) {
    return json(400, {
      error: `end must be a complete day — ${today} is still running in ${STORE_TZ}`,
    });
  }

  const win = budgetWindow(end);
  const cover = coverageWindow();
  if (win.start < cover.start) {
    return json(400, {
      error: `Outside the ${COVERAGE_DAYS}-day coverage window (earliest ${cover.start})`,
      coverage: cover,
    });
  }

  try {
    /* Meta insights are read over a longer window than the report covers. The
     * extra days are only ever used to put a campaign ID on a name — a
     * campaign that was quiet all week is still the same campaign, and
     * without the lookback its orders would group under a bare name and never
     * meet their own spend. Spend itself is taken from the seven days only. */
    const joinFrom = shiftDays(win.start, -META_JOIN_LOOKBACK_DAYS);
    const insightsFrom = joinFrom < cover.start ? cover.start : joinFrom;

    const [orders, insights, watermark] = await Promise.all([
      readOrders(win.start, win.end),
      readMetaInsights(insightsFrom, win.end),
      getWatermark(),
    ]);

    const report = buildBudgetReport({
      // POS sales have no touchpoint to credit and no ad behind them.
      orders: orders.filter((o) => !isPOS(o)),
      metaInsights: insights,
      window: win,
      metaConnected: metaConfigured(),
      settings: budgetSettings(),
    });

    return json(200, {
      ...report,
      timezone: STORE_TZ,
      coverage: cover,
      generatedAt: new Date().toISOString(),
      syncedAt: watermark?.lastSyncAt || null,
      metaAds: { credentials: metaCredentialMode() },
    });
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/budget' };
