#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phase 3a + Phase 3b.

Backfills the Build Log + Error Log rows for the entire Phase 3a chain
(breakout signals + saved-search alerts + frontend) and the Phase 3b
chain (AI artist briefs Premium-only with Claude). Phase 2e left
Obsidian current through the Phase 3 brainstorm doc; this script picks
up from there.

  * 3a.1 — breakout signals + dashboard movers strip
  * 3a.2 — saved searches CRUD + tier caps
  * 3a.3 — email alerts evaluator + mailer
  * 3a.4 — Phase 3a live-verify + migration-013 fix
  * 3a.5 — saved-searches frontend (alerts modal + auth-widget button)

  * 3b.1 — design + Claude prompt lock-in
  * 3b.2 — artist_briefs cache table
  * 3b.3 — services/briefs.js + Claude SDK client + 29 unit tests
  * 3b.4 — GET /api/artists/:id/brief route + Premium gate
  * 3b.5 — artist detail page brief surface + curl smoke

Adds Build Log + Error Log rows and collapses any exact-duplicate
today-rows from prior reruns. Safe to run multiple times — uses an
exact-line sentinel match.

Run:
    python3 scripts/log-obsidian-phase-3.py
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

# Date used for every row. Phase 3a.1-3a.5 + 3b.1-3b.5 all landed
# across a contiguous "no stopping" run — using the same date keeps the
# Build Log readable (one block per major phase, like 2e did).
DATE = '2026-04-28'

