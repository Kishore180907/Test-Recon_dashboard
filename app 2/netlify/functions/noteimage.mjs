/* =============================================================================
 *  /api/note-image — the screenshots attached to order notes
 *  ---------------------------------------------------------------------------
 *    POST /api/note-image   store one image   {contentType, data, width, height}
 *    GET  /api/note-image?id=<uuid>           serve it back
 *
 *  One image per request, on purpose. A note with five screenshots posted as a
 *  single body would be ten megabytes of base64 against a function limit of
 *  six, and the failure would arrive only after the slowest upload of the set
 *  had already finished. One at a time also means the browser can show which
 *  one is still going.
 *
 *  Behind the gate like everything else here. Notes are internal, and an image
 *  anyone could fetch by id would quietly make them public.
 * ========================================================================== */

import { putImage, readImage } from '../../lib/notes.js';

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const rec = await readImage(url.searchParams.get('id'));
      if (!rec) return json(404, { error: 'No such image' });

      return new Response(Buffer.from(rec.data, 'base64'), {
        status: 200,
        headers: {
          'content-type': rec.contentType,
          /* An id is a v4 uuid and its bytes never change, so this is safe to
           * keep — but only in the viewer's own browser. `private` keeps it
           * out of any shared cache, which matters for a gated image. */
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
          'content-disposition': 'inline',
        },
      });
    }

    if (req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b?.data) return json(400, { error: 'Body must be JSON with a base64 `data` field' });
      return json(201, await putImage(b));
    }

    return json(405, { error: 'Use GET or POST' });
  } catch (err) {
    return json(err?.status || 500, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/note-image' };
