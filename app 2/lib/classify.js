/* =============================================================================
 *  BUCKET CLASSIFICATION
 *  -----------------------------------------------------------------------
 *  This is the ONLY file you need to edit to change how orders are bucketed.
 *  Everything else in the app reads from here.
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. POS detection
 * ---------------------------------------------------------------------------*/
// An order counts as POS if Shopify says it came through the Point of Sale
// channel, or it was rung up at a physical retail location.
export function isPOS(o) {
  const src = (o.sourceName || '').toLowerCase();
  const channel = (o.channelHandle || '').toLowerCase();
  const app = (o.appName || '').toLowerCase();
  return (
    src === 'pos' ||
    channel === 'pos' ||
    app === 'point of sale' ||
    Boolean(o.retailLocationName)
  );
}

/* -----------------------------------------------------------------------------
 * 2. Draft detection
 * ---------------------------------------------------------------------------*/
// An order counts as draft-originated if it was created from a Shopify draft
// order (invoice sent from admin, manual order, etc.).
export function isDraft(o) {
  const src = (o.sourceName || '').toLowerCase();
  const app = (o.appName || '').toLowerCase();
  return src === 'shopify_draft_order' || app === 'draft orders';
}

/* =============================================================================
 * 3. ASSISTED detection  <<< EDIT THIS SECTION >>>
 * -----------------------------------------------------------------------------
 * An "assisted" order is one where a human helped the sale along, rather than
 * the customer self-serving through the site.
 *
 * The rule below is a PLACEHOLDER inferred from your live order data: many of
 * your orders carry a note like "Credit to Erik", "Credit: JR", "Credit: Ruby".
 * Replace / extend the signals to match your actual reasoning.
 *
 * mode: 'any'  -> assisted if ANY enabled signal matches   (OR)
 *       'all'  -> assisted only if EVERY enabled signal matches (AND)
 * ========================================================================== */
export const ASSISTED_RULE = {
  mode: 'any',

  signals: {
    // --- Signal A: a staff-credit note on the order -------------------------
    // Matches "Credit to Erik", "Credit: JR", "credit ruby", etc.
    noteCredit: {
      enabled: true,
      pattern: /\bcredit(?:ed)?\s*(?:to|by|:)?\s*[-–]?\s*([A-Za-z][A-Za-z .'-]{1,40})/i,
    },

    // --- Signal B: order carries one of these tags -------------------------
    tags: {
      enabled: false,
      values: ['assisted', 'clienteling', 'personal-shopper', 'styled'],
    },

    // --- Signal C: originated from a draft order ---------------------------
    // Turn this on if you consider every draft order inherently assisted.
    draftOrigin: {
      enabled: false,
    },

    // --- Signal D: last click came from a 1:1 channel ----------------------
    // e.g. the customer was emailed/DM'd a link by a staff member.
    lastClickChannel: {
      enabled: false,
      sources: ['email', 'sms'],
    },

    // --- Signal E: the checkout was a draft-order invoice link -------------
    // Landing page contains /checkouts/do/ -> a draft-order invoice checkout.
    draftInvoiceLanding: {
      enabled: false,
    },
  },
};

export function isAssisted(o) {
  const s = ASSISTED_RULE.signals;
  const results = [];

  if (s.noteCredit.enabled) {
    results.push(Boolean(o.note && s.noteCredit.pattern.test(o.note)));
  }
  if (s.tags.enabled) {
    const want = s.tags.values.map((t) => t.toLowerCase());
    const have = (o.tags || []).map((t) => String(t).toLowerCase());
    results.push(have.some((t) => want.includes(t)));
  }
  if (s.draftOrigin.enabled) {
    results.push(isDraft(o));
  }
  if (s.lastClickChannel.enabled) {
    const src = (o.lastVisit?.source || '').toLowerCase();
    results.push(s.lastClickChannel.sources.includes(src));
  }
  if (s.draftInvoiceLanding.enabled) {
    const lp = `${o.firstVisit?.landingPage || ''} ${o.lastVisit?.landingPage || ''}`;
    results.push(/\/checkouts\/do\//i.test(lp));
  }

  if (results.length === 0) return false;
  return ASSISTED_RULE.mode === 'all'
    ? results.every(Boolean)
    : results.some(Boolean);
}

/** Which staff member got credit, if the note says so. Used for the drill-down. */
export function creditedTo(o) {
  if (!o.note) return null;
  const m = o.note.match(ASSISTED_RULE.signals.noteCredit.pattern);
  if (!m) return null;
  return m[1].split(/[\n\r]/)[0].trim().replace(/[.,;]+$/, '') || null;
}

/* =============================================================================
 * 4. Bucketing
 * -----------------------------------------------------------------------------
 * exclusive = true  -> an assisted order is REMOVED from online/draft and lives
 *                      only in the middle panel. The three panels then sum to
 *                      the non-POS total. (default)
 * exclusive = false -> assisted is an overlay: the middle panel re-counts orders
 *                      that also appear in online or draft.
 * ========================================================================== */
export function bucketOf(o, { exclusive = true } = {}) {
  if (isPOS(o)) return 'pos'; // excluded from all three panels
  const assisted = isAssisted(o);
  if (exclusive && assisted) return 'assisted';
  if (isDraft(o)) return 'draft';
  return 'online';
}

export function annotate(o, { exclusive = true } = {}) {
  const pos = isPOS(o);
  const draft = isDraft(o);
  const assisted = isAssisted(o);
  return {
    ...o,
    isPOS: pos,
    isDraft: draft,
    isAssisted: assisted,
    creditedTo: creditedTo(o),
    bucket: bucketOf(o, { exclusive }),
  };
}
