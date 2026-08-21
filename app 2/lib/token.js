/* =============================================================================
 *  Admin API credentials.
 *  -----------------------------------------------------------------------
 *  Two ways to authenticate, picked automatically:
 *
 *  1. SHOPIFY_ADMIN_TOKEN   - a permanent shpat_ token from an admin-created
 *                             custom app. Used as-is.
 *
 *  2. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET - a Dev Dashboard app. These
 *     are exchanged for an access token via the client-credentials grant. That
 *     token expires (Shopify currently issues ~24h ones), so it is cached in
 *     storage with its expiry and re-fetched a few minutes before it lapses.
 *     Every function shares the cache, so a token is fetched once per day
 *     rather than once per invocation.
 * ========================================================================== */

import { getJSON, setJSON } from './blobs.js';

const STORE = 'meta';
const KEY = 'shopify-token';

/** Refresh this far ahead of expiry so a request never races the deadline. */
const EARLY_REFRESH_MS = 10 * 60 * 1000;

/** Per-instance cache, so a warm function doesn't re-read storage every call. */
let memo = null;

export function credentialMode() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return 'static-token';
  if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) return 'client-credentials';
  return 'none';
}

export async function getAccessToken({ force = false } = {}) {
  const mode = credentialMode();

  if (mode === 'static-token') return process.env.SHOPIFY_ADMIN_TOKEN;

  if (mode === 'none') {
    throw new Error(
      'No Shopify credentials. Set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.'
    );
  }

  const usable = (t) => t?.accessToken && t.expiresAt - EARLY_REFRESH_MS > Date.now();

  if (!force && usable(memo)) return memo.accessToken;

  if (!force) {
    const stored = await getJSON(STORE, KEY, { strong: true });
    if (usable(stored)) {
      memo = stored;
      return stored.accessToken;
    }
  }

  const fresh = await exchangeClientCredentials();
  memo = fresh;
  await setJSON(STORE, KEY, fresh);
  return fresh.accessToken;
}

async function exchangeClientCredentials() {
  const shop = process.env.SHOPIFY_SHOP;
  if (!shop) throw new Error('SHOPIFY_SHOP is not set (e.g. clb-xxiii.myshopify.com)');

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // The cross-organization case is the common failure and has a specific fix,
    // so name it rather than surfacing a bare 400.
    if (/client credentials cannot be performed/i.test(text)) {
      throw new Error(
        'Shopify refused client_credentials: the app and the store are in different organizations. ' +
          'Use an admin-created custom app token (SHOPIFY_ADMIN_TOKEN) instead.'
      );
    }
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Token exchange returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!body.access_token) {
    throw new Error(`Token exchange returned no access_token: ${text.slice(0, 200)}`);
  }

  // Shopify returns expires_in seconds; fall back to 12h if it ever omits it.
  const ttlMs = (Number(body.expires_in) || 12 * 60 * 60) * 1000;

  return {
    accessToken: body.access_token,
    scope: body.scope || null,
    expiresAt: Date.now() + ttlMs,
    fetchedAt: new Date().toISOString(),
  };
}

/** Drop the cached token so the next call re-exchanges. */
export function invalidateToken() {
  memo = null;
}
