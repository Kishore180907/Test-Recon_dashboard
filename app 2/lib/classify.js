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
 * 1a-ii. Online-acquired POS  <<< EDIT THIS SECTION >>>
 * -----------------------------------------------------------------------------
 * Store rule, set 2026-09-29, from order #28512.
 *
 * THE CASE. A customer clicked a Google Shopping listing, landed on a Chrome
 * Hearts bracelet page, gave their email to the Klaviyo popup at 8:48pm, and
 * the next afternoon walked into Fairfield Commons, where Jake rang up $3,700.
 * Their first ever order. Marketing found that customer and a staff member
 * closed them — which is the definition of an ASSISTED sale in this dashboard.
 * It was landing in POS, where nothing is ever credited to anyone.
 *
 * WHY THE TEST IS WHAT IT IS. Most POS customers do not exist until the moment
 * they pay: staff key an email into the terminal and Shopify creates the record
 * seconds before the order. In a 50-order sample from 1-4 September, 26 of 50
 * customer records were created less than an hour before the sale — order
 * #27890's customer was created FOURTEEN SECONDS before it. Those are walk-ins,
 * and no amount of email capture at the till makes them marketing's work.
 *
 * So the signal is not "has a customer" or "is on the email list" — it is that
 * the customer already existed, on an earlier day, before ever buying anything:
 *
 *    1. this is their FIRST order, and
 *    2. their customer record was created on an EARLIER LOCAL DAY than the sale
 *
 * Both are needed. Drop (1) and every regular who ever shopped in store counts,
 * which credits marketing with loyalty it did not create. Drop (2) and the till
 * signups flood in — 21 of the 21 first-time POS buyers in that sample were
 * created the same day, at the register.
 *
 * The bar is deliberately high and catches little: zero of those 50, and one of
 * 50 from 22-25 September (#28373, signed up on the 18th, bought $921 on the
 * 22nd). But what it catches is worth seeing — both known cases are several
 * times the ~$230 POS average, because someone who researches online and then
 * travels to the store is shopping, not grabbing.
 *
 * THE COST, stated plainly: these orders leave the POS reference figure and
 * enter Assisted, so the POS strip no longer matches Shopify's POS channel
 * total, and the three tiles no longer sum to exactly non-POS revenue. That is
 * the deliberate trade for making the sale visible to whoever closed it.
 *
 * Calendar days are compared in STORE time, not UTC. An 8:48pm signup in New
 * York is already the next day in UTC; comparing the raw timestamps would call
 * that a same-day till capture and throw the case away.
 * ---------------------------------------------------------------------------*/

import { localDateOf } from './timezone.js';

export function isOnlineAcquiredPOS(o) {
  if (!isPOS(o)) return false;

  // Their first ever order. customerOrders counts this one, so 1 means no
  // history; orderIndex is Shopify's own position and agrees when present.
  const first = Number(o?.customerOrders) === 1 || Number(o?.orderIndex) === 1;
  if (!first) return false;

  if (!o?.customerSince || !o?.createdAt) return false;
  return localDateOf(o.customerSince) < localDateOf(o.createdAt);
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
  'ebay',
];

