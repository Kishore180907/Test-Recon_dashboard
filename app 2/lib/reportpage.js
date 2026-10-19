/* =============================================================================
 *  THE REPORT PAGE
 *  ---------------------------------------------------------------------------
 *  One stored snapshot rendered to a self-contained HTML page.
 *
 *  No scripts, no stylesheet, no font, no CDN — the whole page is the string
 *  this file returns. Partly because a stakeholder opening a link on a phone on
 *  a train should get the figures and not a spinner; mostly because a page with
 *  no JavaScript cannot be made to do anything other than show what was frozen
 *  into it, which is the entire promise of a report.
 *
 *  The chart is server-rendered SVG for the same reason.
 *
 *  Everything that came from a person — the title, the note, their name — goes
 *  through esc(). It is the only defence this page has, so it is applied at the
 *  point of interpolation, every time, with no "this one is safe" exceptions.
 * ========================================================================== */

const CUR = (n, cur = 'USD', digits = 0) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: cur || 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number(n) || 0);
const money0 = (n) => CUR(n, 'USD', 0);
const money2 = (n) => CUR(n, 'USD', 2);
const int = (n) => new Intl.NumberFormat('en-US').format(Number(n) || 0);

/** A YYYY-MM-DD calendar day, read as a calendar and never as a moment — noon
 *  UTC so no timezone can shunt it onto the day before. */
const fmtDay = (d, opts = { month: 'short', day: 'numeric' }) =>
  d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : '—';

const fmtDayYear = (d) => fmtDay(d, { month: 'short', day: 'numeric', year: 'numeric' });

const fmtWhen = (iso, tz) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        timeZone: tz || 'America/New_York',
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : '—';

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Free text from a person, with its line breaks kept. */
const escLines = (s) =>
  esc(s)
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('');

const NAMES = { online: 'Ecommerce orders', assisted: 'Assisted orders', draft: 'Draft orders' };
/* The dashboard's LIGHT palette, copied from the :root block in
 * public/index.html rather than approximated. A report that recolours the
 * buckets is a report the recipient has to re-learn, and the selftest pins
 * these three against that stylesheet so they cannot drift apart. */
const SERIES = { online: '#7aa888', assisted: '#c69a80', draft: '#8fadb4' };

/* ---------------------------------------------------------------------------
 *  Deltas
 * ------------------------------------------------------------------------- */

/**
 * One change figure, or nothing at all.
 *
 * Direction is carried by the arrow and the sign, never by colour alone. A
 * baseline of zero prints the absolute change rather than a percentage,
 * because dividing by it is how "+∞%" gets onto a page.
 */
function delta(now, before, fmt = money0) {
  if (before == null) return '';
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  const diff = a - b;
  if (b === 0) {
    if (diff === 0) return '<span class="delta flat">no change</span>';
    /* "▲ $9,557" against a baseline of nothing reads as if the whole figure
     * were growth, so the baseline is spelled out rather than implied. */
    return `<span class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ` +
      `${fmt(Math.abs(diff))}<span class="dfrom">${fmt(0)}</span></span>`;
  }
  const pct = (diff / b) * 100;
  const cls = Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down';
  const arrow = cls === 'flat' ? '' : pct > 0 ? '▲ ' : '▼ ';
  return `<span class="delta ${cls}">${arrow}${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` +
    `<span class="dfrom">${fmt(b)}</span></span>`;
}

/* ---------------------------------------------------------------------------
 *  Chart
 * ------------------------------------------------------------------------- */

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Round an axis up to a number a person reads without thinking. The same
 *  steps the dashboard uses, so the two charts scale identically. */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return (NICE_STEPS.find((s) => v / mag <= s + 1e-9) ?? 10) * mag;
}

/**
 * The daily series as stacked bars — the same chart the dashboard draws.
 *
 * Deliberately the same shape, not merely the same numbers. The person sending
 * this was looking at stacked bars; a report that redraws their finding as
 * three overlapping lines makes the recipient do translation work to agree that
 * it is the same picture, which is exactly the friction a report exists to
 * remove.
 *
 * Only days with orders are plotted, again matching the dashboard: an empty
 * Sunday is absent rather than a gap in the bars.
 */
