/* =============================================================================
 *  Order repository — the shape of what we keep in storage.
 *  -----------------------------------------------------------------------
 *  ORDERS store   m/<YYYY-MM>   -> { [orderId]: normalizedOrder }   (non-POS)
 *  ORDERS store   p/<YYYY-MM>   -> { [YYYY-MM-DD]: {revenue, orders} } (POS)
 *  META store     watermark     -> { lastSyncAt, lastSyncISO, orders }
 *  META store     backfill      -> { status, cursor, pages, seen, startedAt, ... }
 *  META store     lock          -> { at, by }
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
    const existing = (await getJSON(ORDERS, key)) || {};
    for (const [id, o] of map) existing[id] = o;
    await setJSON(ORDERS, key, existing);
    touched.add(month);
  }

  /* POS day-totals are keyed by order id and re-derived on write, so re-syncing
   * the same order updates its amount instead of double-counting it. */
  for (const [month, days] of posByMonth) {
    const key = `p/${month}`;
    const existing = (await getJSON(ORDERS, key)) || {};
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

/** Drop shards that have fallen entirely outside the coverage window. */
export async function pruneBefore(oldestDate) {
  const cutoff = oldestDate.slice(0, 7);
  const keys = await listKeys(ORDERS);
  const dropped = [];
  for (const k of keys) {
    const m = k.match(/^[mp]\/(\d{4}-\d{2})$/);
    if (m && m[1] < cutoff) {
      await del(ORDERS, k);
      dropped.push(k);
    }
  }
  return dropped;
}

/* ---- metadata ------------------------------------------------------------- */

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
