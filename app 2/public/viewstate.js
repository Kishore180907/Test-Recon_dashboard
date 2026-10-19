/* =============================================================================
 *  VIEW STATE IN THE URL
 *  ---------------------------------------------------------------------------
 *  Which range, which comparison, which bucket — written into the address bar
 *  so a filtered view can be linked to, and read back so a link opens on it.
 *
 *  It lives in the HASH, not the query string, for one reason: the search box
 *  can hold a customer's name, and a hash is never sent to the server and never
 *  lands in an access log. Nothing identifying goes in here either way — the
 *  search text is deliberately not part of the state — but the hash means a
 *  future field cannot become a logged one by accident.
 *
 *  Shared with the report viewer, which assembles the "Open live view" link
 *  from the same function. A report that reopens on the wrong filters is worse
 *  than one with no link at all, so there is exactly one encoder.
 * ========================================================================== */

const BUCKETS = new Set(['online', 'assisted', 'draft']);
const MODES = new Set(['none', 'prev_period', 'prev_year', 'prev_year_dow', 'custom']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const day = (v) => (DATE_RE.test(String(v || '')) ? String(v) : null);

/**
 * View state -> the part after the `#`.
 *
 * Defaults are omitted rather than written out, so the common link is short
 * enough to read: a plain range is `start=…&end=…` and nothing else.
 */
export function encodeView(view = {}) {
  const p = new URLSearchParams();
  if (day(view.start)) p.set('start', view.start);
  if (day(view.end)) p.set('end', view.end);
  if (BUCKETS.has(view.bucket)) p.set('bucket', view.bucket);
  if (view.cmpMode && view.cmpMode !== 'none' && MODES.has(view.cmpMode)) {
    p.set('cmp', view.cmpMode);
    if (view.cmpMode === 'custom' && day(view.cmpCustom?.start) && day(view.cmpCustom?.end)) {
      p.set('cs', view.cmpCustom.start);
      p.set('ce', view.cmpCustom.end);
    }
  }
  return p.toString();
}

/**
 * The part after the `#` -> view state.
 *
 * Every field is validated, and anything unrecognised comes back null rather
 * than throwing or being passed on. A link is something a stranger can type:
 * the page has to survive `#start=yesterday&bucket=../../etc` without either
 * breaking or sending it to the API.
 */
export function decodeView(hash = '') {
  const p = new URLSearchParams(String(hash).replace(/^[#?]/, ''));
  const start = day(p.get('start'));
  const end = day(p.get('end'));
  const bucket = BUCKETS.has(p.get('bucket')) ? p.get('bucket') : null;
  const mode = MODES.has(p.get('cmp')) ? p.get('cmp') : null;
  const cs = day(p.get('cs'));
  const ce = day(p.get('ce'));

  return {
    // A range is only honoured as a pair. One half of one would silently pin a
    // date the sender never chose onto the other end's default.
    start: start && end && start <= end ? start : null,
    end: start && end && start <= end ? end : null,
    bucket,
    cmpMode: mode,
    cmpCustom: mode === 'custom' && cs && ce && cs <= ce ? { start: cs, end: ce } : null,
  };
}
