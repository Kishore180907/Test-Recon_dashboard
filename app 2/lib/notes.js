/* =============================================================================
 *  ORDER NOTES
 *  ---------------------------------------------------------------------------
 *  What a person knows about an order that Shopify does not: the customer rang
 *  about sizing, this one is a return waiting to happen, the attribution is
 *  wrong and here is the screenshot proving it.
 *
 *  Three decisions worth knowing about:
 *
 *  1. Notes are INTERNAL. They are never copied into a shared /r/ report, and
 *     the images behind them are served by a gated endpoint. That is a
 *     deliberate promise, made so the store can write plainly — "customer is a
 *     problem", "Jake messed this up" — without weighing who might end up
 *     holding the link. lib/report.js must never import this file.
 *
 *  2. Images live in their own records, not inside the note. A note is read
 *     every time its order's row is opened; a screenshot is read when somebody
 *     actually looks at it. Keeping them apart means the common path stays
 *     small, and it is what lets the browser upload one image at a time
 *     instead of posting a single body that trips the function's size limit.
 *
 *  3. They are keyed by the Shopify order id, not the order NUMBER. Numbers
 *     are display strings that a store can reformat; the id is the thing
 *     Shopify promises is stable.
 * ========================================================================== */

import { randomUUID } from 'node:crypto';
import { getJSON, setJSON, del, listKeys } from './blobs.js';

export const NOTES = 'notes';

/* Limits. Each one is a guess at "more than anyone sensibly needs", set so a
 * mistake — a paste loop, a pasted novel — cannot quietly fill the store. */
export const MAX_NOTES_PER_ORDER = 40;
export const MAX_TEXT = 4000;
export const MAX_IMAGES_PER_NOTE = 6;
export const MAX_IMAGE_BYTES = 2_500_000;
export const MAX_AUTHOR = 60;

/** The types a browser will actually produce from a screenshot or a camera. */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * The storage key for an order.
 *
 * Shopify ids arrive as `gid://shopify/Order/6227812352089`. Only the numeric
 * tail is used, and it is validated before a key is built from it — this value
 * comes off a query string, so it is the one place an outside string could
 * reach a blob name.
 */
export function orderKey(id) {
  const tail = String(id ?? '').trim().split('/').pop();
  return /^\d{1,32}$/.test(tail) ? tail : null;
}

export const validImageId = (id) =>
  typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);

const noteKey = (key) => `n/${key}`;
const imageKey = (id) => `i/${id}`;

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---------------------------------------------------------------------------
 *  Reading
 * ------------------------------------------------------------------------- */

/** Every note on one order, oldest first. Never throws on an unknown order. */
export async function readNotes(orderId) {
  const key = orderKey(orderId);
  if (!key) return { orderId: null, notes: [] };
  const rec = await getJSON(NOTES, noteKey(key), { strong: true });
  return rec && Array.isArray(rec.notes) ? rec : { orderId, orderNumber: null, notes: [] };
}

/**
 * One small object per order that has notes: how many, when it last changed,
 * and the opening words.
 *
 * The table needs to show a badge on every row that carries a note, and the
 * search box needs something to match against. Doing that with one request per
 * visible order would be a hundred requests to answer a question about a
 * handful of them, so the whole index comes back at once. It stays small
 * because it holds a preview rather than the notes.
 */
export async function notesIndex() {
  const keys = await listKeys(NOTES, 'n/');
  const out = {};
  for (const k of keys) {
    const rec = await getJSON(NOTES, k);
    if (!rec?.notes?.length) continue;
    const last = rec.notes[rec.notes.length - 1];
    out[rec.orderId] = {
      orderNumber: rec.orderNumber || null,
      count: rec.notes.length,
      images: rec.notes.reduce((s, n) => s + (n.images?.length || 0), 0),
      updatedAt: last.updatedAt || last.createdAt,
      preview: String(last.text || '').slice(0, 160),
    };
  }
  return out;
}

export async function readImage(imageId) {
  if (!validImageId(imageId)) return null;
  return getJSON(NOTES, imageKey(imageId));
}

/* ---------------------------------------------------------------------------
 *  Writing
 * ------------------------------------------------------------------------- */