/* -----------------------------------------------------------------------------
 * 1b-ii. eBay — unconditionally Ecommerce
 * -----------------------------------------------------------------------------
 * Store rule, set 2026-09-11: an eBay sale is an ecommerce sale, full stop. It
 * outranks every other signal — a staff credit note on an eBay order does NOT
 * move it to Assisted, and an eBay order recorded as a draft does NOT move it to
 * Draft. Only POS outranks it, and a POS sale cannot be an eBay sale anyway.
 *
 * That makes it stricter than the Shopify Mobile rule directly below, which
 * still yields to a credit note.
 *
 * HOW EBAY ACTUALLY ARRIVES — verified against orders #28113 and #28114
 * (2026-09-11). eBay is NOT a sales channel on this store. The team writes the
 * sale up by hand as a draft order against a customer account literally named
 * "Ebay". Every field that would normally identify a channel is empty:
 *
 *   sourceName          'shopify_draft_order'   (same as any other draft)
 *   app.name            'Draft Orders'
 *   channelInformation  null
 *   publication         null
 *   sourceIdentifier    null
 *   tags                []
 *   note                null
 *   customer.displayName 'Ebay'   <-- the only signal there is
 *
 * ShopifyQL is no help either: it reports these under the 'Draft Orders'
 * channel, so the order -> channel map cannot separate them from a genuine
 * desk-written draft.
 *
 * So `customerName` is the load-bearing field. The other five are kept because
 * they cost nothing and would catch eBay arriving through a real channel later
 * (Marketplace Connect, say) without another code change.
 *
 * Word-boundary matched, so 'Ebay', 'eBay Marketplace' and 'Marketplace Connect
 * - eBay' all hit while an unrelated substring like 'Storebayside' does not.
 * ---------------------------------------------------------------------------*/
const EBAY_PATTERN = /\bebay\b/i;

export function isEbayOrder(o) {
  return [
    o?.customerName, // how it actually arrives today — see the note above
    o?.salesChannel, o?.channelName, o?.appName, o?.channelHandle, o?.sourceName,
  ].some((v) => EBAY_PATTERN.test(String(v ?? '')));
}

/** @deprecated Kept so older call sites keep working. Use isEbayOrder. */
export const isEbayChannel = isEbayOrder;

/* -----------------------------------------------------------------------------
 * 1c. Which device wrote the order
 * -----------------------------------------------------------------------------
 * Shopify names one device channel — "Shopify Mobile for iPhone" — and nothing
 * for the admin on a computer. So the honest split is:
 *
 *   salesChannel starts with "Shopify Mobile"  ->  the mobile app
 *   a draft order with any other channel       ->  Shopify admin (desktop)
 *
 * `salesChannel` comes from Shopify Analytics, not the order payload: the Admin
 * API reports both kinds as app 'Draft Orders'. Orders synced before the channel
 * map existed simply have no salesChannel and fall through as "not mobile",
 * which is the safe direction — they keep their old bucket.
 * ---------------------------------------------------------------------------*/
export function isMobileAppChannel(o) {
  return /^shopify mobile/i.test(String(o?.salesChannel ?? '').trim());
}

/** Human label for the drill-down's device column. Null when not applicable. */
export function deviceLabel(o) {
  /* A POS sale that reached Assisted is sitting among draft-written orders, so
   * it says where it was actually rung up. Without this it would be the only
   * row in the panel with no origin at all. */
  if (isOnlineAcquiredPOS(o)) return 'In store';
  if (isPOS(o)) return null;
  // A marketplace sale has no staff device behind it, so it gets no device
  // label even in the unlikely case Shopify records it as a draft.
  if (isEbayOrder(o)) return null;
  if (isMobileAppChannel(o)) return 'Shopify iPhone';
  // Only drafts are ambiguous enough to be worth labelling; a storefront order
  // was placed by the customer, not written up by staff on any device.
  if (isDraft(o)) return 'Shopify desktop';
  return null;
}

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

