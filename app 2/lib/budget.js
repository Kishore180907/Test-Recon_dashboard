/* =============================================================================
 *  BUDGET REPORT
 *  ---------------------------------------------------------------------------
 *  What to spend next week on Meta and Google, worked out from orders this
 *  store actually recorded rather than from what the ad platforms claim.
 *
 *  Pure functions. No network, no storage, no clock of its own — the window is
 *  passed in. netlify/functions/budget.mjs does the reading.
 *
 *  THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 *  1. A referral is not an ad. A plain google.com or instagram.com visit with
 *     no tagging on it is organic traffic, and budgeting against it would have
 *     the store paying for clicks it already gets free. Those sales are
 *     reported — they are a real part of the week — and never divided by a
 *     target ROAS. The split between "paid" and "organic" is the whole point
 *     of classifyTouch(), and it errs towards organic: evidence of payment has
 *     to be present, not merely absent-of-contradiction.
 *
 *  2. Every dollar lands exactly once. Paid media, organic Google, organic
 *     Meta and direct/other sum to the recorded total, and the test suite
 *     asserts it on the fixtures. An order split between two touchpoints
 *     contributes half to each side, so a sale found by an ad and closed from
 *     a bookmark shows up as half an ad sale rather than as a whole one or
 *     none.
 *
 *  3. A recommendation is a nudge, not a lever. Weekly spend may move at most
 *     ±BUDGET_MAX_WEEKLY_CHANGE from where it is, because a week of orders is
 *     a small sample and the honest reaction to a good week is to lean in, not
 *     to triple the budget. Under three orders the row says so out loud.
 * ========================================================================== */

import { campaignKey } from './meta.js';
import { localDateOf } from './timezone.js';
import { shiftDays } from '../public/ranges.js';

/** The window is seven COMPLETE days. Today is excluded deliberately: a day
 *  that is still running always looks like a collapse in trade. */
export const BUDGET_WINDOW_DAYS = 7;

/** How far back to look for a Meta campaign id when joining by name. Campaign
 *  names outlive any one week of spend, so a campaign that was quiet in the
 *  window can still be identified from an earlier run. */
export const META_JOIN_LOOKBACK_DAYS = 60;

export const NO_CAMPAIGN = '(no campaign tag)';

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ---------------------------------------------------------------------------
 *  Settings
 * ------------------------------------------------------------------------- */

/**
 * Everything tunable, in one place, read from the environment.
 *
 * Defaults rather than required values: a dashboard that refuses to render
 * until someone sets a target ROAS is a dashboard nobody sets a target ROAS
 * for. 4× is the figure this store works to.
 */
export function budgetSettings(env = process.env) {
  const g = env.GOOGLE_ADS_WEEKLY_SPEND;
  return {
    targetRoas: {
      meta: num(env.BUDGET_TARGET_ROAS_META, 4),
      google: num(env.BUDGET_TARGET_ROAS_GOOGLE, 4),
    },
    maxWeeklyChange: num(env.BUDGET_MAX_WEEKLY_CHANGE, 0.3),
    /* Google Ads has no connector here, so the only way the report can know
     * what is being spent is for someone to type it in once. Left unset, the
     * Google tile says "not connected" rather than inventing a baseline. */
    googleWeeklySpend: g == null || String(g).trim() === '' ? null : num(g, null),
  };
}

/** The seven complete days ending on `end` (default: the caller's yesterday). */
export function budgetWindow(end) {
  const e = String(end);
  return { start: shiftDays(e, -(BUDGET_WINDOW_DAYS - 1)), end: e, days: BUDGET_WINDOW_DAYS };
}

/* ---------------------------------------------------------------------------
 *  Reading a touchpoint
 * ------------------------------------------------------------------------- */

const META_SOURCES = new Set(['facebook', 'fb', 'instagram', 'ig', 'meta', 'messenger']);
const GOOGLE_SOURCES = new Set(['google', 'youtube']);

/* Matched as whole tokens with a prefix allowance, not as a substring of the
 * whole medium. "paid_social" splits to ["paid","social"] and counts; "leads"
 * stays one token and does not, where a substring test would have seen "ads"
 * inside it and started budgeting against an email list. */
