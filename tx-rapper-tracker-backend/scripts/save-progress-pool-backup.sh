#!/usr/bin/env bash
# Stage + commit the Postgres pool bump + daily backup script + the
# launchd installer for the backup. Two small wins shipped together.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/db/pool.js \
  tx-rapper-tracker-backend/scripts/backup-postgres.sh \
  tx-rapper-tracker-backend/scripts/install-launchd-backup.sh \
  tx-rapper-tracker-backend/scripts/save-progress-pool-backup.sh

git commit -m "Postgres pool bump + daily backup script + launchd installer

Two small defensive wins. F (live testing pass, 55/55 PASS across
test-public-pages + test-digest + test-referrals) confirmed nothing
broke; E1 + E2 below are the polish items I recommended.

* src/db/pool.js — pool max bumped 10 -> 30. Comment expanded to
  document the headroom math: 30 used by app + ~70 left for psql /
  audio-extract worker / ad-hoc tools against the default
  max_connections=100.

* scripts/backup-postgres.sh — daily pg_dump | gzip to
  ~/backups/tx-YYYYMMDD-HHMM.sql.gz with 14-day retention. Pulls
  DATABASE_URL from .env via grep + cut (NOT set -a + source — .env
  can have values with shell-meta chars that break sourcing). Verifies
  output is at least 10KB to catch silent-empty-dump failures. Verified
  live: 25KB backup written cleanly.

* scripts/install-launchd-backup.sh — installs
  com.txrappertracker.backup as a daily 03:30-local LaunchAgent.
  Same shape as install-launchd-backend.sh / install-launchd-extract.sh.
  StartCalendarInterval Hour=3 Minute=30. Output to
  /tmp/tx-backup.out.log; trigger now via launchctl kickstart -k.

Restore recipe (in the script header comment):
  gunzip < ~/backups/tx-YYYYMMDD-HHMM.sql.gz | psql tx_rapper_tracker_dev

To activate the daily schedule:
  bash scripts/install-launchd-backup.sh

Skipped this session for budget: E3 (Ollama swap-in for AI briefs).
Tackle that in a fresh session — it is a roughly 1-hour change
across services/briefs.js + config.js + a flag for BRIEFS_PROVIDER.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