# ---------------------------------------------------------------------------
# Rows to ensure present.  Each entry is one full markdown table row.
# ---------------------------------------------------------------------------
BUILD_ROWS = [
    # ── Phase 3a — breakout signals + saved-search alerts ────────────────
    '| __DATE__ | Claude (Cowork) | Phase 3a.1 — Breakout signals + dashboard movers strip: migrations/013_breakout_signals.sql adds a materialized view (one row per active artist) joining artist_stats_daily into 7-day + 14-day windows so view_growth_7d, pct_growth_7d, and acceleration_7d (the 7d delta of the 7d delta) fall out of one SELECT instead of being recomputed per request; has_full_window flag distinguishes 14-day-windowed rows from newly-rostered artists with NULL velocity. src/services/breakout.js exports refreshBreakoutSignals (REFRESH MATERIALIZED VIEW called from the snapshot cron), getTopMovers({limit, sortBy, includePartial}) with the SORT_CLAUSES lookup keyed to {growth, percentage, acceleration} + shapeRow snake→camelCase, getAllSignals for admin/debug. src/routes/insights.js mounts GET /api/insights/breakout with a zod BreakoutQuery schema (defaults limit=5 sortBy=growth includePartial=false; bounds limit∈[1,50]; enum-locked sortBy). Frontend (app.html) adds a Movers strip above the artist grid with three sort tabs (data-action="movers-sort" data-arg=<sort>) and per-card click-through (data-action="mover-open") that focuses the artist by name. test/breakout.test.js + test/insights.test.js cover the pure surface (limit bounds, sortBy enum, BIGINT-as-string from node-postgres on lifetime_views, BreakoutQuery defaults + coercion). | migrations/013_breakout_signals.sql, src/services/breakout.js, src/routes/insights.js, test/breakout.test.js, ../tx-rapper-tracker/app.html | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3a.2 — Saved searches CRUD + tier-capped quota: migrations/014_saved_searches.sql adds a saved_searches table with one row per (predicate, threshold) — name TEXT 1-80 chars, metric ∈ {view_growth_7d, pct_growth_7d, acceleration_7d, lifetime_views} (CHECK matches breakout_signals matview cols + raw lifetime passthrough), threshold DOUBLE PRECISION, comparator ∈ {>, >=, <, <=}, optional artist_id (ON DELETE SET NULL so archiving an artist unscopes the alert instead of deleting it), enabled BOOLEAN, last_alerted_at + last_match_artist_id + last_match_value cron breadcrumbs, partial index on enabled rows for the evaluator hot path, btree on (user_id, id) for ownership checks, autotouch trigger on updated_at. src/services/savedsearches.js exports listForUser/getByIdForUser/create/update/delete with TIER_CAPS enforced in JS against active_user_plan (Free=1, Pro=5, Premium=∞) — DB enforces shape, app layer enforces "how many at this tier" so changing caps is a code-deploy not a migration. Threshold sanity rejects pct outside [-1, 100] and negative view counts. src/routes/saved-searches.js mounts GET (returns kind:savedsearches.list with planSlug/cap/count/atCap/rows), GET /:id, POST (201 created or 403 tier_cap), PATCH /:id, DELETE /:id (200 or 404 — owner-scoped not_found doesn\'t leak existence). 41/41 hermetic schema tests in test/savedsearches.test.js + scripts/test-saved-searches.sh smoke. | migrations/014_saved_searches.sql, src/services/savedsearches.js, src/routes/saved-searches.js, test/savedsearches.test.js, scripts/test-saved-searches.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3a.3 — Email alerts evaluator + mailer: src/services/savedsearch-evaluator.js drains every enabled saved_searches row, joins against breakout_signals (or raw lifetime_views for that metric), applies the comparator, and on match sends one email via the existing Phase 2b pluggable mailer (ConsoleMailer dev / Resend prod). 24h cooling-off via last_alerted_at — re-firing same rule within the window is a no-op. metricColumn maps alert metrics to matview columns; applyComparator + shouldAlert are pure (testable without the DB); humanizeMetric / humanizeComparator / formatValueForMetric build the human email body. Wired into scripts/snapshot-stats.js so the cron does (snapshot → REFRESH MATERIALIZED VIEW → evaluate alerts) atomically — one job, three steps. test/savedsearch-evaluator.test.js +26 covering metricColumn, applyComparator, shouldAlert (cooling-off, disabled, missing-window), humanize helpers, formatValueForMetric, buildEmailPayload. scripts/test-saved-search-eval.sh end-to-end smoke (signs up user → creates rule → seeds breakout row → runs evaluator → asserts last_alerted_at populated + email file written + second invocation cooled off). | src/services/savedsearch-evaluator.js, scripts/snapshot-stats.js, test/savedsearch-evaluator.test.js, scripts/test-saved-search-eval.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3a.4 — Live-verify pass closing Phase 3a end-to-end: applied migrations 013 + 014 to live Postgres, restarted backend (PID 19683), ran 41/41 saved-searches CRUD smoke + 14/14 evaluator smoke + spot-check on /api/insights/breakout (Megan 39M / GloRilla 19M / KenTheMan 2.2M with includePartial=true; defaults to has_full_window-only which is empty until day 14). Two fixes uncovered while live-verifying: (1) migrations/013_breakout_signals.sql had `(as_of - first_snapshot) >= INTERVAL \'14 days\'`; both columns are DATE and date - date in Postgres yields integer days not interval, so applying on a populated DB threw "operator does not exist: integer >= interval" — fix compares against integer literal 14. Behavior unchanged on empty DB (CTE returns zero rows so the expression never evaluated) which is why 3a.1 unit tests didn\'t catch it. (2) scripts/test-saved-search-eval.sh\'s four inline `node -e` Node bridges were emitting pino logs to stdout interleaved with JSON.stringify of the orchestrator return — python\'s json.load(file) reads only the first JSON document, which was a pino log, so evaluated/fired came back as 0 even when the alert fired correctly. Prefixing each bridge with LOG_LEVEL=silent silences pino so stdout contains only the JSON we want to parse; smoke now runs 14/14 PASS. scripts/quick-movers-check.sh added as a one-shot inspector (sign up + hit /api/insights/breakout?sortBy={growth,percentage,acceleration}) for visual eyeballing — not part of the test suite. | migrations/013_breakout_signals.sql, scripts/test-saved-search-eval.sh, scripts/quick-movers-check.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3a.5 — Saved-searches frontend (alerts modal + auth-widget button): closes Phase 3a end-to-end. Until this, saved_searches CRUD (3a.2) and the email evaluator (3a.3) were real but the only way to create an alert was curl. Frontend changes (single-file app.html, no build step): new btnAlerts ("Alerts") button in the auth widget header that mirrors btnSecurity\'s signed-in/out lifecycle in renderAuthWidget; #alertsOverlay modal with two views toggled by id (alertsViewList = pill-style "Free plan / 1 of 1 alerts" summary + list rows with Enable/Disable + Edit + Delete + a "+ New alert" button + cap nudge linking to /upgrade when at-cap on non-Premium; alertsViewForm = name + metric (4 options) + comparator (4) + threshold + scope dropdown of roster artists + enabled checkbox, doubles as create POST + edit PATCH); 8 new dispatcher cases (alerts-open, alerts-close, alerts-overlay-bg, alerts-new, alerts-edit, alerts-delete, alerts-toggle, alerts-cancel-edit) wired into the body-level [data-action] switch; ~350 lines of JS (alertsState global + openAlerts/closeAlerts/refreshAlertsList/renderAlertsSummary/renderAlertsList/startNewAlert/startEditAlert/submitAlertForm/deleteAlertRow/toggleAlertEnabled/fetchArtistsForScope; submitAlertForm handles POST + PATCH and surfaces 403 tier_cap as inline "Upgrade for more"); ~45 lines of CSS scoped under .auth-modal (.al-summary/.pill/.al-list/.al-row + flex-wrap so the row collapses cleanly on mobile/.al-actions/.al-form-toggle/auth-modal select). artistName resolved frontend-side from the artistData cache by row.artistId (the service only carries artistId; falling back to a truncated id when the artist was archived after the alert was saved, instead of mis-displaying as "any artist"). | ../tx-rapper-tracker/app.html, scripts/save-progress-3a5.sh | 0 |',

    # ── Phase 3b — AI artist briefs (Premium-only, Claude-generated) ─────
    '| __DATE__ | Claude (Cowork) | Phase 3b.1 — Design + Claude prompt lock-in (PHASE_3B_DESIGN.md): locks the spec for the Premium-only AI artist briefs feature before writing code. Surface: GET /api/artists/:id/brief gated by requirePaid({minTier:premium}). Inputs are deliberately bounded — artist name, last 14 daily snapshots ({d, v, s} compact keys), the breakout_signals row, features aggregate (no per-track rows). Cache key fingerprint = sha256({artist_id, latest_snapshot_at (DATE: MAX(captured_on) from artist_stats_daily), latest_features_extracted_at (TIMESTAMPTZ: MAX(extracted_at) from track_features), prompt_version, model}); breakout_signals NOT in the key because the matview is downstream of latest_snapshot_at (adding it would cause spurious misses). prompt_version=v1 for this commit; bumping invalidates every cached row in one move. Model claude-haiku-4-5-20251001 (env-overridable; cache key folds in model so a swap regenerates cleanly). Temperature 0.3; max_tokens 320; output shaping rejects + retries once at temperature 0.1 if word count <50 or >180 or contains markdown bullets/numbered lists/headers/code fences/URLs. Locked v1 system + user prompts reproduced verbatim. Frontend posture (3b.5): one card on the artist detail page; Free/Pro see the existing 402 upgrade-card pattern; no manual Refresh button (cache invalidation drives regeneration so users can\'t burn API credits on unchanged inputs). Open questions from the Phase 3 brainstorm explicitly closed: prompt locked, cache key locked, Haiku 4.5, non-streaming, no manual refresh. Explicitly deferred: streaming, thumbs feedback, digest emails (= Phase 3d), TikTok/Spotify (= Phase 4). | PHASE_3B_DESIGN.md, scripts/save-progress-3b1.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3b.2 — artist_briefs cache table: migrations/015_artist_briefs.sql adds a single table with UNIQUE (artist_id, fingerprint) constraint that doubles as the cache-key lookup index. Stores brief TEXT (CHECK length>0), prompt_version + model (so a bump rolls the cache cleanly), tokens_in/tokens_out billing telemetry (nullable so old rows from before we tracked tokens stay valid), generated_at TIMESTAMPTZ, fingerprint TEXT (CHECK length=64 for sha256 hex). artist_id has ON DELETE CASCADE so archiving an artist drops their cached briefs. Plus an artist_briefs_artist_recent_idx (artist_id, generated_at DESC) for the rare admin/debug "show me the latest brief regardless of cache key" query. PHASE_3B_DESIGN.md updated to fix two stale references after reading the actual schema: latest_snapshot_at is a DATE (MAX(captured_on)) not a bigint id (artist_stats_daily is keyed (artist_name, captured_on) with no surrogate id), and the Cache table section now points at the migration as canonical schema rather than reproducing inline. | migrations/015_artist_briefs.sql, PHASE_3B_DESIGN.md, scripts/save-progress-3b2.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3b.3 — services/briefs.js + Claude SDK client + 29 unit tests: pure surface — PROMPT_VERSION/DEFAULT_MODEL/MAX_TOKENS/TEMPERATURE/RETRY_TEMPERATURE locked constants; locked v1 SYSTEM_PROMPT embedded verbatim from PHASE_3B_DESIGN.md; keyInputs(...) normalizes cache-key inputs (DATE→YYYY-MM-DD, TIMESTAMPTZ→ISO); canonicalize(value) recursive JSON serializer that sorts object keys at every level (defends against JS engine ordering quirks leaking into fingerprint); fingerprint(inputs) = sha256 hex of canonicalize(keyInputs(...)) (64 chars matches CHECK on artist_briefs.fingerprint); stripNulls(value) drops null/undefined keys recursively (preserves zero/false/empty string + array nulls); buildUserMessage({...}) assembles the user-message JSON Claude sees (no DB; takes already-fetched inputs); evaluateBrief(s) returns {ok, reason} (reasons: too_short, too_long, forbidden_pattern); wordCount(s) trim-aware split. I/O surface — getAnthropic() lazy-init dynamic-import (@anthropic-ai/sdk optional in dev, throws on cache-miss generation when ANTHROPIC_API_KEY unset, never crashes at module load — same posture as services/stripe.js); callClaude({userMessage, model, temperature, signal}) accepts AbortSignal for the 25s timeout; readCache + writeCache (INSERT...ON CONFLICT DO NOTHING for race-safe writes); getOrGenerateBrief(artistId, opts) read-through entry point throwing artist_not_found / insufficient_data / briefs_unconfigured as Error.code values. Retry orchestration: first call at 0.3, evaluate, retry once at 0.1 if shape fails; if both fail pick whichever is windowed and surface shapingDegraded:true. Hard upper trim at 180 words at sentence boundary if the model massively overshoots. _generateForTests(...) test seam takes a fakeClaude callback. New config.briefs block (apiKey/model/timeoutMs/enabled) + redacted() handling + 3 .env.example vars. test/briefs.test.js +29 (fingerprint determinism + sensitivity to all 5 input fields, null/undefined latestFeaturesExtractedAt collapsed, keyInputs date normalization, canonicalize key-order stability + nested + primitives, evaluateBrief 8 cases incl. all forbidden patterns, wordCount edges, stripNulls preserves falsy + array nulls, buildUserMessage handles missing breakout/features + drops nulls but keeps false, _generateForTests retry orchestration). 29/29 PASS; pre-existing breakout/savedsearches/savedsearch-evaluator/auth/features/stripe still PASS. SDK intentionally NOT in package.json — dynamic-import means the module is installable without an Anthropic account configured; production envs run npm install @anthropic-ai/sdk separately, same as the optional `stripe` package. | src/services/briefs.js, src/config.js, .env.example, test/briefs.test.js, scripts/save-progress-3b3.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3b.4 — GET /api/artists/:id/brief route + Premium gate: wires services/briefs.js (3b.3) to a real route mounted under the existing /api/artists router (so its requireUser() applies); the route adds requirePaid({minTier:premium}) so Free + Pro users get the standard 402 dispatch the frontend already handles. Status mapping locked: 200+brief on cache hit OR fresh generation, 200+briefs.no_data+brief:\'\' when artist has zero snapshots (friendly empty-state, no Claude burn — we don\'t ship a hallucinated paragraph against missing data), 402 for Free/Pro user, 404 for missing/archived artist, 503 briefs_unconfigured on cache miss + ANTHROPIC_API_KEY unset, 504 briefs_timeout when Claude > config.briefs.timeoutMs (default 25s), 502 briefs_upstream on 429/5xx/529 from Anthropic. The 25s timeout is enforced via an AbortController whose signal threads from the route into services/briefs.js#callClaude — without this the SDK connection would linger past the 504 we send back, doubling the perceived latency on retry. Error mapping by err.code (set by service module) plus a defensive AbortError catch for forward-compat with whichever exact shape the Anthropic SDK rethrows on cancellation. Response shape on 200 includes cacheHit + tokensIn/Out so an admin can eyeball "what is this feature costing me this month" without parsing logs, and shapingDegraded so the frontend can render a small note when both the first call and the retry-at-0.1 failed evaluation. Verified the briefs.test.js unit suite still passes 29/29 + the route module imports cleanly. | src/routes/artists.js, scripts/save-progress-3b4.sh | 0 |',

    '| __DATE__ | Claude (Cowork) | Phase 3b.5 — Artist detail page brief surface + curl smoke (closes Phase 3b end-to-end): new <div class="detail-panel" id="detailBriefPanel"> in app.html inserted above the audio-features panel, same demo-mode hide rule as #detailFeaturesPanel (briefPanel.style.display=\'none\' when a.id is null since /api/artists/:id/brief is UUID-keyed). CSS adds .brief-text (paragraph block, white-space:pre-wrap), .brief-meta (small caption "Generated 2h ago · claude-haiku-4-5 · cached" with thin-dot separators), .brief-degraded (warning amber for shapingDegraded:true), .brief-badge (Premium pill next to panel header), .brief-empty + .brief-error. renderArtistBrief(a) parallel to renderArtistFeatures hits /api/artists/:id/brief and dispatches on response shape + HTTP status: 200+brief→render paragraph + meta row, 200+briefs.no_data→"No snapshots yet" empty state, 402→reuse renderFeatureGate with brief-specific body copy ("Unlock AI briefs with Premium"), 503→"AI briefs aren\'t configured on this server" pointing at the env var, 504→"Refresh to try again", 502→"Anthropic upstream error", other/network→"Couldn\'t load the brief". fmtBriefRelative() small inline X-min/h/days-ago formatter; model display strips dated suffix (-20251001) so users see "claude-haiku-4-5" not the full pin. scripts/test-briefs.sh smoke — 5 subtests reachable without a real Stripe + Anthropic setup: anonymous→401, signup→201, signed-in non-UUID→400-or-402, signed-in unknown UUID→402-or-404, signed-in real artist→402+kind=payments.required+minTier=premium. The 200 fresh-gen, cacheHit:true second call, and 503 briefs_unconfigured paths are documented as manual-verify (need ANTHROPIC_API_KEY + a real Premium subscription on the test user). Inline JS in app.html still parses cleanly (single 132KB script block); 29/29 briefs.test.js still PASS. | ../tx-rapper-tracker/app.html, scripts/test-briefs.sh, scripts/save-progress-3b5.sh | 0 |',
]

