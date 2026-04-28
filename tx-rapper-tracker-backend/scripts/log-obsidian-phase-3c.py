#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phase 3c + the start of Phase 3.5.

Picks up where log-obsidian-phase-3.py left off. Adds Build Log + Error
Log rows for:

  * 3c.1 — design + decisions (slug rules, robots policy, public scope)
  * 3c.2 — migration 016 (artists.slug + artists.is_public)
  * 3c.3 — services/slugs.js + routes/public.js + 16 unit tests
  * 3c.4 — frontend Share buttons (artist detail + compare bar) + plumbing
  * 3c.5 — public-pages smoke (closes Phase 3c)
  * 3.5  — hardening pass design doc (PHASE_3_5_HARDENING.md)
  * 3.5.1 — launchd plist for backend auto-restart

Same shape as log-obsidian-phase-3.py: BUILD_ROWS / ERROR_ROWS literals
with a __DATE__ placeholder substituted at runtime, ensure_row inserts
under '## Build Log' or '## Error Log' only on miss, dedupe pass at
the end. Safe to re-run.

Run:
    python3 scripts/log-obsidian-phase-3c.py
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

# ---------------------------------------------------------------------------
# Rows to ensure present.  Plain strings (NOT f-strings) — we substitute
# __DATE__ below.  This keeps braces in the body (e.g. {limit, sortBy})
# from being parsed as f-string expressions.
# ---------------------------------------------------------------------------
BUILD_ROWS = [
    # ── Phase 3c — public profile pages + shareable compare ─────────────
    '| __DATE__ | Claude (Cowork) | Phase 3c.1 — Design + decisions for public profile pages (PHASE_3C_DESIGN.md). Locks the spec for /a/:slug + /compare/:slugs + /robots.txt + /sitemap.xml — public, un-gated, server-rendered, indexable. Slug format LOCKED at v1: NFKD-fold → strip diacritics → lowercase → "&"→" and " → drop everything outside [a-z 0-9 whitespace -] → whitespace-to-hyphen → collapse runs → trim. Stored as artists.slug UNIQUE. Compare URL uses + as the slug separator (not ; — old curl + some CDN edge configs treat semicolons as parameter delimiters); max 5 (matches frontend COMPARE_MAX); preserves input order; silently drops unknown slugs. SSR vs hydration: server renders the snapshot table as proper <table> HTML so crawlers see structured data, chart hydrates client-side via /public-pages.js. JS-disabled clients still see the table. Default is_public=TRUE per open question 3 from PHASE_3_BRAINSTORM.md (roster is small + curated; opt-in feels right). Closed open questions: prompt + cache key locked at v1, Haiku 4.5, non-streaming, no manual refresh. Explicitly deferred: per-artist robots.txt allow-list (one flag covers v1), OG image generation, login-via-shared-link UX. | PHASE_3C_DESIGN.md, scripts/save-progress-3c1.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3c.2 — migration 016 (artists.slug + artists.is_public). Two new columns on the existing artists table. slug TEXT UNIQUE NOT NULL — backfilled via Postgres-side slugify that mirrors the JS implementation in services/slugs.js for the diacritics on the actual roster (translate(name, accented, ascii) + lower + regexp_replace + trim). Postgres doesn\'t expose true NFKD in stdlib; we cover what\'s in the seed list (é, ö, etc.) and the JS side handles the full NFKD. is_public BOOLEAN NOT NULL DEFAULT TRUE — admin-flippable visibility flag; FALSE hides /a/:slug + the sitemap entry but keeps the row visible to signed-in users. Backfill safety: any leftover empty-string slug (degenerate all-symbol name) falls back to the first 8 chars of the artist UUID so the UNIQUE constraint passes. Real collisions blow up the migration loudly — admin disambiguates by editing one of the names, fail-closed by design. Plus a partial index artists_public_slug_idx ON (slug) WHERE is_public AND NOT is_archived for the sitemap + public-list queries. | migrations/016_artist_slugs.sql, scripts/save-progress-3c2.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3c.3 — services/slugs.js + routes/public.js + 16 unit tests. The backend half of Phase 3c. services/slugs.js exports pure slugify(name) (locked v1 rules, drops underscores to match Postgres backfill exactly) + isValidSlug(s) (alphanumeric + hyphens, 1-100 chars, must start alnum) + DB getters (getPublicArtistBySlug, getPublicArtistsBySlugs preserving input order via Map<slug,row>, getPublicArtistRoster sorted for deterministic sitemap output). routes/public.js mounts BEFORE the /api/* gates AND BEFORE the static-frontend handler so /a/:slug + /compare/:slugs + /robots.txt + /sitemap.xml win route matching. Server-renders pure HTML via template literals (no template engine, same one-file-per-page posture as app.html). escapeHtml on every interpolation point. JSON island for chart hydration. originFor(req) honors X-Forwarded-Proto + Host so canonical URLs match what Cloudflare actually serves. Routes: GET /a/:slug → 200 (artist + 365-day snapshot table + headline lifetime/subs/7-day-growth + sign-up CTA top + bottom + JSON island) or 404 unknown/private/archived. GET /compare/:slugs → 200 (N adjacent stat cards) / 400 over cap of 5 (kind:\'compare.too_many\') / 404 zero recognized. GET /robots.txt → text/plain (Allow /a/, /compare/; Disallow /admin, /api/, /reset). GET /sitemap.xml → application/xml (<changefreq>daily</changefreq>). 16/16 PASS in test/slugs.test.js (slug determinism, 6-row seed roster, ASCII-fold, &-expansion, drops quotes/parens/dots/slashes, collapses whitespace+hyphen runs, drops underscores, returns "" for non-string/empty/all-symbol, isValidSlug accepts/rejects, computeHeadline edge cases, COMPARE_MAX=5 contract). | src/services/slugs.js, src/routes/public.js, src/index.js, test/slugs.test.js, scripts/save-progress-3c3.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3c.4 — Frontend Share buttons + slug plumbing. /api/artists now returns slug + is_public alongside id/name/sort_order; buildArtistData carries them through to artistData[i]. New "Share" button on the artist detail header (next to "+ Add to compare"); hidden when a.slug is null (= demo-mode SEED_NAMES rows would build broken URLs). Click copies <origin>/a/<slug> to clipboard, surfaces a 2.2s bottom-center toast. New "Share" button on the compare bar between "Compare →" and "clear"; visible only when EVERY picked artist has a slug (= compareSlugsForCurrentSet().length === compareSet.size). copyToClipboard prefers navigator.clipboard + isSecureContext, falls back to a hidden-textarea + execCommand shim for older browsers / non-HTTPS dev contexts; always resolves to a boolean. showShareToast uses a two-frame requestAnimationFrame nudge so the .show class triggers the opacity transition (avoids the display:none → opacity:1 same-frame swallow). Single global timer cancels prior fade on quick second click. Three new dispatcher cases (share-artist, share-compare, plus the existing pattern). ~50 lines of CSS scoped to the new affordances + a fixed-position toast at z-index 9999. Inline JS still parses cleanly (138KB single block); 16/16 slugs.test.js still PASS. | ../tx-rapper-tracker/app.html, src/routes/artists.js, scripts/save-progress-3c4.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3c.5 — Public-pages smoke + close-out for Phase 3c. scripts/test-public-pages.sh runs 8 anonymous subtests reachable without any auth: (1) GET /a/megan-thee-stallion → 200 text/html + <title> contains the artist name + page contains a <table> (proves SSR not JS-only) + rel=canonical present + sign-up CTA links present; (2) GET /a/this-doesnt-exist → 404; (3) GET /a/has%3Bsemicolon → 404 (defense-in-depth: invalid slug never reaches DB); (4) GET /compare/megan-thee-stallion+glorilla → 200 + both names in body; (5) GET /compare/a+b+c+d+e+f → 400 + kind=compare.too_many; (6) GET /compare/foo+bar → 404 (zero recognized); (7) GET /robots.txt → 200 + Allow/Disallow rules + Sitemap advertisement; (8) GET /sitemap.xml → 200 + valid <urlset> + at least one <loc> + changefreq=daily. Closes Phase 3c end-to-end. Live verify steps: npm run migrate → bash scripts/test-public-pages.sh → manual share-button + paste-incognito flow. | scripts/test-public-pages.sh, scripts/save-progress-3c5.sh | 0 |',

    # ── Phase 3.5 — hardening + self-healing pass (design + first item) ──
    '| __DATE__ | Claude (Cowork) | Phase 3.5 design — hardening + self-healing pass between 3c and 3d (PHASE_3_5_HARDENING.md). 3-4 days, no customer-visible features, material gains on every product factor (security / simplicity / upgrade-friendliness / self-healing). Four items ranked by impact-to-effort: 3.5.1 launchd plist for the BACKEND itself mirroring the audio-extract worker pattern (single biggest self-healing win — today node src/index.js has no supervisor); 3.5.2 CSP nonce migration closing the TODO in middleware/security.js (drop \'unsafe-inline\' from script-src + style-src; per-request 16-byte nonce in res.locals.cspNonce; static-html routes substitute __CSP_NONCE__ tokens); 3.5.3 snapshot + cron failure alerting via the Phase 2b mailer wrapping snapshot-stats.js + audio-extract worker + savedsearch-evaluator in try/catch + stale-data detection (MAX(captured_on) > 36h after success); 3.5.4 GET /api/health/deep composite freshness (DB SELECT 1 < 1s + last snapshot < 26h + last audio extract < 7d + briefs configured when enabled) returning 200/503 — wires to external uptime monitor + a 5-minute launchd-side cron-of-last-resort. Migration / rollback: every item is a single-revert commit. Out of scope for 3.5: migration rollback plan, staging environment, GitHub Actions CI, friendlier error copy + onboarding empty-state (folded into 3d). | PHASE_3_5_HARDENING.md, scripts/save-progress-3-5-design.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3.5.1 — launchd plist for backend auto-restart. The single biggest self-healing win. Today node src/index.js runs in whatever terminal happened to launch it; crash → manual recovery. After this commit the backend lives under a launchd LaunchAgent (~/Library/LaunchAgents/com.txrappertracker.backend.plist) that auto-restarts on non-zero exit. scripts/install-launchd-backend.sh mirrors install-launchd-extract.sh (idempotent — bootout existing version before writing new plist; XML-escapes env values for &/</> via sed; required-env validation aborts up front if DATABASE_URL/SESSION_SECRET/YOUTUBE_API_KEY are unset; optional-env passthrough for every Stripe/Anthropic/Resend/TOTP/WebAuthn/rate-limit knob; PATH baked from node\'s dir + Homebrew + system locations because launchd\'s default PATH is /usr/bin:/bin only). Plist config: RunAtLoad:true (start on login), KeepAlive:{SuccessfulExit:false} (restart on crash not clean exit), ThrottleInterval:30 (back off 30s between restarts so a fast crash loop doesn\'t burn CPU), ProcessType:Interactive (vs Background for the worker — backend has user-facing latency requirements + shouldn\'t be deprioritized by App Nap), StandardOut/ErrPath /tmp/tx-backend.{out,err}.log. scripts/restart-backend.sh is the canonical "apply code changes" command (launchctl kickstart -k); prints install instructions if the agent isn\'t loaded yet. Single-step revert: launchctl bootout + rm of the plist; backend goes back to terminal-launched. | scripts/install-launchd-backend.sh, scripts/restart-backend.sh, scripts/save-progress-3-5-1.sh | 0 |',
]

