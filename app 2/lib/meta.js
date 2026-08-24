/* =============================================================================
 *  META ADS
 *  -----------------------------------------------------------------------
 *  What this can and cannot do, because it shapes everything below.
 *
 *  The Insights API reports AGGREGATES — spend, impressions, clicks, purchases
 *  and purchase value, per campaign per day. It never returns an order id, an
 *  email, or a timestamp for an individual purchase. So an order cannot be
 *  matched to a Meta purchase by "the time and date it happened": there is no
 *  per-purchase record on Meta's side to match against, and two orders in the
 *  same hour are indistinguishable in the response.
 *
 *  What DOES join cleanly is the campaign. Shopify records utm_campaign on the
 *  customer journey, and it is the Meta campaign name verbatim — verified
 *  against live data: CLB_Broad_Catalog_AJ_06/19 and CLB_Broad_Catalog_500_07/24
 *  appear identically on both sides, and the latter's Meta purchase value
 *  ($405.75) is order #27657 to the cent.
 *
 *  So the join key is the campaign name, and the useful comparison is per
 *  campaign per day: what Shopify credits by last click, next to what Meta
 *  claims. Where they disagree is the interesting part — Meta counts
 *  view-through and cross-device conversions that Shopify's last click gives to
 *  Direct, and that gap is evidence a sale was ad-influenced even when the
 *  storefront says otherwise.
 * ========================================================================== */

/** Graph API version. Pinned: Meta breaks fields between versions. */
export const META_API_VERSION = process.env.META_API_VERSION || 'v23.0';

/**
 * Purchase action types, best first. `omni_purchase` is Meta's de-duplicated
 * total across web, app and offline, which is the figure Ads Manager shows.
 * The others are fallbacks for accounts that only report a pixel event.
 */
const PURCHASE_ACTIONS = [
  'omni_purchase',
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_conversion.purchase',
];

export function metaCredentialMode() {
  if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) return 'system-user';
  if (process.env.META_ACCESS_TOKEN || process.env.META_AD_ACCOUNT_ID) return 'partial';
  return 'none';
}

/** True when the app has everything it needs to talk to Meta. */
export const metaConfigured = () => metaCredentialMode() === 'system-user';

/**
 * The join key.
 *
 * Deliberately punctuation- and space-insensitive. Meta campaign names carry
 * stray spaces the ad manager typed ("CLB_Sales_LV_ P9 _40_07/16") while the
 * same name arrives from Shopify URL-encoded, so a literal comparison misses
 * matches that are obviously the same campaign. Collapsing every run of
 * non-alphanumerics to a single dash makes both sides agree.
 */
export function campaignKey(name) {
  let s = String(name ?? '').replace(/\+/g, ' ');

  // Decode before collapsing, never after. A percent escape looks alphanumeric
  // once the percent sign is stripped, so "07%2F16" would otherwise key as
  // "07-2f16" and quietly fail to match the same campaign spelled "07/16".
  try {
    s = decodeURIComponent(s);
  } catch {
    /* a lone % that isn't a valid escape — fall through with the raw string */
  }

  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function accountPath() {
  const id = String(process.env.META_AD_ACCOUNT_ID || '').trim();
  return id.startsWith('act_') ? id : `act_${id}`;
}

/** Pull the first matching action type out of an insights row. */
function actionValue(list, types = PURCHASE_ACTIONS) {
  if (!Array.isArray(list)) return 0;
  for (const type of types) {
    const hit = list.find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

function normalizeRow(row) {
  return {
    date: row.date_start,
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || '',
    campaignKey: campaignKey(row.campaign_name),
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    purchases: actionValue(row.actions),
    purchaseValue: actionValue(row.action_values),
  };
}

/**
 * Campaign-by-day insights for [since, until] (inclusive, YYYY-MM-DD).
 *
 * time_increment=1 asks for one row per campaign per day rather than one row
 * per campaign for the whole window. Storing days means any range the dashboard
 * asks for later can be summed from what is already on disk, instead of going
 * back to Meta every time someone moves the date picker.
 */
export async function fetchCampaignInsights({ since, until, maxPages = 20 } = {}) {
  if (process.env.MOCK_DATA === '1') {
    const { SAMPLE_META_INSIGHTS } = await import('../fixtures/sample-meta.js');
    return SAMPLE_META_INSIGHTS
      .filter((r) => r.date_start >= since && r.date_start <= until)
      .map(normalizeRow);
  }

  if (!metaConfigured()) {
    throw new Error(
      'No Meta credentials. Set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID.'
    );
  }

  const params = new URLSearchParams({
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values',
    limit: '500',
    access_token: process.env.META_ACCESS_TOKEN,
  });

  let url = `https://graph.facebook.com/${META_API_VERSION}/${accountPath()}/insights?${params}`;
  const out = [];

  for (let page = 0; page < maxPages && url; page += 1) {
    const res = await fetch(url);
    const text = await res.text();

    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const err = JSON.parse(text).error;
        if (err?.message) detail = err.message;
        // An expired or revoked token is the failure worth naming: it is the one
        // that needs a human in Meta Business settings, not a retry.
        if (err?.code === 190) {
          throw new Error(`Meta rejected the access token: ${detail}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Meta rejected')) throw e;
      }
      throw new Error(`Meta insights failed (HTTP ${res.status}): ${detail}`);
    }

    const body = JSON.parse(text);
    for (const row of body.data || []) out.push(normalizeRow(row));
    url = body.paging?.next || null;
  }

  return out;
}
