/* =============================================================================
 *  SHARED FINDINGS — a frozen snapshot behind an unguessable link
 *  ---------------------------------------------------------------------------
 *  Someone filters the dashboard, sees something worth telling a stakeholder
 *  about, and sends it. The stakeholder must see THAT, not whatever the numbers
 *  have become since — so a report is a frozen copy of the figures, with a link
 *  back to the live view beside them for anyone who wants today's.
 *
 *  Three decisions worth knowing about:
 *
 *  1. The figures are rebuilt HERE, from storage, for the range the browser
 *     asked about. The browser's own numbers are never stored. A report is
 *     evidence; evidence that a page could have edited on its way out is not
 *     evidence at all.
 *
 *  2. The id is 128 bits of randomness and the only credential. There is no
 *     password, at the store's choice, which means a forwarded link is
 *     forwarded access. That is why the id is long enough that it cannot be
 *     guessed or walked, why reports can be revoked, and why the viewer route
 *     serves exactly one report and never the dashboard.
 *
 *  3. Customer names are left out unless whoever creates the report asks for
 *     them. The default is the safe one because a link with no password can end
 *     up anywhere, and a name is the one field in a row that identifies a
 *     person rather than a sale.
 * ========================================================================== */

import { randomBytes } from 'node:crypto';
import { getJSON, setJSON } from './blobs.js';
import { getWatermark } from './repo.js';
import { loadRange, rangeProblem } from './snapshot.js';
import { comparisonRange, fullyCovered, COMPARISONS } from '../public/ranges.js';
import { coverageWindow } from './sync.js';
import { STORE_TZ } from './timezone.js';

export const REPORTS = 'reports';

/** The index key. Reports themselves live at `r/<id>`. */
const INDEX = 'index';
const keyOf = (id) => `r/${id}`;

/* 16 bytes = 128 bits, rendered as 32 hex characters. At any plausible rate of
 * guessing, this is not findable; the practical risk to a report is someone
 * forwarding the link, which no amount of entropy addresses. */
export const newReportId = () => randomBytes(16).toString('hex');

/** Exactly 32 lowercase hex characters — nothing else may reach a blob key. */
export const validId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

/** How many order rows a report may carry. Past this it stops being a finding
 *  and starts being an export, and the whole point of the page is the finding. */
export const ROW_LIMIT = 120;

/** Reports kept in the index. Older ones still resolve by link; they just stop
 *  being listed, so the management list cannot grow without bound. */
const INDEX_LIMIT = 60;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---------------------------------------------------------------------------
 *  Rows
 * ------------------------------------------------------------------------- */

/**
 * The columns a stakeholder needs to see a finding, and nothing more.
 *
 * Trimmed rather than passed through: a payload row carries the admin URL, the
 * customer's lifetime spend, their order index and both visit records, none of
 * which belong behind a link that has no password. What is left is the sale and
 * how it was attributed — which is the thing being disputed.
 */
export function reportRows(orders = [], { names = false, limit = ROW_LIMIT } = {}) {
  return orders.slice(0, limit).map((o) => ({
    orderNumber: o.orderNumber,
    day: o.day,
    createdAt: o.createdAt,
    netSale: o.netSale,
    refunded: o.refunded,
    currency: o.currency,
    convertedVia: o.convertedVia,
    /* Shopify Analytics' own channel where the map has it, the Admin API's
     * otherwise — the same rule the dashboard's Channel column follows. The
     * two are kept apart rather than merged: where they disagree, the report
     * says so instead of quietly picking a winner. */
    channel: o.salesChannel || o.channelName || null,
    channelAdmin:
      o.salesChannel && o.channelName &&
      o.salesChannel.toLowerCase() !== o.channelName.toLowerCase()
        ? o.channelName
        : null,
    device: o.device,
    trafficSource: o.trafficSource || o.lastClick?.source || null,
    firstClick: o.firstClick?.source || null,
    campaign: o.campaign || null,
    adBacked: Boolean(o.adBacked),
    touchpoints: o.touchpoints ?? null,
    daysToConversion: o.daysToConversion ?? null,
    onlineTouchpoint: Boolean(o.onlineTouchpoint),
    fromEbay: Boolean(o.fromEbay),
    /* Only when asked for. Everything above describes a sale; this describes a
     * person, and the link protecting it has no password. */
    customerName: names ? o.customerName || null : null,
  }));
}

/* ---------------------------------------------------------------------------
 *  Building
 * ------------------------------------------------------------------------- */

/** Just the figures, out of a full payload. Charts and tables, no order rows. */
function figuresOf(p) {
  const pick = (b) => ({
    revenue: b.revenue,
    orderCount: b.orderCount,
    refunded: b.refunded,
    avgOrderValue: b.avgOrderValue ?? (b.orderCount ? b.revenue / b.orderCount : 0),
  });
  return {
    totals: p.totals,
    buckets: {
      online: pick(p.buckets.online),
      assisted: pick(p.buckets.assisted),
      draft: pick(p.buckets.draft),
      pos: pick(p.buckets.pos),
    },
    daily: p.daily,
    sources: p.sources,
    ordersInStore: p.ordersInStore ?? null,
  };
}

