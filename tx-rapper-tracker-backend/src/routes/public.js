// src/routes/public.js
// Phase 3c — public, un-gated, server-rendered pages:
//
//   GET /a/:slug              — single-artist read-only view
//   GET /compare/:slugs       — multi-artist comparison (+-separated)
//   GET /robots.txt           — static; allow /a/ and /compare/, disallow /admin
//   GET /sitemap.xml          — generated from is_public artists
//
// Mounted in src/index.js BEFORE requireUser() so the cookie isn't
// required. No /api/* prefix; the URLs are user-visible.
//
// Architecture posture:
//   * Pure HTML rendering. No template engine — just template literals
//     in this file. Same one-file-per-page posture as app.html.
//   * No client-side data fetching for above-the-fold content. The
//     <table> IS the data; the chart hydrates from a JSON island.
//   * Strong escaping at every interpolation point. The route
//     accepts user-controlled :slug + :slugs + (in the future) query
//     strings, so nothing un-escaped reaches the response.

import { Router } from 'express';

import { query } from '../db/pool.js';
import {
  getPublicArtistBySlug,
  getPublicArtistsBySlugs,
  getPublicArtistRoster,
  isValidSlug,
} from '../services/slugs.js';
import { config } from '../config.js';

const router = Router();

// ── helpers ─────────────────────────────────────────────────────────────

const COMPARE_MAX = 5; // matches frontend COMPARE_MAX in app.html

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBigInt(n) {
  if (n == null) return '—';
  const x = Number(n);
  if (!isFinite(x)) return '—';
  return x.toLocaleString('en-US');
}

function fmtDelta(n) {
  if (n == null) return '—';
  const x = Number(n);
  if (!isFinite(x)) return '—';
  const sign = x > 0 ? '+' : '';
  return sign + x.toLocaleString('en-US');
}

/**
 * Compute origin from req for canonical URLs. Honors X-Forwarded-Proto
 * + Host so the URL emitted in <link rel="canonical"> matches what
 * Cloudflare actually serves.
 */
function originFor(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

/**
 * Pull last-365-days snapshots for an artist. Same shape the
 * /api/stats/history endpoint returns; we go direct to the DB to
 * avoid a self-fetch round trip.
 */
async function getSnapshotHistory(artistName, days = 365) {
  const { rows } = await query(
    `SELECT captured_on::text AS day, lifetime_views, subs
       FROM artist_stats_daily
      WHERE artist_name = $1
        AND captured_on >= current_date - ($2::int || ' days')::interval
      ORDER BY captured_on ASC`,
    [artistName, days]
  );
  return rows.map((r) => ({
    day: r.day,
    lifetimeViews: r.lifetime_views == null ? null : Number(r.lifetime_views),
    subs: r.subs == null ? null : Number(r.subs),
  }));
}

/**
 * Compute the headline 7-day growth from a snapshot history. Returns
 * { latestViews, latestSubs, viewGrowth7d } or null when there isn't
 * enough history to produce both endpoints.
 */
function computeHeadline(snapshots) {
  if (!snapshots.length) return null;
  const latest = snapshots[snapshots.length - 1];
  // Find the snapshot that's at or just before 7 days back from latest.
  const target = new Date(latest.day);
  target.setUTCDate(target.getUTCDate() - 7);
  const cutoff = target.toISOString().slice(0, 10);
  let prior = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].day <= cutoff) {
      prior = snapshots[i];
      break;
    }
  }
  return {
    latestViews: latest.lifetimeViews,
    latestSubs: latest.subs,
    viewGrowth7d:
      prior && prior.lifetimeViews != null && latest.lifetimeViews != null
        ? latest.lifetimeViews - prior.lifetimeViews
        : null,
  };
}

// ── shared HTML chrome ──────────────────────────────────────────────────
//
// One <head> block, one footer, used by both /a/:slug and /compare.
// Returns a string. The body content gets sandwiched between.

