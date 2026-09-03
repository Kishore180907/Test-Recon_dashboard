/* =============================================================================
 *  Local dev server.
 *  -----------------------------------------------------------------------
 *  Serves public/ and routes /api/* to the same function handlers Netlify runs,
 *  backed by the on-disk blob store. Lets you work on the dashboard without the
 *  Netlify CLI:
 *      MOCK_DATA=1 npm run dev:local        # fixture data, no Shopify needed
 *      npm run dev:local                    # real Shopify, needs .env
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/* ---- .env loader (no dependencies) --------------------------------------- */
const envFile = path.join(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
process.env.LOCAL_BLOBS = '1';

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = path.join(process.cwd(), 'public');

const handlers = {
  '/api/data': (await import('../netlify/functions/data.mjs')).default,
  '/api/config': (await import('../netlify/functions/appconfig.mjs')).default,
  '/api/status': (await import('../netlify/functions/status.mjs')).default,
  '/api/journey': (await import('../netlify/functions/journey.mjs')).default,
  '/api/channels': (await import('../netlify/functions/channels.mjs')).default,
  '/api/login': (await import('../netlify/functions/login.mjs')).default,
  '/api/sync-now': (await import('../netlify/functions/sync-now.mjs')).default,
  '/api/backfill': (await import('../netlify/functions/backfill-background.mjs')).default,
};

const gate = (await import('../netlify/edge-functions/gate.js')).default;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function toResponse(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = `http://localhost:${PORT}${req.url}`;
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end('Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

async function send(res, response) {
  const buf = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const request = await toResponse(req);

    // Same gate the edge function applies in production.
    if (process.env.DASHBOARD_PASSWORD) {
      let passed = false;
      const gated = await gate(request.clone(), { next: () => { passed = true; return null; } });
      if (!passed) return send(res, gated);
    }

    const handler = handlers[pathname];
    if (handler) return send(res, await handler(request));
    return serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  CLB XXIII dashboard (local)  →  http://localhost:${PORT}`);
  console.log(`  data source: ${process.env.MOCK_DATA === '1' ? 'FIXTURE' : process.env.SHOPIFY_SHOP || 'Shopify (not configured)'}`);
  console.log(`  password gate: ${process.env.DASHBOARD_PASSWORD ? 'on' : 'off'}\n`);
});
