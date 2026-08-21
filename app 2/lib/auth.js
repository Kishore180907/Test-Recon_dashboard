/* =============================================================================
 *  Password gate.
 *  -----------------------------------------------------------------------
 *  Web Crypto only — no Node built-ins — so the same code runs in a Netlify
 *  Function (Node) and in the edge function (Deno) that guards every route.
 * ========================================================================== */

export const COOKIE = 'clb23_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const enc = new TextEncoder();

/** Read an env var from whichever runtime we're in: Deno (edge) or Node. */
export function env(key) {
  // eslint-disable-next-line no-undef
  if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(key);
  return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}

function secret() {
  const pw = env('DASHBOARD_PASSWORD') || '';
  const salt = env('SESSION_SECRET') || 'clb23-default-salt';
  return `${salt}::${pw}`;
}

async function hmac(message, key) {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish string compare. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function passwordIsSet() {
  return Boolean(env('DASHBOARD_PASSWORD'));
}

export async function checkPassword(candidate) {
  const expected = env('DASHBOARD_PASSWORD') || '';
  if (!expected) return false;
  // Hash both sides so the compare is length-independent.
  const [a, b] = await Promise.all([hmac(candidate ?? '', 'cmp'), hmac(expected, 'cmp')]);
  return safeEqual(a, b);
}

export async function issueToken() {
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${await hmac(exp, secret())}`;
}

export async function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(exp, secret()));
}

export function cookieHeader(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
    TTL_MS / 1000
  )}`;
}

export function readCookie(header, name = COOKIE) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
