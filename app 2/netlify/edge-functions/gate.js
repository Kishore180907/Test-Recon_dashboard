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
<title>CLB XXIII — Order Mix</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0d10; color: #e8ecf1;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
  }
  form {
    width: min(360px, calc(100vw - 32px));
    background: #12161b; border: 1px solid #222a33; border-radius: 14px;
    padding: 28px; box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  h1 { margin: 0 0 4px; font-size: 17px; letter-spacing: -.01em; }
  p  { margin: 0 0 20px; font-size: 13px; color: #8a95a3; }
  label { display: block; font-size: 12px; color: #8a95a3; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 9px;
    border: 1px solid #2a3340; background: #0b0d10; color: #e8ecf1; font-size: 14px;
  }
  input:focus { outline: 2px solid #3b82f6; outline-offset: 1px; border-color: transparent; }
  button {
    width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 9px;
    background: #3b82f6; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #2f74e6; }
  .err { margin-top: 12px; font-size: 13px; color: #f87171; min-height: 18px; }
</style>
</head>
<body>
<form id="f">
  <h1>Order Mix</h1>
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
