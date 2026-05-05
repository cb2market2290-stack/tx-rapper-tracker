#!/usr/bin/env bash
# Daily Postgres backup. pg_dump -> gzip -> ~/backups/tx-YYYYMMDD.sql.gz.
# Last 14 days retained; older files pruned. Idempotent + safe to run
# multiple times the same day (timestamped down to the minute).
#
# Wire into launchd:
#   1. Run: bash scripts/backup-postgres.sh   # confirm it works
#   2. ls ~/backups/ -> see tx-YYYYMMDD-HHMM.sql.gz
#   3. crontab equivalent via launchd:
#      Copy ~/Library/LaunchAgents/com.txrappertracker.backup.plist
#      from the inline template below + launchctl bootstrap.
#
# To restore from a backup:
#   gunzip < ~/backups/tx-20260428-1900.sql.gz | psql tx_rapper_tracker_dev

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

# Pull DATABASE_URL from .env so this script works whether invoked
# from a login shell, a cron, or launchd. We DO NOT source the file —
# .env can contain values with shell-meta characters (helmet/CSP
# directives, multi-line keys, etc.) that break `set -a; source`.
# Instead we grep for the specific line and parse it.
if [[ -z "${DATABASE_URL:-}" ]]; then
  ENV_FILE="$(dirname "$0")/../.env"
  if [[ -f "$ENV_FILE" ]]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    export DATABASE_URL
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL not set (looked for .env)" >&2
  exit 1
fi

# Resolve pg_dump. On homebrew Mac the postgres-formula puts it at
# /usr/local/Cellar/postgresql@16/.../bin/pg_dump or /opt/homebrew/...
# command -v handles either.
PG_DUMP="${PG_DUMP:-$(command -v pg_dump || true)}"
if [[ -z "$PG_DUMP" ]]; then
  echo "error: pg_dump not on PATH (set PG_DUMP=/path or brew install postgresql)" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M)"
OUT="$BACKUP_DIR/tx-$STAMP.sql.gz"

echo "[$(date '+%H:%M:%S')] backing up to $OUT ..."
"$PG_DUMP" "$DATABASE_URL" | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

# Verify the dump isn't empty (pg_dump can succeed with 0 rows on a
# bad URL). We expect at least 10KB even for a tiny schema.
SIZE=$(wc -c < "$OUT" | tr -d ' ')
if (( SIZE < 10240 )); then
  echo "error: backup is suspiciously small ($SIZE bytes)" >&2
  rm -f "$OUT"
  exit 1
fi

echo "[$(date '+%H:%M:%S')] wrote $OUT ($SIZE bytes)"

# Prune old backups. -mtime +N matches files older than N days.
find "$BACKUP_DIR" -name 'tx-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

echo "[$(date '+%H:%M:%S')] retention prune complete (>${RETENTION_DAYS}d)"
ls -lh "$BACKUP_DIR" | tail -5
