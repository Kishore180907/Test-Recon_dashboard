/* =============================================================================
 *  CUSTOMER JOURNEY
 *  -----------------------------------------------------------------------
 *  Turns Shopify's raw session list into something a person can read.
 *
 *  Why this file exists at all: the table shows first click and last click,
 *  and for a multi-touch order those two are often both "Direct" while the
 *  middle of the journey contains the thing that actually drove the sale.
 *  Live example from this store — order #27790, a draft order with 23 sessions
 *  over 24 days. First click Direct, last click Direct, so the dashboard files
 *  it as Draft: nobody's marketing, written up by hand. Four days before the
 *  purchase there is a Google Ads click (medium=cpc). Neither endpoint column
 *  can ever show you that.
 *
 *  Two things make the raw list unusable as-is, and both are handled here:
 *
 *  1. VOLUME. One order in a 50-order sample had 59 sessions. Another had a
 *     dozen near-identical Instagram hits ninety seconds apart. Printed one per
 *     row that is a wall of noise, so consecutive sessions from the same source
 *     collapse into a single step carrying a count and a time span.
 *
 *  2. MEANING. "Google" covers both the free Shopping feed (medium
 *     product_sync) and Google Ads (medium cpc). Those are not the same event
 *     and the difference is the whole question, so paid is flagged separately
 *     from merely marketing-attributed.
 *
 *  What is NOT here, deliberately: "invoice sent by <staff>". The Order object
 *  has no link back to its draft order and no invoice-sent event, and the
 *  staffMember field needs a scope this app does not request. What the journey
 *  does contain is the customer OPENING the invoice — a /checkouts/do/ landing
 *  page, timestamped — which is a real event rather than an inferred one.
 * ========================================================================== */

/**
 * Mediums that mean money changed hands for the click.
 *
 * `product_sync` is deliberately absent: that is Shopify's free Google Shopping
 * feed, and counting it as paid would credit the ad account for traffic it
 * never bought.
 */
const PAID_MEDIUMS = new Set([
  'cpc', 'ppc', 'paid', 'paid_social', 'paidsearch', 'paid_search',
  'display', 'retargeting', 'remarketing', 'cpm', 'cpv',
]);

/** Sources that carry no marketing signal. Matches lib/classify.js's rule. */
const NEUTRAL = new Set(['direct', 'an unknown source', 'unknown', '']);

const lower = (v) => String(v ?? '').trim().toLowerCase();

export function isPaidMoment(m) {
  return PAID_MEDIUMS.has(lower(m.utmMedium));
}

/**
 * True when the session carries any marketing attribution, paid or not: a utm
 * campaign, a known channel, an email click. A bare direct visit does not.
 */
export function isMarketingMoment(m) {
  if (m.utmSource || m.utmMedium || m.utmCampaign) return true;
  return !NEUTRAL.has(lower(m.source));
}

/** A draft-order invoice link the customer opened. */
export function isInvoiceMoment(m) {
  return /\/checkouts\/do\//i.test(m.landingPage || '');
}

/**
 * Display label for a session, best signal first. Mirrors the table's
 * "Traffic source" so the drawer and the row agree.
 */
export function labelOf(m) {
  if (isInvoiceMoment(m)) return 'Draft invoice link';
  if (m.utmSource) return m.utmMedium ? `${m.utmSource} / ${m.utmMedium}` : m.utmSource;
  const s = String(m.source ?? '').trim();
  if (!s || NEUTRAL.has(lower(s))) return 'Direct';
  // Shopify sometimes stores a bare URL in `source`.
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).hostname.replace(/^www\./, '');
  } catch {
    /* fall through to the raw string */
  }
  return s;
}

/** Two sessions belong to the same step when every attribution field matches. */
function signature(m) {
  return [
    isInvoiceMoment(m) ? 'invoice' : 'visit',
    labelOf(m),
    lower(m.utmSource),
    lower(m.utmMedium),
    lower(m.utmCampaign),
  ].join('|');
}

/**
 * Collapse a chronological moment list into readable steps.
 *
 * `order` supplies the purchase itself, which Shopify does not include in the
 * journey — the last moment is the session during which the customer bought,
 * not the purchase event.
 */
