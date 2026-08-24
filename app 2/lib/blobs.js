/* =============================================================================
 *  Storage abstraction.
 *  -----------------------------------------------------------------------
 *  On Netlify  -> Netlify Blobs (durable, survives deploys and cold starts).
 *  Locally     -> .blobs/ on disk, so `npm run check` and `netlify dev` work
 *                 without any cloud setup.
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';

const useNetlify = () =>
  process.env.LOCAL_BLOBS !== '1' &&
  Boolean(process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT);

/* ---- Netlify backend ------------------------------------------------------ */
/*
 * Every store is opened with strong consistency, deliberately.
 *
 * Two reasons, both learned the hard way in production:
 *   1. The eventually-consistent read path returned "Failed to decode token:
 *      Token expired" 500s while strong reads on the same site kept working,
 *      taking the whole dashboard down.
 *   2. The backfill does a read-modify-write on the same month shard from
 *      consecutive pages seconds apart. A stale read there silently drops every
 *      order the previous pages added.
 *
 * Strong reads cost a little latency. At this data size — a few hundred orders
 * across four month shards — that is not worth trading for either failure.
 */
const netlifyStores = new Map();
async function nlStore(name) {
  if (!netlifyStores.has(name)) {
    const { getStore } = await import('@netlify/blobs');
    netlifyStores.set(name, getStore({ name, consistency: 'strong' }));
  }
  return netlifyStores.get(name);
}

/* ---- Local filesystem backend --------------------------------------------- */
const ROOT = path.join(process.cwd(), '.blobs');
const fsPath = (store, key) => path.join(ROOT, store, `${encodeURIComponent(key)}.json`);

/* ---- Public API ----------------------------------------------------------- */

/** Read a JSON value. Always a strongly-consistent read — see nlStore above. */
export async function getJSON(store, key) {
  if (useNetlify()) {
    const s = await nlStore(store);
    return (await s.get(key, { type: 'json' })) ?? null;
  }
  try {
    return JSON.parse(await fs.readFile(fsPath(store, key), 'utf8'));
  } catch {
    return null;
  }
}

export async function setJSON(store, key, value) {
  if (useNetlify()) {
    const s = await nlStore(store);
    await s.setJSON(key, value);
    return;
  }
  const p = fsPath(store, key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value));
}

export async function del(store, key) {
  if (useNetlify()) {
    const s = await nlStore(store);
    await s.delete(key);
    return;
  }
  try {
    await fs.unlink(fsPath(store, key));
  } catch {
    /* already gone */
  }
}

export async function listKeys(store, prefix = '') {
  if (useNetlify()) {
    const s = await nlStore(store);
    const { blobs } = await s.list({ prefix });
    return blobs.map((b) => b.key);
  }
  try {
    const names = await fs.readdir(path.join(ROOT, store));
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => decodeURIComponent(n.slice(0, -5)))
      .filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}