function pageShell({
  title,
  description,
  canonical,
  bodyHtml,
  jsonIslandData,
  appHost,
  cspNonce,
}) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeCanonical = escapeHtml(canonical);
  // Phase 3.5.2 — nonce attribute on every inline <style> + <script>
  // so the CSP nonce header authorizes them. Empty string when the
  // route is rendered outside the request lifecycle (tests); the
  // browser would block such pages anyway, which is fine — they're
  // for assertion only.
  const safeNonce = escapeHtml(cspNonce || '');
  // The JSON island is consumed by /public-pages.js to hydrate the
  // chart. We escape '</' so a malicious payload can't break out of
  // the script tag — defensive even though our payloads are all
  // numeric / known-safe.
  const safeJson = JSON.stringify(jsonIslandData || {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:type" content="website">
<meta property="og:url" content="${safeCanonical}">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="${safeCanonical}">
<style nonce="${safeNonce}">
  :root { --bg:#0a0a0a; --bg2:#121212; --text:#e6e6e6; --sub:#999;
          --border:#2a2a2a; --accent:#9d6ee0; }
  * { box-sizing: border-box; }
  body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:var(--bg); color:var(--text); line-height:1.45; }
  header { padding:18px 24px; border-bottom:1px solid var(--border);
           display:flex; justify-content:space-between; align-items:center; }
  header a { color:var(--text); text-decoration:none; font-weight:600; }
  header .cta { color:var(--accent); }
  main { max-width:980px; margin:0 auto; padding:24px; }
  h1 { font-size:1.6rem; margin:0 0 6px; }
  h2 { font-size:1.05rem; margin:24px 0 8px; color:var(--sub); font-weight:500; }
  .public-cta {
    background:var(--bg2); border:1px solid var(--border); border-radius:10px;
    padding:14px 16px; margin:14px 0;
    color:var(--sub); font-size:0.95rem;
  }
  .public-cta a { color:var(--accent); font-weight:600; }
  .public-stats { display:flex; gap:14px; flex-wrap:wrap; margin:14px 0; }
  .public-stats > div {
    flex:1 1 180px;
    background:var(--bg2); border:1px solid var(--border); border-radius:10px;
    padding:12px 14px;
  }
  .public-stats .lab {
    font-size:0.7rem; text-transform:uppercase; letter-spacing:1px; color:var(--sub);
  }
  .public-stats .val {
    font-size:1.4rem; font-weight:600; margin-top:4px;
  }
  table { border-collapse:collapse; width:100%; font-size:0.85rem; margin-top:8px; }
  th, td { padding:6px 10px; border-bottom:1px solid var(--border); text-align:left; }
  th { color:var(--sub); font-weight:500; font-size:0.7rem; text-transform:uppercase; letter-spacing:1px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .compare-grid { display:grid; gap:18px; }
  @media (min-width:720px) {
    .compare-grid { grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); }
  }
  footer { padding:18px 24px; color:var(--sub); font-size:0.78rem;
           border-top:1px solid var(--border); margin-top:32px; }
  .scroll-x { max-height: 360px; overflow:auto; border:1px solid var(--border); border-radius:8px; }
</style>
</head>
<body>
<header>
  <a href="${escapeHtml(appHost)}/">TX Rapper Tracker</a>
  <a class="cta" href="${escapeHtml(appHost)}/?signup=1">Sign up free</a>
</header>
<main>
${bodyHtml}
</main>
<footer>
  Public read-only view. <a href="${escapeHtml(appHost)}/?signup=1" style="color:var(--accent)">Sign up</a> to track artists yourself, save searches, and unlock AI-generated artist briefs.
</footer>
<script id="public-data" type="application/json" nonce="${safeNonce}">${safeJson}</script>
</body>
</html>`;
}

// ── render: single artist ──────────────────────────────────────────────

function renderArtistPage({ artist, snapshots, headline, appHost, canonical, cspNonce }) {
  const title = `${artist.name} · TX Rapper Tracker`;
  const descParts = [];
  if (headline && headline.latestViews != null) {
    descParts.push(`${fmtBigInt(headline.latestViews)} lifetime YouTube views`);
  }
  if (headline && headline.viewGrowth7d != null) {
    descParts.push(`${fmtDelta(headline.viewGrowth7d)} in the last 7 days`);
  }
  if (snapshots.length) {
    descParts.push(`Tracked since ${snapshots[0].day}.`);
  }
  const description =
    descParts.length > 0
      ? `${artist.name}: ${descParts.join('. ')}.`
      : `${artist.name} on TX Rapper Tracker.`;

  const headlineHtml = headline
    ? `
    <section class="public-stats">
      <div>
        <div class="lab">Lifetime views</div>
        <div class="val">${fmtBigInt(headline.latestViews)}</div>
      </div>
      <div>
        <div class="lab">Subscribers</div>
        <div class="val">${fmtBigInt(headline.latestSubs)}</div>
      </div>
      <div>
        <div class="lab">7-day growth</div>
        <div class="val">${fmtDelta(headline.viewGrowth7d)}</div>
      </div>
    </section>`
    : '';

  const tableRows = snapshots
    .slice()
    .reverse() // newest-first reads naturally on a public page
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.day)}</td>
        <td class="num">${fmtBigInt(r.lifetimeViews)}</td>
        <td class="num">${fmtBigInt(r.subs)}</td>
      </tr>`
    )
    .join('');

  const tableHtml = snapshots.length
    ? `
    <h2>Past year — daily snapshots</h2>
    <div class="scroll-x">
      <table aria-label="Daily YouTube channel snapshots for ${escapeHtml(artist.name)}">
        <thead><tr><th>Date</th><th class="num">Lifetime views</th><th class="num">Subscribers</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`
    : `<p style="color:var(--sub)">No snapshots yet — data will appear here once the daily tracker captures this artist.</p>`;

  const body = `
    <h1>${escapeHtml(artist.name)}</h1>
    <p class="public-cta">Track ${escapeHtml(
      artist.name
    )} yourself — <a href="${escapeHtml(appHost)}/?signup=1">sign up free</a> to add to your roster, save alerts, and see AI-generated artist briefs.</p>
    ${headlineHtml}
    ${tableHtml}
    <p class="public-cta" style="margin-top:24px">Want alerts when this artist crosses a threshold? <a href="${escapeHtml(
      appHost
    )}/?signup=1">Sign up</a>.</p>
  `;

  return pageShell({
    title,
    description,
    canonical,
    bodyHtml: body,
    jsonIslandData: {
      kind: 'public.artist',
      artist: { name: artist.name, slug: artist.slug },
      snapshots,
    },
    appHost,
    cspNonce,
  });
}

