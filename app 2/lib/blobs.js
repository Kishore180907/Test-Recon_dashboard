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
const netlifyStores = new Map();
async function nlStore(name, consistency) {
  const key = `${name}:${consistency || 'eventual'}`;
  if (!netlifyStores.has(key)) {
    const { getStore } = await import('@netlify/blobs');
    netlifyStores.set(key, getStore({ name, consistency: consistency || 'eventual' }));
  }
  return netlifyStores.get(key);
}

/* ---- Local filesystem backend --------------------------------------------- */
const ROOT = path.join(process.cwd(), '.blobs');
const fsPath = (store, key) => path.join(ROOT, store, `${encodeURIComponent(key)}.json`);

/* ---- Public API ----------------------------------------------------------- */

/**
 * Read a JSON value. `strong: true` bypasses eventual consistency — use it for
 * the sync watermark and lock, where a stale read causes duplicate work.
 */
export async function getJSON(store, key, { strong = false } = {}) {
  if (useNetlify()) {
    const s = await nlStore(store, strong ? 'strong' : 'eventual');
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
