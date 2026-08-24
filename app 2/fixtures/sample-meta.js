/* =============================================================================
 *  Offline preview fixture — Meta Ads campaign insights for Aug 11–17, 2026,
 *  in the raw shape the Graph API returns, so lib/meta.js parses it with the
 *  same code path it uses in production. Run with MOCK_DATA=1.
 *
 *  Campaign names and the general shape of the numbers are taken from the live
 *  CLB XXIII ad account. Four cases are deliberately represented:
 *
 *    CLB_Broad_Catalog_AJ_07/31   both sides agree           (clean match)
 *    CLB_Broad_Catalog_AJ_06/19   Meta counts more purchases (attribution gap)
 *    CLB_Sales_LV_ P9 _40_07/16   stray spaces in the name   (join-key test)
 *    CLB_Broad_Catalog_500_07/24  Meta only, no Shopify order (view-through)
 *
 *  CLB_Sale_Signup_08/06 appears on a Shopify order but has no row here, which
 *  is the fifth case: a campaign the storefront saw and Meta did not bill for.
 * ========================================================================== */

// [date, campaignId, campaignName, spend, impressions, clicks, purchases, value]
const rows = [
  ['2026-08-11', '120248465254210707', 'CLB_Broad_Catalog_AJ_07/31', 41.18, 1904, 132, 1, 179.65],
  ['2026-08-12', '120248465254210707', 'CLB_Broad_Catalog_AJ_07/31', 38.02, 1771, 118, 1, 179.65],
  ['2026-08-14', '120248465254210707', 'CLB_Broad_Catalog_AJ_07/31', 33.83, 1649, 119, 1, 140.0],
  ['2026-08-16', '120248465254210707', 'CLB_Broad_Catalog_AJ_07/31', 29.44, 1402, 96, 0, 0],

  ['2026-08-11', '120246922380430707', 'CLB_Broad_Catalog_AJ_06/19', 128.9, 6017, 671, 1, 620.0],
  ['2026-08-13', '120246922380430707', 'CLB_Broad_Catalog_AJ_06/19', 141.22, 6688, 742, 2, 1265.0],
  ['2026-08-15', '120246922380430707', 'CLB_Broad_Catalog_AJ_06/19', 134.6, 6402, 715, 2, 980.0],
  ['2026-08-17', '120246922380430707', 'CLB_Broad_Catalog_AJ_06/19', 119.75, 5588, 623, 1, 615.0],

  ['2026-08-12', '120248141553780707', 'CLB_Sales_LV_ P9 _40_07/16', 38.11, 1470, 132, 1, 890.0],
  ['2026-08-15', '120248141553780707', 'CLB_Sales_LV_ P9 _40_07/16', 44.06, 1702, 155, 2, 1420.0],

  ['2026-08-13', '120248323777220707', 'CLB_Broad_Catalog_500_07/24', 26.5, 1508, 82, 1, 405.75],
  ['2026-08-16', '120248323777220707', 'CLB_Broad_Catalog_500_07/24', 24.18, 1390, 77, 1, 312.4],
];

export const SAMPLE_META_INSIGHTS = rows.map(
  ([date, id, name, spend, impressions, clicks, purchases, value]) => ({
    date_start: date,
    date_stop: date,
    campaign_id: id,
    campaign_name: name,
    spend: String(spend),
    impressions: String(impressions),
    clicks: String(clicks),
    actions: [
      { action_type: 'link_click', value: String(clicks) },
      { action_type: 'omni_purchase', value: String(purchases) },
    ],
    action_values: [{ action_type: 'omni_purchase', value: String(value) }],
  })
);
