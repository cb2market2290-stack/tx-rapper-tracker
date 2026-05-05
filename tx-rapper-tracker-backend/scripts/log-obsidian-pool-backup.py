#!/usr/bin/env python3
"""Obsidian backfill for the F (live testing pass) + E1 (Postgres pool
bump) + E2 (daily backup) commit (e96eff4)."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-05-05'

BUILD_ROWS = [
    '| __DATE__ | Claude (Cowork) | Live testing pass + Postgres pool bump + daily backup script. F (live testing pass) — ran scripts/test-public-pages.sh (24/24 PASS), scripts/test-digest.sh (14/14 PASS), scripts/test-referrals.sh (17/17 PASS) — total 55/55 across all three smokes. Backend healthy, all migrations applied (015-018), Cache-Control headers verified live, public + signed-in + anonymous + dedup paths all behaving correctly. E1 (Postgres pool bump) — src/db/pool.js max:10 -> max:30. Headroom math documented in expanded comment: 30 used by app + 70 left for psql + audio-extract worker + ad-hoc tools against default max_connections=100. E2 (daily backup) — scripts/backup-postgres.sh does pg_dump | gzip to ~/backups/tx-YYYYMMDD-HHMM.sql.gz with 14-day retention. Pulls DATABASE_URL from .env via grep + cut rather than set -a + source (env can have shell-meta chars in helmet/CSP/multi-line values that break sourcing). Verifies output >= 10KB to catch silent-empty-dump failures. First run live: 25KB backup written successfully. scripts/install-launchd-backup.sh installs com.txrappertracker.backup as a daily 03:30-local LaunchAgent (StartCalendarInterval Hour=3 Minute=30); same idempotent shape as install-launchd-backend / install-launchd-extract. Restore recipe in script header: gunzip < ~/backups/tx-...sql.gz | psql ... Skipped this session for budget: E3 Ollama swap-in for AI briefs (roughly 1-hour change across services/briefs.js + config.js + BRIEFS_PROVIDER flag; tackle in a fresh session). | src/db/pool.js, scripts/backup-postgres.sh, scripts/install-launchd-backup.sh, scripts/save-progress-pool-backup.sh | 0 |',
]

ERROR_ROWS = [
    '| __DATE__ | infra | scripts/backup-postgres.sh first run failed: set -a + source ../.env hit a syntax error on line 43 of .env (some value contains a shell-meta char like < or > or unquoted spaces). Fix: do not source the .env at all — use grep -E ^DATABASE_URL= + cut -d= -f2- + tr -d quotes to extract just the one variable we need. Pattern: when reading specific values from a file that may contain shell-unsafe content, parse line-by-line; do not source the whole thing. | Pass — fix in tree |',
]


def ensure_row(all_lines, row, section_header):
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
else:
    print('no changes needed')
print('Obsidian:', path)