function chartSVG(daily = []) {
  const rows = (daily || []).filter((d) => d && d.day);
  if (!rows.length) return '<p class="muted">No orders in this range.</p>';

  const W = 960, H = 250;
  const L = 60, R = 12, T = 14, B = 28;
  const iw = W - L - R, ih = H - T - B;

  const keys = ['online', 'assisted', 'draft'];
  const total = (d) => keys.reduce((s, k) => s + (Number(d[k]) || 0), 0);
  const top = niceMax(Math.max(1, ...rows.map(total)));

  const y = (v) => T + ih - ((Number(v) || 0) / top) * ih;
  const step = iw / rows.length;
  const bw = Math.min(46, step * 0.62);

  const grid = [0, top / 2, top]
    .map((gv) => {
      const gy = y(gv);
      return `<line x1="${L}" y1="${gy.toFixed(1)}" x2="${W - R}" y2="${gy.toFixed(1)}" class="grid" />` +
        `<text x="${L - 8}" y="${(gy + 4).toFixed(1)}" class="ytick">${money0(gv)}</text>`;
    })
    .join('');

  let bars = '';
  let xticks = '';
  // At most a dozen day labels, however long the range — any more and they
  // overlap into illegibility at phone width.
  const every = rows.length <= 16 ? 1 : Math.ceil(rows.length / 12);

  rows.forEach((d, i) => {
    const cx = L + step * i + step / 2;
    const stack = total(d);
    let acc = 0;
    for (const k of keys) {
      const v = Number(d[k]) || 0;
      if (v <= 0) continue;
      const yTop = y(acc + v);
      // A 2px gap between stacked segments, and none under the bottom one.
      const h = Math.max(1, y(acc) - yTop - (acc > 0 ? 2 : 0));
      const roundTop = acc + v >= stack - 0.001;
      bars += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" ` +
        `width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${SERIES[k]}"` +
        (roundTop ? ' rx="4" ry="4"' : '') + ' />';
      acc += v;
    }
    if (i % every === 0) {
      xticks += `<text x="${cx.toFixed(1)}" y="${H - 8}" class="xtick" text-anchor="middle">` +
        `${esc(fmtDay(d.day))}</text>`;
    }
  });

  const legend = keys
    .map((k) => {
      const sum = rows.reduce((s, d) => s + (Number(d[k]) || 0), 0);
      return `<span class="lg"><i style="background:${SERIES[k]}"></i>${esc(NAMES[k])} ` +
        `<b>${money0(sum)}</b></span>`;
    })
    .join('');

  return `<div class="chart">
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily revenue by bucket, stacked">
    ${grid}${bars}${xticks}
  </svg>
  <div class="legend">${legend}</div>
</div>`;
}

/* ---------------------------------------------------------------------------
 *  Page
 * ------------------------------------------------------------------------- */

function tile(key, snap, focused) {
  const b = snap.buckets?.[key] || {};
  const before = snap.comparison?.buckets?.[key]?.revenue;
  const total = ['online', 'assisted', 'draft'].reduce(
    (s, k) => s + (Number(snap.buckets?.[k]?.revenue) || 0), 0);
  const share = total > 0 ? ((Number(b.revenue) || 0) / total) * 100 : 0;

  return `<article class="tile${focused ? ' focus' : ''}" style="--series:${SERIES[key]}">
  <h3>${esc(NAMES[key])}${focused ? '<span class="pin">the finding</span>' : ''}</h3>
  <div class="hero">${money2(b.revenue)}</div>
  ${delta(b.revenue, before)}
  <dl>
    <div><dt>Orders</dt><dd>${int(b.orderCount)}${
      snap.comparison ? delta(b.orderCount, snap.comparison.buckets?.[key]?.orderCount, int) : ''
    }</dd></div>
    <div><dt>Average order</dt><dd>${money0(b.avgOrderValue)}</dd></div>
    <div><dt>Refunded</dt><dd>${money0(b.refunded)}</dd></div>
  </dl>
  <div class="bar"><span style="width:${share.toFixed(1)}%"></span></div>
  <p class="sharetext">${share.toFixed(1)}% of non-POS revenue</p>
</article>`;
}

