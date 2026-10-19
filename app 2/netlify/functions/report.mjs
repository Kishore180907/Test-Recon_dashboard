/* =============================================================================
 *  /api/report — create, list and revoke shared findings
 *  ---------------------------------------------------------------------------
 *  Behind the password gate, all of it. Only someone who can already see the
 *  dashboard may mint a link that shows part of it to someone who cannot.
 * ========================================================================== */

import { buildSnapshot, saveReport, listReports, revokeReport } from '../../lib/report.js';

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    try {
      return json(200, { reports: await listReports() });
    } catch (err) {
      return json(500, { error: String(err?.message || err) });
    }
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    try {
      const ok = await revokeReport(id);
      return ok ? json(200, { revoked: id }) : json(404, { error: 'No such report' });
    } catch (err) {
      return json(500, { error: String(err?.message || err) });
    }
  }

  if (req.method !== 'POST') return json(405, { error: 'Use POST, GET or DELETE' });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }

  try {
    const snapshot = await buildSnapshot({
      start: body.start,
      end: body.end,
      bucket: body.bucket,
      cmpMode: body.cmpMode,
      cmpCustom: body.cmpCustom,
      title: body.title,
      note: body.note,
      rows: body.rows !== false,
      names: body.names === true,
      author: body.author,
    });
    const saved = await saveReport(snapshot);

    /* The absolute link, built from the request's own origin rather than a
     * configured site URL. One less thing to set, and it is right on a deploy
     * preview and on the production domain without either knowing about the
     * other. */
    return json(201, {
      id: saved.id,
      url: `${url.origin}/r/${saved.id}`,
      title: saved.title,
      createdAt: saved.createdAt,
    });
  } catch (err) {
    return json(err?.status || 500, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/report' };
