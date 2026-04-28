# Phase 3c — design + decisions

Status: locked design, NOT a brainstorm. Same posture as
PHASE_3B_DESIGN.md — nail down the public-surface contract before
writing code, because slug derivation + the compare-URL format are
permanent (anyone who shares a link expects it to keep working) and we
want exactly one round of "decide what we're cooking."

This is what 3c.1 produces. 3c.2-3c.5 implement against it.

## Goal

Two new public, un-gated, server-rendered pages:

* `/a/:slug` — single-artist read-only view. Snapshot chart + last-7-day
  growth headline + "Sign up to track this artist" CTA.
* `/compare/:slugs` — read-only N-artist comparison. Same data the
  in-app compare bar pulls, just without the cookie + the interactive
  affordances.

Both are:
* Indexable by search engines (real `<table>` HTML, real `<title>`,
  real `<meta>` tags — no client-side data fetching for the
  above-the-fold content).
* Stripped of paid surfaces — no AI brief, no audio features.
* Funnel surfaces — every page has a sign-up CTA above + below the
  data, and the value proposition copy is "track this artist
  yourself, sign up free."

## Surface area

```
GET /a/:slug                  → 200 text/html  (public, indexable)
                              → 404            (slug unknown OR is_public=false)

GET /compare/:slugs           → 200 text/html  (public, indexable)
                              → 400            (malformed slug list)
                              → 404            (zero recognized slugs)

GET /robots.txt               → 200 text/plain (allow /a/, /compare/, disallow /admin)
GET /sitemap.xml              → 200 text/xml   (one entry per is_public artist)
```

All four mount BEFORE `requireUser()` in src/index.js so the cookie
isn't required.

## Slug — the permanent identifier

Locked at v1. Bumping the slug-derivation rules silently breaks every
shared URL — we will NOT change this without a redirect strategy.

```js
// services/slugs.js
export function slugify(name) {
  return name
    .normalize('NFKD')              // strip combining marks
    .replace(/[̀-ͯ]/g, '')// drop diacritics
    .toLowerCase()
    .replace(/&/g, ' and ')         // "this & that" → "this and that"
    .replace(/[^\w\s-]/g, '')       // drop quotes, parens, dots
    .trim()
    .replace(/\s+/g, '-')           // whitespace → single hyphen
    .replace(/-+/g, '-')            // collapse runs
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens
}
```

Examples (asserted in unit tests):
* "Megan Thee Stallion" → "megan-thee-stallion"
* "GloRilla"            → "glorilla"
* "Tay Money"           → "tay-money"
* "Asian Doll"          → "asian-doll"
* "Cuban Doll"          → "cuban-doll"
* "KenTheMan"           → "kentheman"
* "Beyoncé"             → "beyonce"
* "Chlöe & Halle"       → "chloe-and-halle"

Stored on the `artists` table (migration 016) as a UNIQUE column. The
roster is small + curated; collisions ("Doll" vs "Doll" duplicates
should never happen but if a future admin adds them, the UNIQUE
constraint forces them to disambiguate, which is the right answer).

Backfill: run `slugify(name)` on every existing row. If two rows
happen to slugify to the same value, the migration aborts loudly —
fail closed.

## Visibility — `is_public` flag

Per-artist BOOLEAN, default TRUE. Migration 016 adds it to `artists`.

Why default TRUE: roster is small (6 artists), we curated them, and
the "feels right" intuition from PHASE_3_BRAINSTORM.md open question 3
is opt-in (= visible by default). If an artist objects, an admin
flips the flag to false — one DB write, no deploy.

