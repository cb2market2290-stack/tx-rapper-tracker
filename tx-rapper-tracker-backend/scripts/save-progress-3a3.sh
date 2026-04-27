#!/usr/bin/env bash
# scripts/save-progress-3a3.sh
# One-shot stage + commit for Phase 3a.3 (email-alerts evaluator +
# inline snapshot hook). This is the third sub-phase of the Phase 3a
# triplet — 3a.1 = breakout signals + dashboard movers strip,
# 3a.2 = saved-searches CRUD + tier caps, 3a.3 = the evaluator that
# turns those rows into actual emails on each daily snapshot.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/services/savedsearch-evaluator.js \
  tx-rapper-tracker-backend/scripts/snapshot-stats.js \
  tx-rapper-tracker-backend/test/savedsearch-evaluator.test.js \
  tx-rapper-tracker-backend/scripts/test-saved-search-eval.sh \
  tx-rapper-tracker-backend/scripts/save-progress-3a3.sh

git commit -m "Phase 3a.3: saved-search evaluator + email alerts (inline in snapshot cron)

Closes the loop on Phase 3a — saved-searches rows from 3a.2 + the
breakout_signals matview from 3a.1 → per-user emails when an artist
crosses one of the user's thresholds. Lives inline in
scripts/snapshot-stats.js so there's still exactly one cron, not two.

Backend:
* src/services/savedsearch-evaluator.js — the evaluator service.
  Pure helpers (exported for unit tests):
    - metricColumn() maps the four user-facing metrics to matview
      columns; lifetime_views aliases to views_now (the matview
      surfaces lifetime as 'views_now' to keep the sort indices on
      the delta columns).
    - applyComparator() coerces strings via Number() so node-pg's
      BIGINT-as-string doesn't silently fail; null/NaN both return
      false; throws on unknown op (defense-in-depth — the column is
      already CHECK'd at insert).
    - shouldAlert() encodes the 24h cooling-off cap (never-alerted
      OR last_alerted_at < now - 24h). The same predicate lives in
      the SQL WHERE clause of loadDueSavedSearches; we keep the JS
      copy for tests + readability.
    - humanizeMetric/humanizeComparator/formatValueForMetric build
      the email body. Pct values render as '+5.0%' / '-12.3%' with
      sign; raw values use compact K/M/B integer formatting.
    - buildEmailPayload assembles { to, subject, text, html }. HTML
      branch escapes both savedSearch.name (user-supplied) and
      artist_name (DB-supplied — could contain & in an artist name).
      Empty baseUrl falls back to a relative '/app' link so dev
      smoke without APP_BASE_URL still works.
  DB paths:
    - loadDueSavedSearches() JOINs users for recipient email, filters
      enabled rows where last_alerted_at IS NULL OR < now - 24h.
    - findMatches() interpolates the comparator after re-allowlisting
      it against VALID_COMPARATORS, queries breakout_signals using
      metricColumn, ORDER BY direction inverts for < / <= so
      'cooling-off' alerts surface lowest-first. LIMIT 5 for broad
      (any-artist) searches to bound spam from poorly-set thresholds;
      LIMIT 1 for scoped (artist_id-pinned) searches.
    - recordAlert() bumps last_alerted_at + last_match_artist_id +
      last_match_value (the primary match — the others render in the
      email body but the breadcrumb tracks the loudest one).
  Orchestrator evaluateAllSavedSearches({ now, baseUrl, mailer }):
    - Loads due rows once, then per-row finds matches, builds the
      email payload, sends it, and on success calls recordAlert.
    - On send failure: log warn but DO NOT update last_alerted_at —
      the next cron cycle will retry. Keeps mailer outages from
      silently dropping alerts.
    - On any per-row throw: increment errors counter, continue.
    - Returns { evaluated, fired, errors } for observability.
* scripts/snapshot-stats.js — added the evaluator hook between the
  breakout_signals refresh and the alertOnFailure call. Wrapped in
  try/catch (logger.warn on failure) so an evaluator blowup never
  tanks the snapshot run; the snapshot_runs breadcrumb is already
  written upstream by recordRun(). Reads config.appBaseUrl (the
  same field auth.js uses for password-reset URLs) so dashboard
  links land on the prod host.
* test/savedsearch-evaluator.test.js — 26 unit tests covering every
  pure helper:
    - metricColumn aliasing + unknown-metric throw.
    - applyComparator at boundary for each of >, >=, <, <=, plus
      string-numeric coercion ('1500000' > 1000000), null/NaN false,
      unknown-op throw.
    - shouldAlert at 23h (false), exactly 24h (true), 25h (true),
      and never-alerted (true).
    - humanizeMetric / humanizeComparator labels.
    - formatValueForMetric: pct sign + decimal, K/M/B boundaries,
      negative prefix, n/a on null.
    - buildEmailPayload: scoped vs broad subject lines ('GloRilla
      matched' vs '2 artists matched'), text body sections (rule
      line + match list + dashboard link), trailing-slash baseUrl
      normalization, empty baseUrl falls back to /app, HTML
      escapement of <script> and & in both name and artist_name,
      'is' / 'are' subject pluralization.
* scripts/test-saved-search-eval.sh — live smoke. Signs up a user,
  creates one wide-catching saved search (view_growth_7d > -1 so it
  matches every artist with ≥0 growth), invokes the evaluator
  twice via a Node bridge, and asserts:
    1. First run: evaluated ≥ 1, fired ≥ 1, errors == 0.
    2. last_alerted_at gets populated.
    3. ConsoleMailer wrote /tmp/last-reset-email.txt with the
       saved-search name in the body.
    4. Second run: evaluated == 0 (cooling-off filtered the row
       out), fired == 0, last_alerted_at unchanged.
  If breakout_signals is empty (no snapshots yet) the smoke SKIPs
  the fire-path tests rather than failing — useful on a fresh DB.

Tests: 211/216 pass (5 pre-existing cache.test.js failures, all
DB-connection-required, unchanged from prior runs). +26 new
evaluator unit tests.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