const PAID_MEDIUM_TERMS = [
  'cpc', 'ppc', 'cpm', 'paid', 'ads', 'display', 'shopping', 'pmax', 'video', 'retarget',
];

/** Click ids. Stronger evidence than any utm, because the platform appends
 *  them itself and they survive a tagging template somebody forgot to fill. */
const GOOGLE_CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid'];
const META_CLICK_IDS = ['fbclid'];

const lower = (v) => String(v ?? '').trim().toLowerCase();

export function hasPaidMedium(medium) {
  const tokens = lower(medium).split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => PAID_MEDIUM_TERMS.some((term) => t === term || t.startsWith(term)));
}

/** Query parameters off a landing page, lower-cased, never throwing. */
export function urlParams(url) {
  const out = new Map();
  if (!url) return out;
  try {
    const u = new URL(String(url), 'https://placeholder.invalid');
    for (const [k, v] of u.searchParams) out.set(k.toLowerCase(), v);
  } catch {
    /* a landing page that is not a URL carries no parameters */
  }
  return out;
}

function host(u) {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** The platform a plain referral came from, or null. No payment implied. */
function referralPlatform(visit) {
  const h = host(visit.referrerUrl);
  const src = lower(visit.source);

  const google = (s) => /(^|\.)google\.[a-z.]+$/.test(s) || /(^|\.)youtube\.com$/.test(s);
  const meta = (s) =>
    /(^|\.)(facebook|instagram|fb|messenger)\.com$/.test(s) || /(^|\.)fb\.me$/.test(s);

  if (h && google(h)) return 'google';
  if (h && meta(h)) return 'meta';
  if (GOOGLE_SOURCES.has(src)) return 'google';
  if (META_SOURCES.has(src)) return 'meta';
  return null;
}

/**
 * What a single touchpoint is: which platform, and whether it was paid for.
 *
 * Order matters. Click ids are checked first because they are appended by the
 * platform rather than typed by a person, so they are right even when the
 * tracking template is broken — and this store's Google template currently
 * ships an unreplaced `{campaignname}` merge tag, which is exactly that case.
 *
 * Meta gets a campaign-name shortcut that Google does not: Meta's own URL
 * builder writes utm_campaign on paid placements and nothing else does, while
 * `utm_source=google&utm_campaign=…` is something a newsletter tool will
 * happily emit.
 */
export function classifyTouch(visit) {
  if (!visit) return { platform: null, paid: false, reason: 'no journey data' };

  const params = urlParams(visit.landingPage);
  for (const k of META_CLICK_IDS) {
    if (params.has(k)) return { platform: 'meta', paid: true, reason: k };
  }
  for (const k of GOOGLE_CLICK_IDS) {
    if (params.has(k)) return { platform: 'google', paid: true, reason: k };
  }

  const src = lower(visit.utmSource);
  const paidMedium = hasPaidMedium(visit.utmMedium);
  const named = Boolean(String(visit.utmCampaign ?? '').trim());

  if (META_SOURCES.has(src)) {
    if (paidMedium) return { platform: 'meta', paid: true, reason: 'paid utm_medium' };
    if (named) return { platform: 'meta', paid: true, reason: 'utm_campaign' };
    return { platform: 'meta', paid: false, reason: 'untagged Meta link' };
  }
  if (GOOGLE_SOURCES.has(src)) {
    if (paidMedium) return { platform: 'google', paid: true, reason: 'paid utm_medium' };
    return { platform: 'google', paid: false, reason: 'untagged Google link' };
  }

  /* Tagged as something else entirely — email, an affiliate, a feed. Reported,
   * never budgeted: this file only ever recommends Meta and Google. */
  if (src) return { platform: null, paid: false, reason: `utm_source=${src}` };

  const p = referralPlatform(visit);
  if (p) return { platform: p, paid: false, reason: 'organic referral' };
  return { platform: null, paid: false, reason: 'direct or unattributed' };
}

/* ---------------------------------------------------------------------------
 *  Which campaign
 * ------------------------------------------------------------------------- */

/** campaignKey -> {id, name} from stored Meta insights, newest name wins. */
export function metaCampaignIndex(insights = []) {
  const byKey = new Map();
  for (const r of insights) {
    const key = r.campaignKey || campaignKey(r.campaignName);
    if (!key || !r.campaignId) continue;
    byKey.set(key, { id: String(r.campaignId), name: r.campaignName || '' });
  }
  return byKey;
}

/**
 * Name and id for the campaign behind a touchpoint.
 *
 * The id is worth chasing because a name is not stable: the same campaign
 * reaches the storefront URL-encoded, with stray spaces, and sometimes with an
 * unreplaced merge tag where the name should be. An id joins to spend; a name
 * only sometimes does.
 */
export function campaignOf(visit, cls, metaIndex = new Map()) {
  const params = urlParams(visit?.landingPage);
  const name = String(visit?.utmCampaign ?? '').trim();

  const fromUrl = params.get('gad_campaignid') || params.get('utm_id') || '';
  if (fromUrl) {
    return { id: String(fromUrl), name: name || null, source: 'url' };
  }

  if (cls.platform === 'meta' && name) {
    const hit = metaIndex.get(campaignKey(name));
    if (hit) return { id: hit.id, name: hit.name || name, source: 'meta join' };
  }

  if (name) return { id: null, name, source: 'utm_campaign' };
  return { id: null, name: null, source: 'untagged' };
}

/* ---------------------------------------------------------------------------
 *  Splitting an order across its touchpoints
 * ------------------------------------------------------------------------- */

/** Two visits are the same visit when nothing that identifies one differs. */
function sameVisit(a, b) {
  if (!a || !b) return false;
  const sig = (v) =>
    [v.occurredAt, v.landingPage, v.referrerUrl, v.utmSource, v.utmMedium, v.utmCampaign]
      .map((x) => String(x ?? ''))
      .join('|');
  return sig(a) === sig(b);
}

/**
 * How one order's money divides.
 *
 * 50/50 when the journey has two distinct ends, because neither the ad that
 * found the customer nor the click that closed them did the job alone, and
 * every other weighting is a guess dressed as a number. One portion when
 * there is only one visit, or when Shopify recorded the same visit twice —
 * which it does for a session that both opened and converted.
 */
export function splitOrder(order) {
  const first = order?.firstVisit || null;
  const last = order?.lastVisit || null;

  if (!first && !last) return [];
  if (!first) return [{ which: 'only', visit: last, share: 1 }];
  if (!last) return [{ which: 'only', visit: first, share: 1 }];
  if (sameVisit(first, last)) return [{ which: 'only', visit: first, share: 1 }];
  return [
    { which: 'first', visit: first, share: 0.5 },
    { which: 'last', visit: last, share: 0.5 },
  ];
}

/**
 * The split, as money rather than fractions.
 *
 * The last portion takes whatever is left rather than its own rounded half,
 * so an odd-cent order divides into two amounts that add back to it exactly.
 * Without that, a few hundred orders drift the totals apart by a few cents and
 * the "paid plus unpaid equals the total" check — the one assertion that says
 * no money went missing — starts failing for no reason worth chasing.
 */
export function splitAmounts(order) {
  const net = round2(Number(order?.netPayment) || 0);
  const portions = splitOrder(order);
  let left = net;
  return portions.map((p, i) => {
    const amount = i === portions.length - 1 ? round2(left) : round2(net * p.share);
    left = round2(left - amount);
    return { ...p, amount };
  });
}

/** Orders this report is allowed to count. */
export function budgetableOrders(orders = [], { start, end } = {}) {
  return orders.filter((o) => {
    if (!o || o.test) return false;
    if (o.cancelled || o.cancelledAt) return false;
    if (!(Number(o.netPayment) > 0)) return false;
    if (start && end) {
      /* Store-local, never UTC. An order placed at 8pm in New York is already
       * tomorrow in UTC, and a seven-day window judged in UTC would shift its
       * edges by a day against every other figure on the dashboard. */
      const day = o.day || (o.createdAt ? localDateOf(o.createdAt) : null);
      if (day && (day < start || day > end)) return false;
    }
    return true;
  });
}

/* ---------------------------------------------------------------------------
 *  The recommendation
 * ------------------------------------------------------------------------- */

/**
 * What to spend next week.
 *
 * The arithmetic is deliberately plain — sales divided by the ROAS you want is
 * the spend that would produce them — and everything interesting is in the
 * guard rails around it:
 *
 *   · the move is capped at ±maxChange of what is being spent now, because a
 *     week is a small sample and a budget that doubles on one good week will
 *     halve on the next quiet one;
 *   · spend with nothing to show for it steps DOWN rather than to zero, since
 *     switching a campaign off is a decision for a person, not an arithmetic
 *     consequence of a slow week;
 *   · with no idea what is being spent there is nothing to cap against, so the
 *     target stands on its own and the UI says where it came from;
 *   · under three orders the number is still produced and labelled low
 *     confidence, because hiding it would just mean nobody looks at the row.
 */
export function recommend({ sales = 0, spend = null, orders = 0, targetRoas = 4, maxChange = 0.3 } = {}) {
  const roasTarget = targetRoas > 0 ? targetRoas : 4;
  const target = (Number(sales) || 0) / roasTarget;
  const confidence = (Number(orders) || 0) < 3 ? 'low' : 'ok';
  const known = spend != null && Number.isFinite(Number(spend));
  const cur = known ? Number(spend) : null;

  if (!known) {
    return { weekly: round2(target), basis: 'target', confidence, target: round2(target) };
  }

  /* There is nothing to cap against. ±30% of zero is zero, which would
   * recommend never spending again on a campaign that is merely paused — and
   * on one that is paused and still selling, which is the case worth seeing. */
  if (cur === 0) {
    return { weekly: round2(target), basis: 'target', confidence, target: round2(target) };
  }

  if (cur > 0 && !(Number(sales) > 0)) {
    return {
      weekly: round2(cur * (1 - maxChange)),
      basis: 'step-down',
      confidence,
      target: round2(target),
    };
  }

  const ceiling = cur * (1 + maxChange);
  const floor = cur * (1 - maxChange);
  if (target > ceiling) return { weekly: round2(ceiling), basis: 'capped-up', confidence, target: round2(target) };
  if (target < floor) return { weekly: round2(floor), basis: 'capped-down', confidence, target: round2(target) };
  return { weekly: round2(target), basis: 'target', confidence, target: round2(target) };
}

/** A weekly figure spread over 7, 14 and 30 days. */
export function forecast(weekly) {
  const perDay = (Number(weekly) || 0) / BUDGET_WINDOW_DAYS;
  return { 7: round2(perDay * 7), 14: round2(perDay * 14), 30: round2(perDay * 30) };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const safeRoas = (sales, spend) => (spend > 0 ? round2(sales / spend) : null);

/* ---------------------------------------------------------------------------
 *  The report
 * ------------------------------------------------------------------------- */

function emptyCampaign(platform, id, name) {
  return {
    key: `${platform}:${id || campaignKey(name) || NO_CAMPAIGN}`,
    platform,
    campaignId: id || null,
    campaign: name || NO_CAMPAIGN,
    orders: 0,
    firstTouches: 0,
    lastTouches: 0,
    onlyTouches: 0,
    firstTouchSales: 0,
    lastTouchSales: 0,
    onlyTouchSales: 0,
    attributedSales: 0,
    spend: 0,
    spendKnown: false,
    roas: null,
    shareOfSales: 0,
    recommendedWeekly: 0,
    recommendBasis: 'target',
    confidence: 'ok',
    orderList: [],
  };
}

/**
 * The whole report.
 *
 * @param {object[]} orders     stored non-POS orders, already filtered of POS
 * @param {object[]} metaInsights  stored Meta campaign-days, up to 60 days back
 * @param {{start,end}} window  the seven complete days being reported
 * @param {boolean} metaConnected  whether Meta credentials are configured
 * @param {object} settings     budgetSettings()
 */
export function buildBudgetReport({
  orders = [],
  metaInsights = [],
  window: win,
  metaConnected = false,
  settings = budgetSettings(),
} = {}) {
  const { start, end } = win;
  const rows = budgetableOrders(orders, { start, end });

  const metaIndex = metaCampaignIndex(metaInsights);
  const inWindow = metaInsights.filter((r) => r.date >= start && r.date <= end);

  /* Spend is "known" when there is data to know it from. Credentials alone are
   * enough (a configured account that spent nothing genuinely spent zero), and
   * so are stored rows on their own — a token that has since been removed does
   * not unspend last week's money. */
  const metaSpendKnown = metaConnected || inWindow.length > 0;

  const spendById = new Map();
  for (const r of inWindow) {
    if (!r.campaignId) continue;
    const id = String(r.campaignId);
    spendById.set(id, round2((spendById.get(id) || 0) + (Number(r.spend) || 0)));
  }
  const metaSpend = metaSpendKnown
    ? round2([...spendById.values()].reduce((s, v) => s + v, 0))
    : null;
  const metaReportedValue = round2(
    inWindow.reduce((s, r) => s + (Number(r.purchaseValue) || 0), 0)
  );

  const totals = {
    recordedSales: 0,
    paidMediaSales: 0,
    organicGoogle: 0,
    organicMeta: 0,
    directOther: 0,
    orders: rows.length,
    metaReportedPurchaseValue: metaReportedValue,
  };
  const platformSales = { meta: 0, google: 0 };
  const platformOrders = { meta: new Set(), google: new Set() };
  const campaigns = new Map();

  for (const o of rows) {
    const net = Number(o.netPayment) || 0;
    totals.recordedSales = round2(totals.recordedSales + net);

    const portions = splitAmounts(o);
    if (!portions.length) {
      totals.directOther = round2(totals.directOther + net);
      continue;
    }

    for (const p of portions) {
      const amount = p.amount;
      const cls = classifyTouch(p.visit);

      if (!cls.paid) {
        if (cls.platform === 'google') totals.organicGoogle = round2(totals.organicGoogle + amount);
        else if (cls.platform === 'meta') totals.organicMeta = round2(totals.organicMeta + amount);
        else totals.directOther = round2(totals.directOther + amount);
        continue;
      }

      totals.paidMediaSales = round2(totals.paidMediaSales + amount);
      platformSales[cls.platform] = round2(platformSales[cls.platform] + amount);
      platformOrders[cls.platform].add(o.orderNumber || o.id);

      const c = campaignOf(p.visit, cls, metaIndex);
      const row = ensureCampaign(campaigns, cls.platform, c.id, c.name);

      row.attributedSales = round2(row.attributedSales + amount);
      if (p.which === 'first') {
        row.firstTouches += 1;
        row.firstTouchSales = round2(row.firstTouchSales + amount);
      } else if (p.which === 'last') {
        row.lastTouches += 1;
        row.lastTouchSales = round2(row.lastTouchSales + amount);
      } else {
        row.onlyTouches += 1;
        row.onlyTouchSales = round2(row.onlyTouchSales + amount);
      }
      row.orderList.push({
        orderNumber: o.orderNumber || null,
        adminUrl: o.adminUrl || null,
        day: o.day || (o.createdAt ? String(o.createdAt).slice(0, 10) : null),
        createdAt: o.createdAt || null,
        orderTotal: round2(net),
        share: p.share,
        credited: amount,
        touch: p.which,
        reason: cls.reason,
      });
    }
  }

  /* A campaign that took money and returned nothing is the single most useful
   * row on the page, and it only exists on the spend side — no order points at
   * it, so nothing above would have created it. */
  if (metaSpendKnown) {
    for (const [id, spend] of spendById) {
      const name = [...metaIndex.values()].find((v) => v.id === id)?.name || id;
      const row = ensureCampaign(campaigns, 'meta', id, name);
      row.spend = spend;
      row.spendKnown = true;
    }
  }

  for (const row of campaigns.values()) {
    row.orders = new Set(row.orderList.map((r) => r.orderNumber)).size;
    row.roas = safeRoas(row.attributedSales, row.spend);
    row.shareOfSales = totals.paidMediaSales > 0
      ? round2(row.attributedSales / totals.paidMediaSales)
      : 0;
    row.orderList.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const rec = recommend({
      sales: row.attributedSales,
      spend: row.spendKnown ? row.spend : null,
      orders: row.orders,
      targetRoas: settings.targetRoas[row.platform],
      maxChange: settings.maxWeeklyChange,
    });
    row.recommendedWeekly = rec.weekly;
    row.recommendBasis = rec.basis;
    row.confidence = rec.confidence;
  }

  const platforms = {
    meta: platformBlock('meta', {
      sales: platformSales.meta,
      orders: platformOrders.meta.size,
      spend: metaSpend,
      spendKnown: metaSpendKnown,
      spendSource: metaSpendKnown ? 'Meta Ads sync' : null,
      settings,
    }),
    google: platformBlock('google', {
      sales: platformSales.google,
      orders: platformOrders.google.size,
      spend: settings.googleWeeklySpend,
      spendKnown: settings.googleWeeklySpend != null,
      spendSource: settings.googleWeeklySpend != null ? 'GOOGLE_ADS_WEEKLY_SPEND' : null,
      settings,
    }),
  };

  /* The estimate tile answers "what will the next 7, 14 and 30 days cost?".
   * Where a platform's spend is known that is the honest basis; where it is
   * not, the recommendation is the only figure there is, and the tile says so
   * rather than quietly reporting a smaller number. */
  const known = ['meta', 'google'].filter((k) => platforms[k].spendKnown);
  const pacedWeekly = round2(
    ['meta', 'google'].reduce(
      (s, k) => s + (platforms[k].spendKnown ? platforms[k].currentWeeklySpend : platforms[k].recommendedWeekly),
      0
    )
  );
  const recommendedWeekly = round2(platforms.meta.recommendedWeekly + platforms.google.recommendedWeekly);

  return {
    window: { start, end, days: BUDGET_WINDOW_DAYS },
    settings: {
      targetRoasMeta: settings.targetRoas.meta,
      targetRoasGoogle: settings.targetRoas.google,
      maxWeeklyChange: settings.maxWeeklyChange,
    },
    totals,
    platforms,
    campaigns: [...campaigns.values()].sort(
      (a, b) => b.attributedSales - a.attributedSales || b.spend - a.spend
    ),
    estimate: {
      /* Says which figure each half of the estimate came from, because "the
       * next 30 days will cost $X" means something different when half of X
       * is a measured spend and half is a suggestion. */
      basis: known.length === 2 ? 'current' : known.length === 0 ? 'recommended' : 'mixed',
      knownPlatforms: known,
      weekly: pacedWeekly,
      forecast: forecast(pacedWeekly),
      atRecommended: forecast(recommendedWeekly),
      recommendedWeekly,
    },
  };
}

function ensureCampaign(map, platform, id, name) {
  const row = emptyCampaign(platform, id, name);
  if (!map.has(row.key)) map.set(row.key, row);
  const existing = map.get(row.key);
  // A later touch may carry the id or the proper name the first one lacked.
  if (!existing.campaignId && id) existing.campaignId = String(id);
  if (name && (existing.campaign === NO_CAMPAIGN || !existing.campaign)) existing.campaign = name;
  return existing;
}

function platformBlock(platform, { sales, orders, spend, spendKnown, spendSource, settings }) {
  const rec = recommend({
    sales,
    spend: spendKnown ? spend : null,
    orders,
    targetRoas: settings.targetRoas[platform],
    maxChange: settings.maxWeeklyChange,
  });
  const current = spendKnown ? round2(spend) : null;
  return {
    platform,
    attributedSales: round2(sales),
    orders,
    currentWeeklySpend: current,
    spendKnown,
    spendSource,
    roas: spendKnown ? safeRoas(sales, current) : null,
    targetRoas: settings.targetRoas[platform],
    recommendedWeekly: rec.weekly,
    recommendBasis: rec.basis,
    confidence: rec.confidence,
    changeVsNow: spendKnown && current > 0 ? round2(rec.weekly / current - 1) : null,
    forecast: forecast(rec.weekly),
  };
}
