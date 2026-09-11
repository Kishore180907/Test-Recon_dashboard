/* =============================================================================
 *  Password gate — runs at the edge, in front of every route.
 *  Anything without a valid session cookie gets the login screen instead of the
 *  dashboard, so revenue numbers never reach an unauthenticated request.
 * ========================================================================== */

import { verifyToken, readCookie, env } from '../../lib/auth.js';

const OPEN_PATHS = new Set(['/api/login', '/favicon.ico']);

export default async (request, context) => {
  const url = new URL(request.url);

  if (OPEN_PATHS.has(url.pathname)) return context.next();

  // The backfill re-invokes itself server-side and carries the admin key.
  const adminKey = env('ADMIN_KEY');
  if (adminKey && request.headers.get('x-admin-key') === adminKey) return context.next();

  const token = readCookie(request.headers.get('cookie'));
  if (await verifyToken(token)) return context.next();

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(loginPage(), {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
};

function loginPage() {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CLB XXIII — Multi Attribution · Source of Truth</title>
<style>
  /* Matches the dashboard: white blended with green, frosted glass, muted
     throughout. Hard-coded rather than tokenised — this screen ships inside the
     edge function and shares no stylesheet with the app. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px;
    background: #eef4ee; color: #1b2a22;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
  }
  body::before {
    content: ""; position: fixed; inset: 0; z-index: -1;
    background:
      radial-gradient(60rem 40rem at 12% -10%, #dcebe0, transparent 60%),
      radial-gradient(50rem 34rem at 92% 8%, #dcebe0, transparent 55%),
      linear-gradient(175deg, transparent, #dcebe0);
    opacity: .85;
  }
  form {
    width: min(360px, calc(100vw - 32px));
    background: rgba(255,255,255,0.58);
    border: 1px solid rgba(27,42,34,0.10); border-top-color: rgba(255,255,255,0.75);
    border-radius: 16px; padding: 28px;
    -webkit-backdrop-filter: saturate(150%) blur(18px);
    backdrop-filter: saturate(150%) blur(18px);
    box-shadow: 0 2px 6px rgba(27,42,34,.06), 0 18px 44px rgba(27,42,34,.10);
  }
  h1 { margin: 0; font-size: 17px; letter-spacing: -.01em; font-weight: 640; }
  .sot {
    display: inline-block; margin: 8px 0 0;
    font-size: 10.5px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
    color: #7aa888; background: rgba(122,168,136,0.15);
    border: 1px solid rgba(122,168,136,0.30);
    border-radius: 999px; padding: 3px 9px;
  }
  p  { margin: 14px 0 20px; font-size: 13px; color: #87988e; }
  label { display: block; font-size: 12px; color: #87988e; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 10px;
    border: 1px solid rgba(27,42,34,0.14); background: rgba(255,255,255,0.7);
    color: #1b2a22; font-size: 14px;
  }
  input:focus { outline: 2px solid #7aa888; outline-offset: 1px; border-color: transparent; }
  button {
    width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 10px;
    background: #7aa888; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
    transition: background .15s;
  }
  button:hover { background: #6b9a79; }
  .err { margin-top: 12px; font-size: 13px; color: #b87070; min-height: 18px; }
</style>
</head>
<body>
<form id="f">
  <h1>Multi Attribution</h1>
  <div><span class="sot">Source of Truth</span></div>
  <p>CLB XXIII &middot; enter the dashboard password</p>
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" autofocus />
  <button type="submit">Open dashboard</button>
  <div class="err" id="e"></div>
</form>
<script>
  const f = document.getElementById('f');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const e = document.getElementById('e');
    e.textContent = '';
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }),
    });
    if (res.ok) { location.reload(); return; }
    const body = await res.json().catch(() => ({}));
    e.textContent = body.error || 'Sign-in failed';
  });
</script>
</body>
</html>`;
}

export const config = { path: '/*' };