export function buildJourney(moments, order = {}) {
  const sorted = [...(moments || [])]
    .filter((m) => m && m.occurredAt)
    .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

  const steps = [];

  /* The previous order opens the timeline, and not just as trivia: Shopify
   * defines the journey's first session as "the first session since the last
   * order". The previous order is literally where this timeline starts, so
   * anchoring it there explains why the first visit is when it is — and it
   * reframes the order. A draft with 23 direct sessions reads very differently
   * once you know the same customer spent $16,500 fourteen months ago. */
  if (order.previousOrder?.createdAt) {
    const prev = order.previousOrder;
    steps.push({
      signature: 'previous',
      kind: 'previous',
      label: `Previous order ${prev.orderNumber}`,
      from: prev.createdAt,
      to: prev.createdAt,
      count: 1,
      paid: false,
      marketing: false,
      amount: prev.netPayment ?? null,
      currency: prev.currency || 'USD',
      orderNumber: prev.orderNumber,
      adminUrl: prev.adminUrl || null,
      gapDays: sorted.length
        ? Math.round((new Date(sorted[0].occurredAt) - new Date(prev.createdAt)) / 86400000)
        : null,
    });
  }
  for (const m of sorted) {
    const sig = signature(m);
    const prev = steps[steps.length - 1];

    if (prev && prev.signature === sig) {
      prev.count += 1;
      prev.to = m.occurredAt;
      // Keep the most specific landing page seen in the run.
      if (!prev.landingPage) prev.landingPage = m.landingPage || null;
      continue;
    }

    steps.push({
      signature: sig,
      kind: isInvoiceMoment(m) ? 'invoice' : 'visit',
      label: labelOf(m),
      from: m.occurredAt,
      to: m.occurredAt,
      count: 1,
      paid: isPaidMoment(m),
      marketing: isMarketingMoment(m),
      utmSource: m.utmSource || null,
      utmMedium: m.utmMedium || null,
      utmCampaign: m.utmCampaign || null,
      landingPage: m.landingPage || null,
      referrerUrl: m.referrerUrl || null,
      sourceDescription: m.sourceDescription || null,
    });
  }

  if (order.createdAt) {
    steps.push({
      signature: 'purchase',
      kind: 'purchase',
      label: 'Purchased',
      from: order.createdAt,
      to: order.createdAt,
      count: 1,
      paid: false,
      marketing: false,
      amount: order.netPayment ?? null,
      currency: order.currency || 'USD',
      creditedTo: order.creditedTo || null,
    });
  }

  for (const s of steps) delete s.signature;

  const visits = steps.filter((s) => s.kind !== 'purchase' && s.kind !== 'previous');
  const firstAt = visits[0]?.from || null;
  const lastAt = visits[visits.length - 1]?.to || null;

  return {
    steps,
    customer: {
      name: order.customerName || null,
      orders: order.customerOrders ?? null,
      spend: order.customerSpend ?? null,
      orderIndex: order.orderIndex ?? null,
      previousOrder: order.previousOrder || null,
      /* Someone who bought before and then went quiet for a long stretch is a
       * different customer from a steady repeat buyer, and the difference is
       * invisible in an order count. */
      dormantDays: steps.find((x) => x.kind === 'previous')?.gapDays ?? null,
    },
    summary: {
      // What the endpoint columns cannot tell you, stated plainly.
      sessions: sorted.length,
      steps: visits.length,
      paidTouch: visits.some((s) => s.paid),
      marketingTouch: visits.some((s) => s.marketing),
      openedInvoice: visits.some((s) => s.kind === 'invoice'),
      campaigns: [...new Set(visits.map((s) => s.utmCampaign).filter(Boolean))],
      firstAt,
      lastAt,
      spanDays:
        firstAt && lastAt
          ? Math.round((new Date(lastAt) - new Date(firstAt)) / 86400000)
          : null,
      /* The reason this drawer exists: a marketing or paid touch that sits in
       * the middle of the journey, invisible to both endpoint columns. */
      hiddenMarketing:
        visits.length > 2 &&
        !visits[0].marketing &&
        !visits[visits.length - 1].marketing &&
        visits.slice(1, -1).some((s) => s.marketing),
      hiddenPaid:
        visits.length > 2 &&
        !visits[0].paid &&
        !visits[visits.length - 1].paid &&
        visits.slice(1, -1).some((s) => s.paid),
    },
  };
}
