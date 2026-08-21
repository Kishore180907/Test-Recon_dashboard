/* POST /api/login — exchange the shared password for a signed session cookie. */

import { checkPassword, issueToken, cookieHeader, passwordIsSet } from '../../lib/auth.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!passwordIsSet()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'DASHBOARD_PASSWORD is not set on this site.' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  let password = '';
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    password = (await req.json().catch(() => ({}))).password || '';
  } else {
    password = (await req.formData().catch(() => new FormData())).get('password') || '';
  }

  // Blunt brute-force damper. The gate is a shared password, not a user system.
  await new Promise((r) => setTimeout(r, 400));

  if (!(await checkPassword(String(password)))) {
    return new Response(JSON.stringify({ ok: false, error: 'Wrong password' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': cookieHeader(await issueToken()),
    },
  });
};

export const config = { path: '/api/login' };
