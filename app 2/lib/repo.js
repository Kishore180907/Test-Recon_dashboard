/* =============================================================================
 *  Order repository — the shape of what we keep in storage.
 *  -----------------------------------------------------------------------
 *  ORDERS store   m/<YYYY-MM>   -> { [orderId]: normalizedOrder }   (non-POS)
 *  ORDERS store   p/<YYYY-MM>   -> { [YYYY-MM-DD]: {revenue, orders} } (POS)
 *  ADS store      a/<YYYY-MM>   -> { [YYYY-MM-DD|campaignId]: insightRow }
 *  META store     watermark     -> { lastSyncAt, lastSyncISO, orders }
 *  META store     backfill      -> { status, cursor, pages, seen, startedAt, ... }
 *  META store     lock          -> { at, by }
 *
 *  META here means "metadata", not Meta the advertiser — the ad data lives in
 *  ADS. The names predate the integration and renaming the store would orphan
 *  everything already written under it.
 *
 *  POS orders are 90%+ of volume and the dashboard only ever shows them as a
 *  single reference figure, so they are collapsed to per-day totals instead of
 *  being stored whole. That keeps every month shard small enough to read and
 *  rewrite inside a function's time budget.
 * ========================================================================== */

import { getJSON, setJSON, del, listKeys } from './blobs.js';
import { localDateOf } from './timezone.js';
import { isPOS } from './classify.js';

export const ORDERS = 'orders';
export const META = 'meta';
export const ADS = 'ads';

const monthOf = (localDate) => localDate.slice(0, 7);

/* ---- month shard helpers -------------------------------------------------- */

export function monthsBetween(startDate, endDate) {
  const out = [];
  let [y, m] = startDate.slice(0, 7).split('-').map(Number);
  const [ey, em] = endDate.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Merge a batch of freshly-fetched orders into the month shards.
 * Returns { months, nonPos, pos } describing what was touched.
 */
export async function upsertOrders(orders) {
  const byMonth = new Map();   // month -> { [id]: order }
  const posByMonth = new Map(); // month -> { [day]: {revenue, orders} }
  let nonPos = 0;
  let pos = 0;

  for (const o of orders) {
    if (o.test) continue;
    const day = localDateOf(o.createdAt);
    const month = monthOf(day);

    if (isPOS(o)) {
      pos += 1;
      if (!posByMonth.has(month)) posByMonth.set(month, new Map());
      const days = posByMonth.get(month);
      if (!days.has(day)) days.set(day, {});
      days.get(day)[o.id] = o.netPayment;
      continue;
    }

    nonPos += 1;
    if (!byMonth.has(month)) byMonth.set(month, new Map());
    byMonth.get(month).set(o.id, o);
  }

  const touched = new Set();

  for (const [month, map] of byMonth) {
    const key = `m/${month}`;
    // Strong consistency is mandatory here. This is a read-modify-write, and the
    // backfill hammers the same month shard from consecutive pages seconds apart.
    // An eventually-consistent read can return a stale copy, and writing it back
    // silently drops every order the previous pages added.
    const existing = (await getJSON(ORDERS, key, { strong: true })) || {};
    for (const [id, o] of map) existing[id] = o;
    await setJSON(ORDERS, key, existing);
    touched.add(month);
  }

  /* POS day-totals are keyed by order id and re-derived on write, so re-syncing
   * the same order updates its amount instead of double-counting it. */
  for (const [month, days] of posByMonth) {
    const key = `p/${month}`;
    const existing = (await getJSON(ORDERS, key, { strong: true })) || {};
    for (const [day, amounts] of days) {
      const entries = { ...(existing[day]?.entries || {}), ...amounts };
      const values = Object.values(entries);
      existing[day] = {
        entries,
        orders: values.length,
        revenue: values.reduce((s, v) => s + v, 0),
      };
    }
    await setJSON(ORDERS, key, existing);
    touched.add(month);
  }

  return { months: [...touched], nonPos, pos };
}

/** Every non-POS order whose local created-date falls inside [start, end]. */
export async function readOrders(startDate, endDate) {
  const out = [];
  for (const month of monthsBetween(startDate, endDate)) {
    const shard = await getJSON(ORDERS, `m/${month}`);
    if (!shard) continue;
    for (const o of Object.values(shard)) {
      const d = localDateOf(o.createdAt);
      if (d >= startDate && d <= endDate) out.push(o);
    }
  }
  return out;
}

/** POS reference totals for the range. */
export async function readPosTotals(startDate, endDate) {
  let revenue = 0;
  let orders = 0;
  for (const month of monthsBetween(startDate, endDate)) {
    const shard = await getJSON(ORDERS, `p/${month}`);
    if (!shard) continue;
    for (const [day, rec] of Object.entries(shard)) {
      if (day < startDate || day > endDate) continue;
      revenue += rec.revenue || 0;
      orders += rec.orders || 0;
    }
  }
  return { revenue, orders };
}

/* ---- Meta Ads insights ---------------------------------------------------- */

/**
 * Merge campaign-by-day insight rows into the ad month shards.
 *
 * Keyed by date + campaign id, so re-syncing a day overwrites its rows rather
 * than adding to them. That matters more here than for orders: Meta revises
 * recent days for up to 72 hours as attribution settles, and every sync is
 * expected to bring back changed numbers for days already stored.
 */
export async function upsertMetaInsights(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    if (!r?.date) continue;
    const month = monthOf(r.date);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }

  const touched = [];
  for (const [month, list] of byMonth) {
    const key = `a/${month}`;
    const existing = (await getJSON(ADS, key, { strong: true })) || {};
    for (const r of list) existing[`${r.date}|${r.campaignId || r.campaignKey}`] = r;
    await setJSON(ADS, key, existing);
    touched.push(month);
  }
  return { months: touched, rows: rows.length };
}

