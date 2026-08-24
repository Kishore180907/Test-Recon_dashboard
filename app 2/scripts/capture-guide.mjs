/* =============================================================================
 *  Regenerate the pictures in the "How to read this" guide (public/guide/).
 *  -----------------------------------------------------------------------
 *  Runs against the local dev server in MOCK_DATA mode, so the screenshots show
 *  the bundled fixture and never a real customer's name or order.
 *
 *  Playwright is deliberately NOT a dependency of this project: Netlify would
 *  install it on every deploy for a script that only ever runs by hand. Install
 *  it just for the occasion:
 *
 *    npm i --no-save playwright
 *    MOCK_DATA=1 LOCAL_BLOBS=1 npm run dev:local     # in another shell
 *    curl -X POST localhost:8787/api/backfill
 *    node scripts/capture-guide.mjs
 *
 *  Then shrink them, or the guide ships a megabyte of PNG:
 *    python3 -c "from PIL import Image; import glob; [Image.open(f).convert('RGB')\
 *      .quantize(colors=128, dither=Image.Dither.NONE).save(f, optimize=True)\
 *      for f in glob.glob('public/guide/*.png')]"
 * ========================================================================== */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'public', 'guide');
await fs.mkdir(OUT, { recursive: true });

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const p = await b.newPage({ viewport: { width: 1700, height: 1200 }, deviceScaleFactor: 2 });
await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
await p.fill('#start', '2026-08-11');
await p.fill('#end', '2026-08-17');
await p.click('#apply');
await p.waitForTimeout(1500);

/** Document-absolute rect, so a fullPage clip lines up regardless of scroll. */
const rect = (sel, i = 0) =>
  p.evaluate(
    ([s, n]) => {
      const el = document.querySelectorAll(s)[n];
      const r = el.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    },
    [sel, i]
  );

const shot = async (name, clip) =>
  p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, clip });

await shot('buckets', await rect('#tiles'));
await shot('range', await rect('.controls'));
await shot('chart', await rect('.card', 0));

/* Order table: header plus four rows. Row three is a paid-social order that
 * carries the ad-spend chip, which is the point of the picture. */
{
  // Clip to the card, not the table: the table is wider than the panel here and
  // a screenshot running past the card edge reads as a rendering fault.
  const t = await rect('#tbl');
  const box = await rect('.tbl-scroll');
  const r = await rect('#tbody tr', 3);
  // Trim the last sliver so the crop lands between columns rather than through
  // one, which looks like a glitch rather than a table that scrolls.
  await shot('journey', { x: box.x, y: t.y, width: box.width - 36, height: r.y + r.height - t.y });
}

/* The assisted drill-down, where the staff credit note shows. */
await p.locator('.tile[data-bucket="assisted"]').click();
await p.waitForTimeout(800);
{
  const t = await rect('#tbl');
  const n = await p.locator('#tbody tr').count();
  const r = await rect('#tbody tr', Math.min(2, n - 1));
  await shot('assisted', { x: t.x, y: t.y, width: t.width, height: r.y + r.height - t.y });
}

await shot('campaigns', await rect('#camp-card'));

await b.close();
console.log('captured');