ERROR_ROWS = [
    # Issues encountered that future-me will want to remember.
    '| __DATE__ | infra | Backfilling the Phase 3 Build Log via log-obsidian-phase-3.py initially failed at parse-time: rows used f-strings with literal {...} content (e.g. "{limit, sortBy, includePartial}" in service signatures) which Python\'s f-string parser tried to evaluate as variable references. NameError: name \'limit\' is not defined. Fix: switch from f-strings to plain strings with a __DATE__ placeholder, substitute via .replace() after the BUILD_ROWS / ERROR_ROWS lists are defined. Removes the entire class of "literal brace in f-string" footgun. Pattern carried into log-obsidian-phase-3c.py. | Pass — fix in tree |',

    '| __DATE__ | infra | Running `npm test` from osascript do-shell-script context fails with "npm: command not found" because the AppleScript-spawned shell is non-login and node/npm aren\'t on PATH. Multi-line do-shell-script invocations with embedded redirect chains additionally fight with quoting (osascript silently fails with empty error messages on quoting issues). Workaround used during 3c.3 verify: `/bin/bash -lc "cd ... && node --test test/<file>.test.js 2>&1 | tail -N"` (login bash sources zshrc/.nvm). For multi-step verify, write the work to a thin wrapper script (scripts/_run-tests-tail.sh + _run-tests-to-file.sh from 3b.3) and invoke that. | Pass — workaround codified |',

    '| __DATE__ | frontend | Frontend Share buttons hide when ANY picked artist lacks a slug (= demo-mode SEED_NAMES rows). Decision was: don\'t ship a URL that 404s on the public route just because slug=null in some artistData row. compareSlugsForCurrentSet() filters before joining; if length differs from compareSet.size we hide cb-share entirely. detail-share-btn uses the same posture (hidden when a.slug is falsy). Better than a copy-broken-URL footgun. | Pass — design choice |',

    '| __DATE__ | backend | Postgres-side slugify in migration 016 covers the diacritics on the ACTUAL roster (translate of "àáâãäåāăąçćč..." → "aaaaaaaaaccc...") rather than implementing full Unicode NFKD. The JS-side slugify (services/slugs.js) handles full NFKD. Decision was: the JS rules are the contract for runtime slug derivation; the Postgres rules only need to backfill 6 existing rows correctly. Verified by rendering each seed row through both implementations and comparing — they agree on every entry. Future seed additions with exotic diacritics that aren\'t in the translate() string would slugify differently SQL-side vs JS-side; documented in migration comment so the next admin who adds a row notices. | Pass — covered, documented |',
]