/** Every insight row whose day falls inside [start, end]. */
export async function readMetaInsights(startDate, endDate) {
  const out = [];
  for (const month of monthsBetween(startDate, endDate)) {
    const shard = await getJSON(ADS, `a/${month}`);
    if (!shard) continue;
    for (const r of Object.values(shard)) {
      if (r.date >= startDate && r.date <= endDate) out.push(r);
    }
  }
  return out;
}

/** Drop shards that have fallen entirely outside the coverage window. */
export async function pruneBefore(oldestDate) {
  const cutoff = oldestDate.slice(0, 7);
  const dropped = [];

  for (const [store, pattern] of [[ORDERS, /^[mp]\/(\d{4}-\d{2})$/], [ADS, /^a\/(\d{4}-\d{2})$/]]) {
    for (const k of await listKeys(store)) {
      const m = k.match(pattern);
      if (m && m[1] < cutoff) {
        await del(store, k);
        dropped.push(`${store}:${k}`);
      }
    }
  }
  return dropped;
}

/* ---- metadata ------------------------------------------------------------- */

/* Order name -> Shopify's sales channel, cached at sync time.
 *
 * Kept in storage rather than fetched on read because /api/data must never call
 * Shopify — that is what guarantees it cannot time out. The map is what puts
 * mobile-app drafts in the Ecommerce bucket, so the tiles need it on every read.
 * Stored as one object; a 90-day window is a few thousand short strings. */
export const getOrderChannels = () => getJSON(META, 'orderChannels', { strong: true });
export const setOrderChannels = (v) => setJSON(META, 'orderChannels', v);

export const getWatermark = () => getJSON(META, 'watermark', { strong: true });
export const setWatermark = (v) => setJSON(META, 'watermark', v);
export const getBackfill = () => getJSON(META, 'backfill', { strong: true });
export const setBackfill = (v) => setJSON(META, 'backfill', v);

/** Cheap mutual exclusion so a cron run and a manual refresh don't overlap. */
export async function acquireLock(by, ttlMs = 120000) {
  const cur = await getJSON(META, 'lock', { strong: true });
  if (cur && Date.now() - cur.at < ttlMs) return false;
  await setJSON(META, 'lock', { at: Date.now(), by });
  return true;
}
export const releaseLock = () => del(META, 'lock');
