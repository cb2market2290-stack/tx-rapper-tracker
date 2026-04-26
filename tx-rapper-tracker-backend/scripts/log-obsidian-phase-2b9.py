#!/usr/bin/env python3
"""Idempotent append of Phase 2b.9 rows (ranking + Postgres cache + real chart
+ trends removal + daily schedule) to Build Log + Error Log."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()

# ---- Build Log -----------------------------------------------------------
build_anchor_marker = '| 2026-04-18 | Claude (Cowork) | Phase 2b.8'
if build_anchor_marker not in text:
    raise SystemExit('build-log anchor for 2b.8 not found - aborting')

if '| Phase 2b.9 \u2014' in text:
    print('2b.9 build-log row already present - no change')
else:
    lines = text.split('\n')
    # Anchor on the last line that starts with the 2b.8 marker so reruns
    # don't drift the insert point.
    idx = None
    for i, ln in enumerate(lines):
        if ln.startswith(build_anchor_marker):
            idx = i
    if idx is None:
        raise SystemExit('could not locate Phase 2b.8 line')
    new_line = (
        '| 2026-04-18 | Claude (Cowork) | Phase 2b.9 \u2014 ranking math '
        '(log-scaled score, separate lifetime vs recent views) + persistent '
        'Postgres L2 cache (migrations/003 + cache.js rewrite, in-flight '
        'collapsing) + real 12-month chart (migrations/004 + '
        'snapshot-stats.js + routes/stats.js + async renderTrendsChart with '
        'synthetic fallback) + Trends route removed (dead code, upstream 429) '
        '+ daily 04:00 cron via Cowork schedule | app.html, cache.js, '
        '003_cache.sql, 004_artist_stats_daily.sql, snapshot-stats.js, '
        'stats.js, index.js, config.js, README.md, DEPLOY.md, .env.example, '
        '.env.production.example | 0 |'
    )
    lines.insert(idx + 1, new_line)
    text = '\n'.join(lines)
    print('2b.9 build-log row inserted after line', idx + 1)

# ---- Error Log -----------------------------------------------------------
err_anchor = (
    '| 2026-04-18 | admin.html | live UI via tunnel \u2014 Disable flips '
    'pill+button, Enable flips back, Revoke drops session row (21\u219220) '
    '+ audit event, self-disable alerts 400 | All green |'
)
if err_anchor not in text:
    raise SystemExit('error-log anchor not found (expected 2b.8 admin.html row)')

err_signature = 'snapshot-stats.js manual run \u2014 6/6 artists captured'
if err_signature in text:
    print('2b.9 error-log rows already present - no change')
else:
    err_rows = [
        '| 2026-04-18 | backend | snapshot-stats.js manual run \u2014 6/6 '
        'artists captured (Megan 7.36M/3.87B, GloRilla 2.4M/1.9B, Asian Doll '
        '488K, Tay Money 320K, Cuban Doll 229K, KenTheMan 198K) | 6/6 ok |',
        '| 2026-04-18 | backend | /api/stats/history live verify via Chrome '
        'tunnel \u2014 200 with 1 row, day=2026-04-18 | Pass |',
        '| 2026-04-18 | app.html | renderTrendsChart real-data path \u2014 '
        'Y-axis "Subscribers", 4 datasets, values 7.36M/2.4M/488K/198K | Pass |',
        '| 2026-04-18 | backend | /api/trends/interest audit \u2014 upstream '
        'returned 429 (bot-block); zero frontend callers | Removed in 2b.9 |',
        '| 2026-04-18 | backend | /api/trends/interest after removal \u2014 '
        'curl returns 404, /api/stats/history 401, /api/youtube/search 401 | All correct |',
        '| 2026-04-18 | cowork-schedule | snapshot-rapper-stats-daily '
        'registered, cron "0 4 * * *", next run 2026-04-19 04:05 local | Active |',
    ]
    new_block = err_anchor + '\n' + '\n'.join(err_rows)
    text = text.replace(err_anchor, new_block, 1)
    print('2b.9 error-log rows inserted:', len(err_rows))

path.write_text(text)
print('Obsidian updated:', path)
