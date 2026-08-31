/* =============================================================================
 *  BUCKET CLASSIFICATION
 *  -----------------------------------------------------------------------
 *  This is the ONLY file you need to edit to change how orders are bucketed.
 *  Everything else in the app reads from here.
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. POS detection
 * ---------------------------------------------------------------------------*/
// An order counts as POS only when Shopify says it came through the Point of
// Sale channel.
//
// It deliberately does NOT test retailLocation. A physical location gets
// attached to plenty of non-POS orders — a draft order written up in a store,
// an online order fulfilled from one — and treating that as POS quietly
// swallowed real draft orders out of every bucket. Verified against live data:
// every genuine POS order carries sourceName 'pos', app 'Point of Sale' and
// channel handle 'pos', so the location test bought nothing and cost accuracy.
export function isPOS(o) {
  const src = (o.sourceName || '').toLowerCase();
  const channel = (o.channelHandle || '').toLowerCase();
  const app = (o.appName || '').toLowerCase();
  return src === 'pos' || channel === 'pos' || app === 'point of sale';
}

/* -----------------------------------------------------------------------------
 * 1b. Ecommerce channel membership  <<< EDIT THIS SECTION >>>
 * -----------------------------------------------------------------------------
 * The Ecommerce bucket is every digital selling channel, not just the web
 * storefront. Matched on app name, because that is the only field all of these
 * populate consistently — verified against live August orders:
 *
 *   Online Store          sourceName 'web'          app 'Online Store'   handle 'web'
 *   Shop                  sourceName '3890849'      app 'Shop'           handle 'shop'
 *   StockX                sourceName '137182019585' app 'StockX'         handle NULL
 *   Marketplace Connect   sourceName <numeric id>   app 'Meta'           handle NULL
 *
 * Note the numeric sourceNames and the null channelHandles: an app-installed
 * channel gets an app id as its sourceName, so matching on sourceName or handle
 * would silently miss StockX and Marketplace Connect entirely. App name is the
 * stable key. Matching is case-insensitive and substring-based on the left, so
 * 'Shopify Mobile for iPhone' matches the 'shopify mobile' entry.
 * ---------------------------------------------------------------------------*/
export const ECOMMERCE_APPS = [
  'online store',
  'shop',
  'stockx',
  'facebook & instagram',
  'meta', // Marketplace Connect surfaces as app 'Meta'
  'marketplace connect',
  'shopify mobile',
];

export function isEcommerceChannel(o) {
  if (isPOS(o)) return false;
  const app = (o.appName || '').toLowerCase().trim();
  const channel = (o.channelName || '').toLowerCase().trim();
  const handle = (o.channelHandle || '').toLowerCase().trim();
  return ECOMMERCE_APPS.some(
    (name) => app.startsWith(name) || channel.startsWith(name) || handle === name,
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
      // Also catches the abbreviated "Cred: Alex" seen in live order notes.
      pattern: /\bcred(?:it(?:ed)?)?\s*(?:to|by|:)?\s*[-–]?\s*([A-Za-z][A-Za-z .'-]{1,40})/i,
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
 * 4. Draft attribution split  <<< EDIT THIS SECTION >>>
 * -----------------------------------------------------------------------------
 * Draft orders and assisted orders overlap heavily here: most drafts carry a
 * staff-credit note. The store's rule for splitting them is attribution:
 *
 *   a draft order keeps the DRAFT credit only when both touchpoints are direct.
 *   if either touchpoint came from a marketing or ad platform, the sale was
 *   marketing-influenced and belongs in ASSISTED instead.
 *
 * `neutralSources` is the list treated as "no marketing involvement". Anything
 * else — facebook, ig, Google, Klaviyo, tiktok, a referring domain — counts as
 * a marketing touch.
 *
 * Judgement call worth knowing: an order with no journey data at all is treated
 * as neutral, i.e. it stays in Draft. Shopify simply never resolved a source
 * for it, which is not evidence of marketing. Drop 'no journey data' from the
 * list below to flip that.
 * ========================================================================== */
export const DRAFT_ATTRIBUTION_RULE = {
  enabled: true,
  neutralSources: ['direct', 'no journey data', 'unknown', ''],
};

/** True when either touchpoint points at a marketing or ad platform. */
export function isMarketingTouched(o) {
  const neutral = DRAFT_ATTRIBUTION_RULE.neutralSources;
  return [o.firstClickSource, o.lastClickSource].some((label) => {
    const s = String(label ?? '').trim().toLowerCase();
    return !neutral.includes(s);
  });
}

/* =============================================================================
 * 5. Bucketing
 * -----------------------------------------------------------------------------
 * exclusive = true  -> every order lands in exactly one panel, so the three
 *                      panels sum to the non-POS total. (default)
 * exclusive = false -> assisted is an overlay: the middle panel re-counts orders
 *                      that also appear in online or draft.
 * ========================================================================== */
export function bucketOf(o, { exclusive = true } = {}) {
  if (isPOS(o)) return 'pos'; // excluded from all three panels
  const draft = isDraft(o);

  if (!exclusive) return draft ? 'draft' : 'online';

  if (draft) {
    // A marketing-touched draft is credited to Assisted, not Draft.
    return DRAFT_ATTRIBUTION_RULE.enabled && isMarketingTouched(o) ? 'assisted' : 'draft';
  }

  return isAssisted(o) ? 'assisted' : 'online';
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
    marketingTouched: isMarketingTouched(o),
    creditedTo: creditedTo(o),
    bucket: bucketOf(o, { exclusive }),
  };
}