// ── render: compare ─────────────────────────────────────────────────────

function renderComparePage({ artistsWithHistory, appHost, canonical, cspNonce }) {
  const names = artistsWithHistory.map((a) => a.artist.name).join(', ');
  const title = `Compare: ${names} · TX Rapper Tracker`;
  const description = `Side-by-side YouTube channel stats for ${names}.`;

  const cards = artistsWithHistory
    .map(({ artist, snapshots, headline }) => {
      const latestRow =
        snapshots.length > 0
          ? snapshots[snapshots.length - 1]
          : { day: '—', lifetimeViews: null, subs: null };
      return `
      <article>
        <h2 style="color:var(--text); font-size:1.1rem; margin-top:0">
          <a href="${escapeHtml(appHost)}/a/${escapeHtml(
        artist.slug
      )}" style="color:var(--text); text-decoration:none">${escapeHtml(
        artist.name
      )}</a>
        </h2>
        <div class="public-stats" style="margin-top:8px">
          <div>
            <div class="lab">Lifetime views</div>
            <div class="val">${fmtBigInt(latestRow.lifetimeViews)}</div>
          </div>
          <div>
            <div class="lab">7-day growth</div>
            <div class="val">${fmtDelta(headline ? headline.viewGrowth7d : null)}</div>
          </div>
        </div>
        <p style="color:var(--sub); font-size:0.78rem; margin-top:6px">
          As of ${escapeHtml(latestRow.day)} · <a href="${escapeHtml(
        appHost
      )}/a/${escapeHtml(artist.slug)}" style="color:var(--accent)">Full history →</a>
        </p>
      </article>
    `;
    })
    .join('');

  const body = `
    <h1>Comparing ${escapeHtml(String(artistsWithHistory.length))} artists</h1>
    <p class="public-cta">Build your own comparisons — <a href="${escapeHtml(
      appHost
    )}/?signup=1">sign up free</a> for unlimited tracked artists, alerts, and audio-feature analysis.</p>
    <section class="compare-grid">${cards}</section>
    <p class="public-cta" style="margin-top:24px">Comparing different artists? <a href="${escapeHtml(
      appHost
    )}/?signup=1">Sign up</a> to build live comparisons that update daily.</p>
  `;

  return pageShell({
    title,
    description,
    canonical,
    bodyHtml: body,
    jsonIslandData: {
      kind: 'public.compare',
      artists: artistsWithHistory.map(({ artist, snapshots }) => ({
        slug: artist.slug,
        name: artist.name,
        snapshots,
      })),
    },
    appHost,
    cspNonce,
  });
}

