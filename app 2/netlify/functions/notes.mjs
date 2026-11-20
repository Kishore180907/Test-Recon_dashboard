/* =============================================================================
 *  /api/notes — what people know about an order that Shopify does not
 *  ---------------------------------------------------------------------------
 *  Behind the password gate, all of it, and deliberately so: notes are the one
 *  part of this dashboard written in a private voice. See the header of
 *  lib/notes.js.
 *
 *    GET    /api/notes?order=<id>   every note on one order
 *    GET    /api/notes?index=1      one small row per order that has notes
 *    POST   /api/notes              add a note      {orderId, orderNumber, text, author, images}
 *    PATCH  /api/notes              edit its words  {orderId, noteId, text, author}
 *    DELETE /api/notes?order=&note= remove it, and its images with it
 * ========================================================================== */

import { readNotes, notesIndex, addNote, editNote, deleteNote } from '../../lib/notes.js';

const json = (code, body) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (req) => {
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      if (url.searchParams.get('index')) return json(200, { index: await notesIndex() });
      const order = url.searchParams.get('order');
      if (!order) return json(400, { error: 'Pass ?order= or ?index=1' });
      return json(200, await readNotes(order));
    }

    if (req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b) return json(400, { error: 'Body must be JSON' });
      return json(201, await addNote(b.orderId, {
        orderNumber: b.orderNumber,
        text: b.text,
        author: b.author,
        images: b.images,
      }));
    }

    if (req.method === 'PATCH') {
      const b = await req.json().catch(() => null);
      if (!b) return json(400, { error: 'Body must be JSON' });
      const rec = await editNote(b.orderId, b.noteId, { text: b.text, author: b.author });
      return rec ? json(200, rec) : json(404, { error: 'No such note' });
    }

    if (req.method === 'DELETE') {
      const rec = await deleteNote(url.searchParams.get('order'), url.searchParams.get('note'));
      return rec ? json(200, rec) : json(404, { error: 'No such note' });
    }

    return json(405, { error: 'Use GET, POST, PATCH or DELETE' });
  } catch (err) {
    return json(err?.status || 500, { error: String(err?.message || err) });
  }
};

export const config = { path: '/api/notes' };
