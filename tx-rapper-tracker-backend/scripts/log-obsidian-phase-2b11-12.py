#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phases 2b.11 and 2b.12.

Adds Build Log + Error Log rows for today's work and collapses any
exact-duplicate error-log rows from prior reruns. Safe to run multiple
times - uses an exact-line sentinel match.
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

# -- rows to ensure present ---------------------------------------------------
BUILD_ROWS = [
    # Phase 2b.11 — compare mode / detail-compare / freshness badge / mobile / GitHub
    '| 2026-04-24 | Claude (Cowork) | Phase 2b.11 — compare mode (pick up to 5, overlay via Promise.all over /api/stats/history) + detail-page "Add to compare" toggle + freshness badge (color-coded fresh/stale/dead bound to /api/stats/freshness) + mobile polish @media (max-width:600px) covering header/search/cards/detail-header/compareBar + first GitHub push (SSH key enrolled under sudo mode, remote set to git@github.com:cb2market2290-stack/tx-rapper-tracker.git, commit e87b060 on main) | app.html, src/routes/stats.js, scripts/install-launchd-snapshot.sh | 0 |',
    # Phase 2b.12 — scheduler actually running + backfill commit
    '| 2026-04-24 | Claude (Cowork) | Phase 2b.12 — snapshot cron made real: launchd agent com.txrappertracker.snapshot (~/Library/LaunchAgents/, StartCalendarInterval Hour=4 Minute=0, absolute node path resolved via nvm-aware fallback, logs /tmp/snapshot-stats.{out,err}.log). Kick-ran green (6/6 ok), artist_stats_daily now has a 2026-04-24 row per artist. Follow-on commit 5056524 pushed to origin/main | scripts/install-launchd-snapshot.sh, scripts/dedupe-obsidian-phase-2b10.py, scripts/save-progress.sh, src/routes/stats.js | 0 |',
]

ERROR_ROWS = [
    '| 2026-04-24 | app.html | Compare mode live-verify via tunnel — 2 artists overlaid, Y-axis "Subscribers", values 7.36M + 2.4M, legend toggles datasets | Pass |',
    '| 2026-04-24 | app.html | Detail-page + Add to compare toggle — click flips text/class, second click removes, nav to other artist re-populates data-arg | Pass |',
    '| 2026-04-24 | backend | /api/stats/freshness live — {latestDay:"2026-04-19", hoursSinceLatest:133.5, artistsOnLatest:6, totalArtistsTracked:6} | Surfaced red "dead" badge — useful signal (cron was not actually scheduled) |',
    '| 2026-04-24 | backend | Snapshot-cron diagnosis — crontab empty, no launchd agent for tx/snapshot; Apr 19 04:42 error-run in snapshot_runs was orphaned, no retries after | Root cause: task #43 "schedule daily snapshot" was marked complete but never wired |',
    '| 2026-04-24 | backend | Fix: install-launchd-snapshot.sh installs & loads com.txrappertracker.snapshot plist; manual kick via `launchctl start` captured 6/6 artists, stderr empty, snapshot_runs row status=ok | Pass |',
    '| 2026-04-24 | backend | First GitHub push — HTTPS blocked (no PAT), switched remote to SSH; key rejected until enrolled via GitHub settings/ssh/new (sudo-mode email verify required); after enroll ssh -T returned "Hi cb2market2290-stack!" and git push -u origin main succeeded (e87b060 → main) | Pass |',
]

# -- Build Log insertion ------------------------------------------------------
# Append to the Build Log section, before the next `---` after the table.
# We find the table by locating its header, then inserting each new row
# immediately before the first blank line / `---` / `##` that follows the
# last existing `| 2026-` row.

def ensure_row(all_lines, row, section_header):
    """Insert `row` into the markdown table under `section_header` if not
    already present as an exact line. Returns (new_lines, inserted_bool)."""
    if row in all_lines:
        return all_lines, False
    # Find the section header
    try:
        i = all_lines.index(section_header)
    except ValueError:
        # Section not found — append at end, no-op for safety
        return all_lines, False
    # Walk forward to the end of the table (last `|` line that isn't a separator)
    j = i
    last_table_row = i
    while j < len(all_lines):
        ln = all_lines[j]
        if ln.startswith('|') and not ln.startswith('|--') and not ln.startswith('|------'):
            last_table_row = j
        # Stop at the next section or horizontal rule after we've seen the header row
        if j > i and (ln.startswith('##') or ln.strip() == '---'):
            break
        j += 1
    insert_at = last_table_row + 1
    new_lines = all_lines[:insert_at] + [row] + all_lines[insert_at:]
    return new_lines, True


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

# -- Dedupe: collapse consecutive exact-duplicate 2026-04-24 rows -------------
seen = {}
out = []
removed = 0
for ln in lines:
    is_today = ln.startswith('| 2026-04-24 |')
    if is_today:
        key = ln
        if seen.get(key):
            removed += 1
            continue
        seen[key] = True
    out.append(ln)

if inserted_build or inserted_err or removed:
    path.write_text('\n'.join(out))
    print(f'build-log: +{inserted_build} row(s)')
    print(f'error-log: +{inserted_err} row(s)')
    print(f'duplicates removed: {removed}')
else:
    print('no changes needed - everything already in place')
print('Obsidian:', path)