// ── routes ──────────────────────────────────────────────────────────────
//
// Cache-Control posture (added in the Phase 3.5+ edge-cache pass):
//
//   /a/:slug + /compare/:slugs:
//     Cache-Control: public, s-maxage=300, max-age=60, stale-while-revalidate=600
//
//     s-maxage=300 — Cloudflare's edge cache holds the response for 5
//                    minutes. Snapshots refresh daily so 5 min is well
//                    inside the freshness window; viral-scale traffic
//                    is absorbed by the edge for 99%+ of requests.
//     max-age=60   — browsers + intermediaries cache for 1 minute. Keeps
//                    a quick refresh from re-fetching, doesn't lock the
//                    user out of seeing fresh data after the snapshot
//                    cron runs.
//     stale-while-revalidate=600 — clients can serve a stale response
//                    while fetching a fresh one in the background. Smooth
//                    UX during a cache-population race.
//
//   /robots.txt:
//     Cache-Control: public, max-age=3600
//     Static content. 1 hour cache means a robots edit takes effect
//     within an hour for all crawlers.
//
//   /sitemap.xml:
//     Cache-Control: public, s-maxage=3600, max-age=600
//     Refreshes when an artist is added/hidden. 1 hour at the edge,
//     10 minutes in browsers. New artists are discoverable to crawlers
//     within an hour without needing manual cache-purge.
//
// 4xx responses (404 unknown slug, 400 too-many-slugs) DO NOT carry
// Cache-Control. Cloudflare's default 4xx caching is short, and we
// don't want a temporarily-hidden artist to stay 404'd at the edge
// past when the admin flips is_public back on.

// Cache-control header values, kept as named constants so the cache
// posture is documented + greppable.
const CACHE_PUBLIC_PAGE     = 'public, s-maxage=300, max-age=60, stale-while-revalidate=600';
const CACHE_ROBOTS          = 'public, max-age=3600';
const CACHE_SITEMAP         = 'public, s-maxage=3600, max-age=600';

router.get('/a/:slug', async (req, res, next) => {
  try {
    const slug = req.params.slug;
    if (!isValidSlug(slug)) {
      return res.status(404).type('html').send('Not Found');
    }
    const artist = await getPublicArtistBySlug(slug);
    if (!artist) {
      return res.status(404).type('html').send('Not Found');
    }
    const snapshots = await getSnapshotHistory(artist.name);
    const headline = computeHeadline(snapshots);
    const origin = originFor(req);
    const html = renderArtistPage({
      artist,
      snapshots,
      headline,
      appHost: origin,
      canonical: `${origin}/a/${slug}`,
      cspNonce: res.locals.cspNonce,
    });
    res.set('Cache-Control', CACHE_PUBLIC_PAGE);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/compare/:slugs', async (req, res, next) => {
  try {
    const raw = String(req.params.slugs || '');
    // Decode %2B → +. Some clients re-encode the separator; Express
    // does NOT decode params past the URL-path layer.
    const decoded = decodeURIComponent(raw);
    const parts = decoded.split('+').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) {
      return res.status(404).type('html').send('Not Found');
    }
    if (parts.length > COMPARE_MAX) {
      return res
        .status(400)
        .json({ kind: 'compare.too_many', max: COMPARE_MAX, given: parts.length });
    }
    const artists = await getPublicArtistsBySlugs(parts);
    if (artists.length === 0) {
      return res.status(404).type('html').send('Not Found');
    }
    // Pull each artist's history. Promise.all keeps the route fast
    // even with 5 artists; each query is indexed on (artist_name, captured_on).
    const artistsWithHistory = await Promise.all(
      artists.map(async (artist) => {
        const snapshots = await getSnapshotHistory(artist.name);
        const headline = computeHeadline(snapshots);
        return { artist, snapshots, headline };
      })
    );
    const origin = originFor(req);
    const html = renderComparePage({
      artistsWithHistory,
      appHost: origin,
      canonical: `${origin}/compare/${parts.join('+')}`,
      cspNonce: res.locals.cspNonce,
    });
    res.set('Cache-Control', CACHE_PUBLIC_PAGE);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/robots.txt', (req, res) => {
  const origin = originFor(req);
  res.set('Cache-Control', CACHE_ROBOTS);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /a/',
      'Allow: /compare/',
      'Disallow: /admin',
      'Disallow: /api/',
      'Disallow: /reset',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const roster = await getPublicArtistRoster();
    const origin = originFor(req);
    const today = new Date().toISOString().slice(0, 10);
    const urls = roster
      .map(
        (a) => `  <url>
    <loc>${escapeHtml(`${origin}/a/${a.slug}`)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
  </url>`
      )
      .join('\n');
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls +
      `\n</urlset>\n`;
    res.set('Cache-Control', CACHE_SITEMAP);
    res.type('application/xml').send(xml);
  } catch (err) {
    next(err);
  }
});

export default router;

// Re-export for tests.
export { computeHeadline, renderArtistPage, renderComparePage, COMPARE_MAX };