When `is_public = false`:
* `/a/:slug` returns 404 (don't leak existence to crawlers).
* Sitemap excludes the row.
* The artist STAYS in the in-app roster — only the public surface is
  hidden. Signed-in users still see the artist on the dashboard.

robots.txt is a single static file — `User-agent: * / Allow: /a/ /
Allow: /compare/ / Disallow: /admin / Disallow: /api/`. Per-artist
robots allow-listing is explicitly deferred — if we ever need it, the
existing is_public flag does most of the work.

## Compare URL — `/compare/:slugs`

Slug list, separated by `+` (URL-safe, no encoding step needed):

```
/compare/megan-thee-stallion+glorilla+kentheman
```

Why `+` not `;`: semicolons are valid in URL paths but some clients
(notably old curl + some CDN edge configs) treat them as parameter
separators. `+` is unambiguous + already gets through every URL
parser we've ever seen.

Maximum 5 slugs (matches the existing `COMPARE_MAX` in app.html).
Beyond 5 → 400 with `kind:'compare.too_many'`.

Decoding:
1. Split on `+`.
2. Filter to known + is_public slugs (silently drop unknowns — same
   posture as the in-app compare which renders 0 cards for an unknown
   name rather than 404ing the whole view).
3. If zero remain → 404.

Order is preserved exactly as the URL specifies (so users can build a
URL with a specific left-to-right ordering for screenshots). The
in-app compare deliberately re-sorts; the public compare does not.

## What's on the page

`/a/:slug` server-rendered HTML:

```
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Megan Thee Stallion · TX Rapper Tracker</title>
  <meta name="description" content="…last-7-day growth + lifetime views…">
  <meta property="og:title" content="…">
  <meta property="og:description" content="…">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="…/a/megan-thee-stallion">
  <link rel="stylesheet" href="/public-pages.css">
</head>
<body>
  <header><a href="/">TX Rapper Tracker</a> · <a href="/?signup=1">Sign up</a></header>
  <main>
    <h1>Megan Thee Stallion</h1>
    <p class="public-cta">Track Megan Thee Stallion yourself — <a href="/?signup=1">sign up free</a> to add to your roster.</p>
    <section class="public-stats">
      <div>Lifetime views: 39,200,000</div>
      <div>Subscribers: 1,281,000</div>
      <div>7-day growth: +1,400,000 views</div>
    </section>
    <section class="public-chart">
      <h2>Past year</h2>
      <table aria-label="Daily snapshots"><!-- 365 rows of date+views+subs --></table>
      <canvas id="publicChart"></canvas>
    </section>
    <p class="public-cta">Want alerts when this artist crosses a threshold? <a href="/?signup=1">Sign up</a>.</p>
  </main>
  <script defer src="/public-pages.js"></script>
</body>
</html>
```

* The `<table>` IS the data — crawlers see structured snapshot rows,
  no JavaScript required.
* The `<canvas>` hydrates client-side via `/public-pages.js` reading
  the same data from a `<script type="application/json">` block (or
  re-parsing the table). If JS is disabled the table stands alone.
* The page never calls `/api/*` — all the content is inlined at
  render time. No CORS, no auth, no client-side state.

`/compare/:slugs` is the same skeleton with N adjacent stat blocks
+ N table-with-canvas pairs.

## What's NOT on the page

* AI artist brief. Premium feature → stays behind the gate.
* Audio features. Paid feature → stays behind the gate.
* Score / ranking. Internal product surface → not relevant to a
  public visitor.
* Recent uploads / video feed. Bandwidth + thumbnail hotlinks are
  awkward; the snapshot data is enough for v1.
* Saved-search / alerts UI. Authed surface.

## Backend

```
src/services/slugs.js      — pure: slugify(name), de-slugify lookup
src/routes/public.js       — /a/:slug + /compare/:slugs + /robots.txt
                             + /sitemap.xml
src/views/public-artist.ejs (or inline templates) — render fns
```

Rate limit: per-IP, generous (anon bucket from existing
rateLimit middleware applies — these are public pages, not the
authed API).

The route module imports `query` from db/pool and assembles the
HTML from a JS template literal (same posture as the rest of the
codebase — no new template engine). Snapshot rows come from
`artist_stats_daily` directly, ordered DESC and capped at 365.

## Frontend (3c.4)

Two small additions to app.html:

* "Share" button on the artist detail page header. Clicking copies
  `${origin}/a/${slug}` to the clipboard + shows a 2s "Copied" toast.
  No URL navigation; the shared link points outward.

* "Share" button on the compare bar. Same pattern. URL is
  `${origin}/compare/${slug1}+${slug2}+...`.

Slugs come from the artist-roster fetch, which 3c.2 augments with
the `slug` column. If the slug isn't yet populated for some reason,
the Share button is hidden (defensive — better than copying a broken
URL).

## Tests + smoke (3c.5)

`test/slugs.test.js`:
1. `slugify(name)` is deterministic.
2. `slugify(name)` matches the example table verbatim (8 cases).
3. `slugify("")` returns `""` (caller's responsibility to reject).
4. Reverse lookup: `getArtistBySlug(slug)` returns the row, or null
   for unknown / archived / `is_public=false`.

`scripts/test-public-pages.sh`:
1. Anonymous GET /a/megan-thee-stallion → 200 + Content-Type
   text/html + grep for the artist name in the body + grep for
   `<table` (proves the SSR snapshot table is there).
2. Anonymous GET /a/this-doesnt-exist → 404.
3. Anonymous GET /compare/megan-thee-stallion+glorilla → 200 +
   both names appear in the body.
4. Anonymous GET /compare/foo+bar (zero recognized) → 404.
5. Anonymous GET /compare/a+b+c+d+e+f (over the cap) → 400 +
   `kind:'compare.too_many'`.
6. Anonymous GET /robots.txt → 200, contains `Allow: /a/`,
   `Disallow: /admin`.
7. Anonymous GET /sitemap.xml → 200, contains
   `<loc>…/a/megan-thee-stallion</loc>` once.

## Open questions explicitly closed by this doc

| # | Question | Answer |
|---|----------|--------|
| 1 | Slug format? | NFKD-fold → ASCII → lowercase → hyphenate. Locked. |
| 2 | Compare URL format? | `+`-separated slugs in the path. Max 5. |
| 3 | Robots policy? | Default opt-in via `is_public=true`. Per-artist allow-list deferred. |
| 4 | SSR vs hydration? | Server renders the table; chart hydrates client-side. JS-disabled clients still see the data. |
| 5 | What's public? | Snapshot chart + table + headline stats + sign-up CTA. NOT briefs, features, ranking, video feed. |
| 6 | Open Graph / Twitter cards? | Yes, basic only. Image is a server-rendered SVG of the chart (deferred to a v2 polish if shareable previews matter). |

## Explicitly deferred to 3d / Phase 4

* Per-artist robots.txt allow-list (one flag is enough for v1).
* OG image generation — the basic OG meta is there; the image is
  whatever the existing `/favicon.ico` produces unless we add a
  dedicated /og/:slug.svg endpoint later.
* Login-via-shared-link UX (e.g. "you got here from a shared
  compare URL — want to sign up to save it?"). Stays a query
  param: `/?signup=1&from=/compare/...` — wire later if the
  conversion data says it matters.
