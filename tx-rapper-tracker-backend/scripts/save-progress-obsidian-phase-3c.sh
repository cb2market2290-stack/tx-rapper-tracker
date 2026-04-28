#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled Phase 3c + the
# Phase 3.5 design + 3.5.1 rows. The vault file itself lives outside
# the repo (~/Documents/Obsidian Vault/) so we don't commit it; we
# commit the idempotent script that produced the rows so the work is
# reproducible from the repo alone.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3c.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3c.sh

git commit -m "Phase 3 docs: log-obsidian-phase-3c.py — Build Log backfill 3c + 3.5

Picks up where log-obsidian-phase-3.py left off. Adds 7 Build Log
rows + 4 Error Log rows for Phase 3c (closed end-to-end) and the
start of Phase 3.5 (design + first item).

* scripts/log-obsidian-phase-3c.py
  Same idempotent shape as log-obsidian-phase-3.py: BUILD_ROWS /
  ERROR_ROWS literals with __DATE__ placeholder substituted via
  .replace() at runtime (plain strings, NOT f-strings — keeps
  braces in row text from being parsed as f-string expressions),
  ensure_row inserts under '## Build Log' or '## Error Log' only
  on miss, dedupe pass at the end. Safe to re-run.

  7 BUILD_ROWS:
    Phase 3c.1 — design + decisions
    Phase 3c.2 — migration 016 (slug + is_public)
    Phase 3c.3 — services/slugs.js + routes/public.js + 16 tests
    Phase 3c.4 — frontend Share buttons + slug plumbing
    Phase 3c.5 — public-pages smoke (closes 3c)
    Phase 3.5 design — hardening pass spec
    Phase 3.5.1 — launchd plist for backend auto-restart

  4 ERROR_ROWS for genuinely-noteworthy issues:
    * f-string {...} parse error in log-obsidian-phase-3.py (the
      original logger broke when row text contained literal braces
      like {limit, sortBy, includePartial}); fix is the plain-strings
      + __DATE__ pattern used here too
    * osascript do-shell-script + npm test gotcha (non-login shell,
      no node on PATH, multi-line quoting fights — workaround uses
      /bin/bash -lc + thin wrapper scripts)
    * Frontend Share buttons hide when any picked artist lacks a
      slug (decision: don't ship a URL that 404s on the public route)
    * Postgres slugify covers the actual seed roster's diacritics
      (translate-based) rather than full NFKD; JS slugify handles
      full NFKD. They agree on every existing seed row; documented
      in migration 016's header for any future admin adding a name
      with exotic diacritics.

Run history:
  python3 scripts/log-obsidian-phase-3c.py
  → build-log: +7 row(s)
  → error-log: +4 row(s)
  → duplicates removed: 0

Total Phase 3 entries in the vault now: 5 (3a) + 5 (3b) + 5 (3c) +
2 (3.5 so far). When 3.5.2-3.5.4 + 3d ship, a follow-on logger
(log-obsidian-phase-3-5.py + log-obsidian-phase-3d.py) backfills
those.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