def ensure_row(all_lines, row, section_header):
    """Insert `row` into the markdown table under `section_header` if not
    already present as an exact line. Returns (new_lines, inserted_bool)."""
    if row in all_lines:
        return all_lines, False
    try:
        i = all_lines.index(section_header)
    except ValueError:
        return all_lines, False
    j = i
    last_table_row = i
    while j < len(all_lines):
        ln = all_lines[j]
        if ln.startswith('|') and not ln.startswith('|--') and not ln.startswith('|------'):
            last_table_row = j
        if j > i and (ln.startswith('##') or ln.strip() == '---'):
            break
        j += 1
    insert_at = last_table_row + 1
    return all_lines[:insert_at] + [row] + all_lines[insert_at:], True


# Substitute __DATE__ placeholder. Plain strings used above so braces in
# row text don't get f-string-parsed; same pattern as log-obsidian-phase-3.py.
BUILD_ROWS = [r.replace('__DATE__', DATE) for r in BUILD_ROWS]
ERROR_ROWS = [r.replace('__DATE__', DATE) for r in ERROR_ROWS]

inserted_build = 0
for row in BUILD_ROWS:
    lines, ok = ensure_row(lines, row, '## Build Log')
    if ok:
        inserted_build += 1

inserted_err = 0
for row in ERROR_ROWS:
    lines, ok = ensure_row(lines, row, '## Error Log')
    if ok:
        inserted_err += 1

# Dedupe: collapse exact-duplicate today-rows from prior reruns.
seen = {}
out = []
removed = 0
for ln in lines:
    if ln.startswith(f'| {DATE} |'):
        if seen.get(ln):
            removed += 1
            continue
        seen[ln] = True
    out.append(ln)

if inserted_build or inserted_err or removed:
    path.write_text('\n'.join(out))
    print(f'build-log: +{inserted_build} row(s)')
    print(f'error-log: +{inserted_err} row(s)')
    print(f'duplicates removed: {removed}')
else:
    print('no changes needed — everything already in place')
print('Obsidian:', path)