function rowsTable(snap) {
  if (!snap.rows?.length) return '';
  const shown = snap.rows.length;
  const truncated = snap.rowsTotal && snap.rowsTotal > shown;

  const head = ['Order', 'Date', 'Net sale', 'Converted via', 'Traffic source', 'First click', 'Device']
    .concat(snap.includesNames ? ['Customer'] : []);

  const body = snap.rows
    .map((r) => {
      const cells = [
        `<span class="mono">${esc(r.orderNumber || '—')}</span>`,
        esc(fmtDay(r.day)),
        `<span class="num">${money2(r.netSale)}</span>`,
        esc(r.convertedVia || '—'),
        esc(r.trafficSource || '—'),
        esc(r.firstClick || '—'),
        esc(r.device || '—'),
      ];
      if (snap.includesNames) cells.push(esc(r.customerName || '—'));
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    })
    .join('');

  return `<section class="card">
  <h2>The orders behind it</h2>
  <p class="muted">${esc(NAMES[snap.focus] || 'Orders')} in this range${
    truncated ? ` — the first ${int(shown)} of ${int(snap.rowsTotal)}, newest first` : ''
  }.${snap.includesNames ? '' : ' Customer names are deliberately left out.'}</p>
  <div class="scroll"><table>
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>
</section>`;
}

function sourcesTable(snap) {
  const rows = (snap.sources || []).slice(0, 12);
  if (!rows.length) return '';
  const top = Math.max(...rows.map((r) => Number(r.revenue) || 0), 1);
  return `<section class="card">
  <h2>Where the revenue came from</h2>
  <p class="muted">Last click, across all three buckets.</p>
  <div class="scroll"><table>
    <thead><tr><th>Source</th><th>Orders</th><th>Revenue</th><th class="wfill">Share</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.source || 'Unknown')}</td>
      <td>${int(r.orders)}</td>
      <td><span class="num">${money2(r.revenue)}</span></td>
      <td><div class="bar sm"><span style="width:${(((Number(r.revenue) || 0) / top) * 100).toFixed(1)}%"></span></div></td>
    </tr>`).join('')}</tbody>
  </table></div>
