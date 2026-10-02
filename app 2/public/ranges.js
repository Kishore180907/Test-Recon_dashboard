/* =============================================================================
 *  DATE RANGES — period-to-date presets and comparison windows
 *  ---------------------------------------------------------------------------
 *  Pure string arithmetic on YYYY-MM-DD. Every date the dashboard handles is
 *  already a STORE-LOCAL calendar day by the time it gets here (todayLocal()
 *  and localDateOf() in lib/timezone.js do that conversion), so nothing in this
 *  file may construct a Date from a local timezone or call getFullYear() on
 *  one. Dates are parsed at UTC midnight purely as a calendar, never as a
 *  moment in time — otherwise a dashboard opened in Los Angeles would compute
 *  a different "month to date" than the same store opened in New York.
 *
 *  Lives in public/ rather than lib/ because the browser needs it, and it is a
 *  module rather than inline script so the test suite can import the same
 *  arithmetic the page runs instead of a copy of it.
 * ========================================================================== */

/** Shopify's weeks start on Monday — confirmed against this store's own
 *  ShopifyQL output, where every `TIMESERIES week` bucket lands on a Monday.
 *  One constant, so a store on a Sunday week only has to change this. */
export const WEEK_STARTS_ON = 1; // 0 = Sunday, 1 = Monday

const DAY = 86400000;

const parse = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmt = (t) => new Date(t).toISOString().slice(0, 10);

/** n days from a calendar date. Negative goes back. */
export const shiftDays = (date, n) => fmt(parse(date) + n * DAY);

/** Inclusive day count: a single day is 1, not 0. */
export const daysBetween = (start, end) =>
  Math.round((parse(end) - parse(start)) / DAY) + 1;

/* ---- period to date -------------------------------------------------------
 * Each one runs from the first day of the containing period up to and
 * including today. "To date" means exactly that: the period is not yet over,
 * which is why none of these ever end on a future date.
 * -------------------------------------------------------------------------- */

export const PERIODS = [
  { key: 'wtd', label: 'Week to date' },
  { key: 'mtd', label: 'Month to date' },
  { key: 'qtd', label: 'Quarter to date' },
  { key: 'ytd', label: 'Year to date' },
];

export function periodToDate(kind, today) {
  const t = parse(today);
  const d = new Date(t);

  switch (kind) {
    case 'wtd': {
      /* How many days we are past the start of the week. The +7 and the
       * modulo keep this correct for either week-start convention without a
       * branch — on a Sunday with Monday weeks it gives 6, not -1. */
      const back = (d.getUTCDay() - WEEK_STARTS_ON + 7) % 7;
      return { start: fmt(t - back * DAY), end: today };
    }
    case 'mtd':
      return { start: `${today.slice(0, 7)}-01`, end: today };
    case 'qtd': {
      const firstMonth = Math.floor(d.getUTCMonth() / 3) * 3;   // 0, 3, 6, 9
      return {
        start: fmt(Date.UTC(d.getUTCFullYear(), firstMonth, 1)),
        end: today,
      };
    }
    case 'ytd':
      return { start: `${today.slice(0, 4)}-01-01`, end: today };
    default:
      return null;
  }
}

/* ---- comparison windows ---------------------------------------------------
 * The four modes Shopify offers, plus Custom, which the caller supplies.
 * -------------------------------------------------------------------------- */

export const COMPARISONS = [
  { key: 'none', label: 'No comparison' },
  { key: 'prev_period', label: 'Previous period' },
  { key: 'prev_year', label: 'Previous year' },
  { key: 'prev_year_dow', label: 'Previous year (match day of week)' },
  { key: 'custom', label: 'Custom' },
];

/** Same calendar day one year earlier, with 29 February folded back to the
 *  28th rather than silently rolling into March. */
function yearEarlier(date) {
  const d = new Date(parse(date));
  const y = d.getUTCFullYear() - 1;
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmt(Date.UTC(y, m, Math.min(day, lastOfMonth)));
}

/**
 * The window to compare a range against.
 *
 * @param {string} mode   one of COMPARISONS
 * @param {{start,end}} range  the range on screen
 * @param {{start,end}} custom used only when mode is 'custom'
 * @returns {{start,end}|null} null when there is nothing to compare
 */
export function comparisonRange(mode, range, custom) {
  if (!mode || mode === 'none' || !range?.start || !range?.end) return null;

  switch (mode) {
    case 'prev_period': {
      /* The same number of days, ending the day before this range starts.
       * Not "the previous calendar month" — a 9-day range compares against the
       * 9 days before it, which is what makes this meaningful for an
       * arbitrary window. */
      const len = daysBetween(range.start, range.end);
      const end = shiftDays(range.start, -1);
      return { start: shiftDays(end, -(len - 1)), end };
    }
    case 'prev_year':
      return { start: yearEarlier(range.start), end: yearEarlier(range.end) };
    case 'prev_year_dow':
      /* 364 days is exactly 52 weeks, so every day lands on the same weekday
       * it did last year. That matters for retail: comparing a Saturday with
       * the previous year's Tuesday says nothing useful about either. */
      return { start: shiftDays(range.start, -364), end: shiftDays(range.end, -364) };
    case 'custom':
      return custom?.start && custom?.end
        ? { start: custom.start, end: custom.end }
        : null;
    default:
      return null;
  }
}

/* ---- what the stored history can actually answer --------------------------
 * The dashboard keeps a rolling window (COVERAGE_DAYS in lib/sync.js) and
 * /api/data refuses anything outside it. Rather than let that surface as a
 * failed request, ranges are checked here first so the page can clamp and say
 * so, or decline the comparison and say why.
 * -------------------------------------------------------------------------- */

/** Pull a range inside the stored window. `clamped` says whether it moved. */
export function clampToCoverage(range, coverage) {
  if (!coverage?.start || !range) return { ...range, clamped: false };
  const start = range.start < coverage.start ? coverage.start : range.start;
  const end = coverage.end && range.end > coverage.end ? coverage.end : range.end;
  return { start, end, clamped: start !== range.start || end !== range.end };
}

/** True when the whole range is stored. A comparison that is only half
 *  covered is worse than none: the delta would read as a collapse in trade
 *  when it is really a gap in history. */
export function fullyCovered(range, coverage) {
  if (!range) return false;
  if (!coverage?.start) return true;
  return range.start >= coverage.start && (!coverage.end || range.end <= coverage.end);
}

/** Percentage change, or null when the baseline is zero — dividing by it
 *  would report an infinite rise for the first sale ever made. */
export function pctChange(now, before) {
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  if (b === 0) return null;
  return ((a - b) / b) * 100;
}