/* -----------------------------------------------------------------------------
 * 4b. Was there ever an ONLINE touchpoint?  <<< EDIT THIS SECTION >>>
 * -----------------------------------------------------------------------------
 * Store rule, set 2026-09-28. A draft order is a draft order even when it was
 * written up on a phone — unless the customer actually came through the site.
 *
 * The problem this fixes: Shopify records the customer opening a staff-sent
 * invoice link as a "visit", so an order with no marketing behind it at all
 * still shows a touchpoint, sourced Direct. Order #28082 is the example — one
 * touchpoint, Direct, landing on /checkouts/do/…, converted through the invoice
 * link. Nothing about that is ecommerce; the only reason it sat in the
 * Ecommerce tile is that the draft was written in the Shopify mobile app.
 *
 * So the mobile-app override now asks for evidence of a real journey:
 *
 *   a marketing or referral source           -> online. Instagram, Google, a
 *                                               Klaviyo email, a referring site.
 *   a landing page that is NOT the invoice   -> online. They browsed: a product
 *                                               page, a collection, the home
 *                                               page, search.
 *   nothing but the invoice link, or no      -> NOT online. Falls through to the
 *   journey at all                              draft rules below.
 *
 * INFERENCE WORTH KNOWING. Shopify exposes only the first and last visit, so a
 * journey of four touchpoints with the invoice link at both ends could in
 * principle hide a real browse in the middle. Store decision: treat it as
 * Draft anyway — repeat opens of the same invoice are still not an online
 * touchpoint. Two orders in the 90 days to 2026-09-28 turned on this
 * ($3,205 of $150k). To require a fully visible journey instead, add a
 * touchpoint-count test here.
 * ---------------------------------------------------------------------------*/

/* Both flavours of invoice checkout carry /do/<token>: the storefront's
 * /checkouts/do/<token>/en-us and Shop Pay's
 * shop.app/checkout/<shop id>/do/<token>/en-us/shoppay. A storefront path like
 * /collections/amiri or /products/… cannot match — no /do/ segment followed by
 * a long token. */
const DRAFT_INVOICE_LINK = /\/do\/[0-9a-z]{16,}/i;

export const isDraftInvoiceLink = (url) => DRAFT_INVOICE_LINK.test(String(url ?? ''));

export function hasOnlineTouchpoint(o) {
  // A named source is an online touchpoint by definition — somebody's channel
  // put the customer here, even if they landed straight on the invoice.
  if (isMarketingTouched(o)) return true;

  const pages = [o?.firstVisit?.landingPage, o?.lastVisit?.landingPage].filter(Boolean);
  if (!pages.length) return false;   // Shopify resolved no journey at all.
  return pages.some((p) => !isDraftInvoiceLink(p));
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
  /* An in-store sale to someone marketing acquired online is credited to
   * Assisted rather than disappearing into the POS reference figure. This is
   * the one and only way a POS order reaches a panel — see isOnlineAcquiredPOS
   * for the test and for what it costs. */
  if (isOnlineAcquiredPOS(o)) return 'assisted';

  if (isPOS(o)) return 'pos'; // excluded from all three panels

  /* eBay is Ecommerce unconditionally — see isEbayOrder. This sits above both
   * the draft test and the assisted test, so neither a credit note nor draft
   * origin can move an eBay sale out of Ecommerce. */
  if (isEbayOrder(o)) return 'online';

  /* A draft written up in the Shopify mobile app is an ecommerce sale, not a
   * desk-written invoice. The Admin API cannot tell the two apart — both report
   * app 'Draft Orders' — so `salesChannel` is stamped onto the order from
   * Shopify Analytics before bucketing (see lib/shopify.js fetchOrderChannels).
   *
   * This runs BEFORE the draft test on purpose: without it these orders fall
   * into Draft and the Ecommerce tile understates by the size of that channel
   * ($56,636 across 17 orders in August 2026).
   *
   * It is CONDITIONAL on there having been a real online touchpoint. Writing
   * the invoice on a phone does not make the sale ecommerce; the customer
   * arriving through the site does. Without this guard an invoice the customer
   * opened once, straight from a text message, counted as an ecommerce sale
   * purely because of the device the staff member happened to hold. See
   * hasOnlineTouchpoint. */
  if (isMobileAppChannel(o) && hasOnlineTouchpoint(o)) {
    return isAssisted(o) ? 'assisted' : 'online';
  }

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
    fromMobileApp: isMobileAppChannel(o),
    fromEbay: isEbayOrder(o),
    marketingTouched: isMarketingTouched(o),
    onlineTouchpoint: hasOnlineTouchpoint(o),
    onlineAcquiredPOS: isOnlineAcquiredPOS(o),
    creditedTo: creditedTo(o),
    bucket: bucketOf(o, { exclusive }),
  };
}