</section>`;
}

/**
 * Render the whole page.
 *
 * @param {object} snap   a stored report record
 * @param {string} liveUrl absolute link back to the same filters on the live
 *                         dashboard — omitted entirely rather than guessed
 */
export function renderReportPage(snap, { liveUrl = '' } = {}) {
  const r = snap.range || {};
  const sameYear = String(r.start).slice(0, 4) === String(r.end).slice(0, 4);
  const rangeLabel = sameYear
    ? `${fmtDay(r.start)} – ${fmtDayYear(r.end)}`
    : `${fmtDayYear(r.start)} – ${fmtDayYear(r.end)}`;

  const cmp = snap.comparison;
  const cmpLabel = cmp
    ? `${esc(cmp.label)} · ${esc(fmtDay(cmp.range.start))} – ${esc(fmtDayYear(cmp.range.end))}`
    : '';

  const t = snap.totals || {};

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive" />
<meta name="referrer" content="no-referrer" />
<title>${esc(snap.title)} — CLB XXIII</title>
<style>
  :root {
    color-scheme: light;
    --ink: #1b2a22; --soft: #87988e; --line: rgba(27,42,34,0.10);
    --glass: rgba(255,255,255,0.58); --green: #7aa888;
    --up: #5f9070; --down: #b87070;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 22px 18px 56px; color: var(--ink); background: #eef4ee;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: ""; position: fixed; inset: 0; z-index: -1; opacity: .85;
    background:
      radial-gradient(60rem 40rem at 12% -10%, #dcebe0, transparent 60%),
      radial-gradient(50rem 34rem at 92% 8%, #dcebe0, transparent 55%),
      linear-gradient(175deg, transparent, #dcebe0);
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  .card, header.hd, .tile {
    background: var(--glass); border: 1px solid var(--line);
    border-top-color: rgba(255,255,255,0.75); border-radius: 16px;
    -webkit-backdrop-filter: saturate(150%) blur(18px);
    backdrop-filter: saturate(150%) blur(18px);
    box-shadow: 0 2px 6px rgba(27,42,34,.05), 0 14px 36px rgba(27,42,34,.07);
  }
  header.hd { padding: 22px 24px; margin-bottom: 16px; }
  .chip {
    display: inline-block; font-size: 10.5px; font-weight: 600; letter-spacing: .07em;
    text-transform: uppercase; color: var(--green); background: rgba(122,168,136,0.15);
    border: 1px solid rgba(122,168,136,0.30); border-radius: 999px; padding: 3px 9px;
  }
  h1 { margin: 12px 0 6px; font-size: 24px; letter-spacing: -.02em; font-weight: 650; }
  h2 { margin: 0 0 4px; font-size: 15px; font-weight: 640; letter-spacing: -.01em; }
  h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--soft);
       text-transform: uppercase; letter-spacing: .06em; }
  .sub { color: var(--soft); font-size: 13.5px; margin: 0; }
  .note { margin: 14px 0 0; padding: 14px 16px; border-left: 3px solid var(--green);
          background: rgba(122,168,136,0.08); border-radius: 0 10px 10px 0; }
  .note p { margin: 0 0 8px; } .note p:last-child { margin: 0; }
  .btn {
    display: inline-block; margin-top: 16px; padding: 9px 15px; border-radius: 10px;
    background: var(--green); color: #fff; text-decoration: none; font-size: 13.5px;
    font-weight: 600;
  }
  .btn.ghost { background: rgba(255,255,255,0.6); color: var(--ink);
               border: 1px solid var(--line); margin-left: 8px; }
  .tiles { display: grid; gap: 14px; grid-template-columns: repeat(3, 1fr); margin-bottom: 16px; }
  .tile { padding: 18px 20px; border-top: 2px solid var(--series); }
  .tile.focus { box-shadow: 0 0 0 2px rgba(122,168,136,.45), 0 14px 36px rgba(27,42,34,.09); }
  .pin { float: right; text-transform: none; letter-spacing: 0; font-size: 10.5px;
         color: var(--green); background: rgba(122,168,136,.14); border-radius: 999px;
         padding: 2px 8px; }
  .hero { font-size: 27px; font-weight: 650; letter-spacing: -.025em; margin: 8px 0 2px; }
  .delta { display: inline-block; font-size: 12.5px; font-weight: 600; }
  .delta.up { color: var(--up); } .delta.down { color: var(--down); } .delta.flat { color: var(--soft); }
  .dfrom { color: var(--soft); font-weight: 400; margin-left: 6px; }
  .dfrom::before { content: "from "; }
  dl { display: grid; gap: 2px; margin: 14px 0 12px; font-size: 13px; }
  dl div { display: flex; justify-content: space-between; gap: 10px; }
  dt { color: var(--soft); } dd { margin: 0; font-weight: 600; }
  dd .delta { font-weight: 600; margin-left: 8px; } dd .dfrom { display: none; }
  .bar { height: 5px; border-radius: 999px; background: rgba(27,42,34,.07); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--series, var(--green)); border-radius: 999px; }
  .bar.sm { min-width: 70px; }
  .sharetext { margin: 7px 0 0; font-size: 12px; color: var(--soft); }
  .card { padding: 18px 20px; margin-bottom: 16px; }
  .strip { display: grid; gap: 14px; grid-template-columns: repeat(4, 1fr); }
  .strip div span { display: block; font-size: 11.5px; color: var(--soft);
                    text-transform: uppercase; letter-spacing: .06em; }
  .strip div b { font-size: 17px; font-weight: 640; letter-spacing: -.02em; }
  .muted { color: var(--soft); font-size: 12.5px; margin: 0 0 12px; }
  /* height:auto keeps the bars in proportion on a wide screen; the min-height
     stops a 960-wide viewBox collapsing to a 90px strip on a phone, and
     preserveAspectRatio="none" lets it fill that height rather than letterbox. */
  .chart svg { width: 100%; height: auto; min-height: 170px; display: block; }
  .grid { stroke: rgba(27,42,34,.08); stroke-width: 1; }
  .ytick, .xtick { fill: #87988e; font-size: 11px; font-family: inherit; }
  .ytick { text-anchor: end; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; font-size: 12.5px; color: var(--soft); }
  .lg i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 6px; }
  .lg b { color: var(--ink); }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
       color: var(--soft); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
  td { padding: 8px 10px 8px 0; border-top: 1px solid var(--line); white-space: nowrap; }
  .wfill { width: 28%; }
  .mono { font-variant-numeric: tabular-nums; font-weight: 600; }
  .num { font-variant-numeric: tabular-nums; }
  footer { color: var(--soft); font-size: 12.5px; max-width: 70ch; }
  footer p { margin: 0 0 8px; }
  @media (max-width: 860px) {
    .tiles, .strip { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 560px) {
    body { padding: 14px 12px 40px; }
    .tiles, .strip { grid-template-columns: 1fr; }
    h1 { font-size: 20px; }
  }
  @media print {
    body::before { display: none; }
    body { background: #fff; }
    .card, header.hd, .tile { box-shadow: none; background: #fff; }
    .btn { display: none; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="hd">
    <span class="chip">Frozen snapshot</span>
    <h1>${esc(snap.title)}</h1>
    <p class="sub">CLB XXIII · Multi Attribution · <strong>${esc(rangeLabel)}</strong>${
      cmpLabel ? ` · vs ${cmpLabel}` : ''
    }</p>
    ${snap.note ? `<div class="note">${escLines(snap.note)}</div>` : ''}
    ${liveUrl ? `<a class="btn" href="${esc(liveUrl)}">Open live view</a>` : ''}
    <a class="btn ghost" href="#detail">See the numbers</a>
  </header>

  <div class="tiles">
    ${['online', 'assisted', 'draft'].map((k) => tile(k, snap, snap.focus === k)).join('')}
  </div>

  <section class="card" id="detail">
    <div class="strip">
      <div><span>Non-POS revenue</span><b>${money2(t.nonPosRevenue)}</b></div>
      <div><span>Non-POS orders</span><b>${int(t.nonPosOrders)}</b></div>
      <div><span>Point of sale</span><b>${money2(t.posRevenue)} · ${int(t.posOrders)}</b></div>
      <div><span>All channels</span><b>${money2(t.allRevenue)}</b></div>
    </div>
  </section>

  <section class="card">
    <h2>Revenue by day</h2>
    <p class="muted">Store time (${esc(snap.timezone || 'America/New_York')}), net of refunds.</p>
    ${chartSVG(snap.daily)}
  </section>

  ${rowsTable(snap)}
  ${sourcesTable(snap)}

  <footer>
    <p><strong>These figures do not move.</strong> They were taken from the dashboard on
      ${esc(fmtWhen(snap.createdAt, snap.timezone))}, off a Shopify sync from
      ${esc(fmtWhen(snap.dataAsOf, snap.timezone))} (store time). Orders placed, refunded or
      re-attributed since then are not in them${liveUrl ? ' — the live view above has today\'s' : ''}.</p>
    <p>Every order sits in exactly one of the three buckets, so they sum to the non-POS total.
      Point of sale is shown for reference and is not inside them.</p>
    <p>This page is reachable by its link alone. Treat the link as the credential it is.</p>
  </footer>

</div>
</body>
</html>`;
}