/**
 * Build the snapshot for one filtered view.
 *
 * Throws an Error carrying `.status` for anything the caller should answer with
 * a 4xx, so the endpoint stays a thin wrapper.
 */
export async function buildSnapshot({
  start,
  end,
  bucket = null,
  cmpMode = 'none',
  cmpCustom = null,
  title = '',
  note = '',
  rows = true,
  names = false,
  author = '',
} = {}) {
  const bad = rangeProblem(start, end);
  if (bad) {
    const err = new Error(bad.body.error);
    err.status = bad.status;
    throw err;
  }

  const focus = ['online', 'assisted', 'draft'].includes(bucket) ? bucket : null;

  const [payload, watermark] = await Promise.all([loadRange(start, end), getWatermark()]);

  /* The comparison is resolved server-side from the mode, not taken as two
   * dates from the browser. That keeps "previous year" meaning the same thing
   * on the report as it did on the dashboard, and stops a report claiming a
   * baseline the live view would never compute. */
  let comparison = null;
  const cmpR = comparisonRange(cmpMode, { start, end }, cmpCustom || undefined);
  if (cmpR && fullyCovered(cmpR, coverageWindow()) && !rangeProblem(cmpR.start, cmpR.end)) {
    const cmpPayload = await loadRange(cmpR.start, cmpR.end);
    comparison = {
      mode: cmpMode,
      label: COMPARISONS.find((c) => c.key === cmpMode)?.label || cmpMode,
      range: cmpR,
      ...figuresOf(cmpPayload),
    };
  }

  return {
    v: 1,
    createdAt: new Date().toISOString(),
    author: str(author, 120),
    title: str(title, 160) || 'Dashboard finding',
    note: str(note, 2000),
    range: { start, end },
    focus,
    /* Enough to rebuild the exact live view the report was taken from. The
     * "Open live view" link is assembled from this, so the stakeholder lands on
     * the same filters rather than the default week. */
    view: { start, end, bucket: focus, cmpMode, cmpCustom: cmpCustom || null },
    ...figuresOf(payload),
    comparison,
    rows: rows && focus ? reportRows(payload.buckets[focus].orders, { names }) : null,
    rowsTotal: focus ? payload.buckets[focus].orderCount : null,
    includesNames: Boolean(rows && focus && names),
    /* When the figures were last pulled from Shopify — not when the report was
     * made. A report created at midnight off a sync from 11:45pm is fifteen
     * minutes stale, and the page says so rather than implying it is live. */
    dataAsOf: watermark?.lastSyncISO || null,
    timezone: STORE_TZ,
  };
}

/* ---------------------------------------------------------------------------
 *  Storage
 * ------------------------------------------------------------------------- */

export async function saveReport(snapshot) {
  const id = newReportId();
  const record = { ...snapshot, id };
  await setJSON(REPORTS, keyOf(id), record);

  const index = await readIndex();
  index.unshift({
    id,
    title: record.title,
    range: record.range,
    focus: record.focus,
    createdAt: record.createdAt,
    author: record.author,
    includesNames: record.includesNames,
    revoked: false,
  });
  await writeIndex(index.slice(0, INDEX_LIMIT));

  return record;
}

/**
 * Read one report by id.
 *
 * Returns `{ error: 'not-found' }` for a bad id, a missing report AND a revoked
 * one, deliberately — distinguishing them would let someone with a guessed id
 * learn that it was once real.
 */
export async function readReport(id) {
  if (!validId(id)) return null;
  const rec = await getJSON(REPORTS, keyOf(id));
  if (!rec || rec.revoked) return null;
  return rec;
}

export async function listReports() {
  return (await readIndex()).filter((r) => !r.revoked);
}

/**
 * Revoke a link.
 *
 * The report body is overwritten with a tombstone rather than deleted. A
 * deleted blob and a revoked one behave identically to a viewer; keeping the
 * record means the index and the report can never disagree about whether a link
 * is live, which is what someone checking "did I turn that off?" is asking.
 */
export async function revokeReport(id) {
  if (!validId(id)) return false;
  const rec = await getJSON(REPORTS, keyOf(id));
  if (!rec) return false;
  await setJSON(REPORTS, keyOf(id), {
    id,
    revoked: true,
    revokedAt: new Date().toISOString(),
    title: rec.title,
  });
  const index = await readIndex();
  for (const row of index) if (row.id === id) row.revoked = true;
  await writeIndex(index);
  return true;
}

async function readIndex() {
  const v = await getJSON(REPORTS, INDEX, { strong: true });
  return Array.isArray(v) ? v : [];
}
const writeIndex = (v) => setJSON(REPORTS, INDEX, v);