/**
 * Store one image and hand back its id.
 *
 * Held as base64 inside an ordinary JSON record rather than as a raw binary
 * blob. It costs a third more space on an object of a few hundred kilobytes,
 * and it buys one storage path that behaves identically on Netlify and on the
 * local filesystem the test suite runs against — which is worth considerably
 * more than the bytes.
 */
export async function putImage({ contentType, data, width, height, bytes }) {
  if (!IMAGE_TYPES.has(contentType)) {
    const e = new Error(`Unsupported image type: ${contentType}`);
    e.status = 415;
    throw e;
  }
  const size = Number(bytes) || Math.floor((String(data || '').length * 3) / 4);
  if (!data || size > MAX_IMAGE_BYTES) {
    const e = new Error(`Image is too large — keep it under ${Math.round(MAX_IMAGE_BYTES / 1e6)}MB`);
    e.status = 413;
    throw e;
  }
  const id = randomUUID();
  await setJSON(NOTES, imageKey(id), {
    id,
    contentType,
    width: Number(width) || null,
    height: Number(height) || null,
    bytes: size,
    data,
    createdAt: new Date().toISOString(),
  });
  return { id, contentType, width: Number(width) || null, height: Number(height) || null, bytes: size };
}

/** Add a note to an order. Returns the whole updated record. */
export async function addNote(orderId, { orderNumber, text, author, images = [] } = {}) {
  const key = orderKey(orderId);
  if (!key) {
    const e = new Error('Not a valid order id');
    e.status = 400;
    throw e;
  }

  const body = clean(text, MAX_TEXT);
  const pics = (Array.isArray(images) ? images : []).filter((i) => validImageId(i?.id)).slice(0, MAX_IMAGES_PER_NOTE);
  /* A note with neither words nor a picture is a mis-click, not a note. */
  if (!body && !pics.length) {
    const e = new Error('A note needs either some text or an image');
    e.status = 400;
    throw e;
  }

  const rec = await readNotes(orderId);
  if (rec.notes.length >= MAX_NOTES_PER_ORDER) {
    const e = new Error(`This order already has ${MAX_NOTES_PER_ORDER} notes`);
    e.status = 409;
    throw e;
  }

  const now = new Date().toISOString();
  const note = {
    id: randomUUID(),
    text: body,
    author: clean(author, MAX_AUTHOR) || null,
    images: pics.map((i) => ({
      id: i.id,
      contentType: i.contentType || null,
      width: Number(i.width) || null,
      height: Number(i.height) || null,
    })),
    createdAt: now,
    updatedAt: now,
  };

  const next = {
    orderId,
    orderNumber: orderNumber || rec.orderNumber || null,
    notes: [...rec.notes, note],
  };
  await setJSON(NOTES, noteKey(key), next);
  return next;
}

/** Edit a note's words. Images are added and removed by their own calls. */
export async function editNote(orderId, noteId, { text, author } = {}) {
  const key = orderKey(orderId);
  if (!key) return null;
  const rec = await readNotes(orderId);
  const note = rec.notes.find((n) => n.id === noteId);
  if (!note) return null;

  const body = clean(text, MAX_TEXT);
  if (!body && !note.images?.length) {
    const e = new Error('A note needs either some text or an image');
    e.status = 400;
    throw e;
  }
  note.text = body;
  if (author !== undefined) note.author = clean(author, MAX_AUTHOR) || null;
  note.updatedAt = new Date().toISOString();
  await setJSON(NOTES, noteKey(key), rec);
  return rec;
}

/**
 * Delete a note, and the images that belonged to it.
 *
 * The images go too, deliberately. An orphaned screenshot nobody can see from
 * anywhere is a thing that sits in storage for ever and that nobody will ever
 * come back to clean up.
 */
export async function deleteNote(orderId, noteId) {
  const key = orderKey(orderId);
  if (!key) return null;
  const rec = await readNotes(orderId);
  const note = rec.notes.find((n) => n.id === noteId);
  if (!note) return null;

  for (const img of note.images || []) {
    if (validImageId(img.id)) await del(NOTES, imageKey(img.id));
  }
  rec.notes = rec.notes.filter((n) => n.id !== noteId);

  if (!rec.notes.length) {
    await del(NOTES, noteKey(key));
    return { ...rec, notes: [] };
  }
  await setJSON(NOTES, noteKey(key), rec);
  return rec;
}
