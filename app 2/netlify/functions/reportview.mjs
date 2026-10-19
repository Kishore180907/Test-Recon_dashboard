/* =============================================================================
 *  GET /r/<id> — the public report page
 *  ---------------------------------------------------------------------------
 *  The one route in front of the password gate (see OPEN_PATHS in
 *  netlify/edge-functions/gate.js), so everything about it is deliberately
 *  narrow:
 *
 *    - it serves ONE stored report and has no way to reach the dashboard, the
 *      order store or any other report;
 *    - the id must be exactly 32 hex characters, checked before a key is built,
 *      so a path cannot be walked;
 *    - a missing, malformed and revoked id all answer the same 404, because
 *      telling them apart would let someone with a guessed id learn that it was
 *      once real;
 *    - no-store and noindex, so a report does not end up in a proxy cache or a
 *      search engine.
 * ========================================================================== */

import { readReport } from '../../lib/report.js';
import { renderReportPage, esc } from '../../lib/reportpage.js';
import { encodeView } from '../../public/viewstate.js';

const html = (code, body) =>
  new Response(body, {
    status: code,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });

export default async (req) => {
  const url = new URL(req.url);
  // Parsed from the path rather than taken from a framework's params object, so
  // this behaves the same under netlify dev, the deployed runtime and a test.
  const id = (url.pathname.match(/^\/r\/([^/]+)\/?$/) || [])[1] || '';

  let rec = null;
  try {
    rec = await readReport(id);
  } catch (err) {
    return html(500, notice('Something went wrong', String(err?.message || err)));
  }

  if (!rec) {
    return html(404, notice(
      'This report is not available',
      'The link may be mistyped, or it may have been revoked by whoever shared it. ' +
      'Ask them for a fresh link.'));
  }

  const view = encodeView(rec.view || rec.range || {});
  const liveUrl = view ? `${url.origin}/#${view}` : url.origin + '/';

  return html(200, renderReportPage(rec, { liveUrl }));
};

/** Same frosted shell as the report, without any of its data. */
function notice(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(title)} — CLB XXIII</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
    background:#eef4ee; color:#1b2a22;
    font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; }
  body::before { content:""; position:fixed; inset:0; z-index:-1; opacity:.85; background:
    radial-gradient(60rem 40rem at 12% -10%, #dcebe0, transparent 60%),
    radial-gradient(50rem 34rem at 92% 8%, #dcebe0, transparent 55%),
    linear-gradient(175deg, transparent, #dcebe0); }
  div { max-width:430px; padding:28px; border-radius:16px;
    background:rgba(255,255,255,.58); border:1px solid rgba(27,42,34,.10);
    border-top-color:rgba(255,255,255,.75);
    -webkit-backdrop-filter:saturate(150%) blur(18px); backdrop-filter:saturate(150%) blur(18px);
    box-shadow:0 2px 6px rgba(27,42,34,.06), 0 18px 44px rgba(27,42,34,.10); }
  h1 { margin:0 0 10px; font-size:18px; font-weight:640; letter-spacing:-.01em; }
  p { margin:0; font-size:13.5px; color:#87988e; }
</style>
</head><body><div><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
}

export const config = { path: '/r/:id' };