ERROR_ROWS = [
    # Phase 3a.4 fixes
    '| __DATE__ | backend | migrations/013_breakout_signals.sql had `(as_of - first_snapshot) >= INTERVAL \'14 days\'` for the has_full_window flag. Both columns are DATE; in Postgres date - date returns INTEGER days, not INTERVAL, so applying the migration to a populated DB threw `operator does not exist: integer >= interval`. Fix compares against integer literal 14. Behavior unchanged on empty DB (the points CTE returns zero rows so the offending expression is never evaluated) — which is exactly why our 3a.1 hermetic unit tests didn\'t catch it. Lesson: if a CHECK / WHERE expression is only reached when rows exist, the test fixture needs at least one row. | Pass — 3a.4 fix shipped |',
    '| __DATE__ | backend | scripts/test-saved-search-eval.sh\'s four inline `node -e` Node bridges were emitting pino logs to stdout interleaved with JSON.stringify(out). python3\'s json.load(file) reads only the first JSON document — which in our smoke happened to be a pino log line, so `evaluated`/`fired` came back as 0 even when the alert fired correctly (last_alerted_at WAS being written; ConsoleMailer WAS writing /tmp/last-reset-email.txt). Fix: prefix each bridge with LOG_LEVEL=silent so pino stays quiet and stdout contains only the JSON we want to parse. After the fix the smoke runs 14/14 PASS. | Pass — fix in tree |',

    # Phase 3a.5 frontend posture
    '| __DATE__ | frontend | Service module returns saved-search rows with artistId only (no artistName JOIN). Frontend resolves the name from the already-loaded artistData roster cache by row.artistId. If the artist was archived after the alert was saved, fall back to a truncated UUID prefix instead of mis-displaying as "any artist" (which would mean a different scope). Decision was: don\'t change the service to JOIN — frontend already has the data, JOIN cost would compound on every list call. | Pass — design choice, not bug |',

    # Phase 3b.2 design correction
    '| __DATE__ | backend | PHASE_3B_DESIGN.md initially specified `latest_snapshot_id: bigint` as the cache-key snapshot freshness signal. After reading the actual migrations/004_artist_stats_daily.sql schema, artist_stats_daily is keyed (artist_name, captured_on) with no surrogate id — there is no bigint to fold into the key. Corrected the design doc + migration 015 to use latest_snapshot_at: DATE (= MAX(captured_on)), which has the same semantic role (advances exactly once per artist per day, only when the snapshot cron writes new data). | Pass — caught in 3b.2 review |',

    # Phase 3b.3 SDK posture
    '| __DATE__ | backend | @anthropic-ai/sdk intentionally NOT added to package.json dependencies. Pattern matches the existing optional `stripe` package: dynamic-import in services/briefs.js (getAnthropic), throws "Anthropic SDK not installed" on cache-miss generation when the module isn\'t present, never crashes at module load. Lets the test suite + the rest of the API run fine without an Anthropic account configured. Production envs that enable briefs run `npm install @anthropic-ai/sdk` separately. | Pass — design posture, documented in commit |',

    # Phase 3b.3 osascript shell quirk
    '| __DATE__ | infra | Running `npm test` from osascript do-shell-script context fails with "npm: command not found" because the AppleScript-spawned shell is non-login and node/npm aren\'t on PATH. Workaround used during 3b.3 verify: `/bin/bash -lc \'cd ... && node --test test/*.test.js | tail -N\'` (login bash sources zshrc/.nvm). Multi-line AppleScript do-shell-script with embedded redirect chains additionally fights with quoting; mitigated by writing the smoke output to a file via a thin wrapper script (scripts/_run-tests-to-file.sh). | Pass — workaround codified |',

    # Phase 3b.4 timeout enforcement
    '| __DATE__ | backend | Initial sketch had the 25s timeout living in services/briefs.js. Moved to the route layer because the Express request is the right abort scope — the AbortController\'s signal threads from the route into callClaude so when we 504 the in-flight Claude request is canceled. Without this, the SDK connection would linger past the response we send the client, doubling perceived latency on retry. | Pass — design, documented in route |',
]


# ---------------------------------------------------------------------------
# Insertion helper — same shape as log-obsidian-phase-2e.py
# ---------------------------------------------------------------------------
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


# Substitute __DATE__ placeholder. We use plain strings (not f-strings)
# above to keep braces in the row text — like {limit, sortBy, ...} —
# from being interpreted as f-string expressions.
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

# ---------------------------------------------------------------------------
# Dedupe: collapse exact-duplicate today-rows (safe across reruns)
# ---------------------------------------------------------------------------
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
