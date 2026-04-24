#!/usr/bin/env python3
"""Idempotent append of Phase 2b.10 rows (artist detail page + CSP inline-
onclick sweep via data-action dispatcher) to Build Log + Error Log."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()

# ---- Build Log -----------------------------------------------------------
build_anchor_marker = '| 2026-04-18 | Claude (Cowork) | Phase 2b.9'
if build_anchor_marker not in text:
    raise SystemExit('build-log anchor for 2b.9 not found - aborting')

if '| Phase 2b.10 \u2014' in text:
    print('2b.10 build-log row already present - no change')
else:
    lines = text.split('\n')
    # Insert after the LAST 2b.9 line so reruns don't drift.
    idx = None
    for i, ln in enumerate(lines):
        if ln.startswith(build_anchor_marker):
            idx = i
    if idx is None:
        raise SystemExit('could not locate Phase 2b.9 line')
    new_line = (
        '| 2026-04-24 | Claude (Cowork) | Phase 2b.10 \u2014 artist detail '
        'page (hash-routed #/artist/<name>, 1-year subs chart via '
        '/api/stats/history with synthetic fallback, score breakdown panel, '
        'recent uploads, deep-link + back-button routing; zero backend '
        'changes) + CSP inline-onclick sweep (root-cause: '
        'script-src-attr \'none\' silently null-voids every onclick="..."; '
        'fix: swapped 13 inline handlers for data-action="..." routed '
        'through a single document-level dispatcher in wireStaticHandlers; '
        'pattern is idempotent + delegation-safe for innerHTML replacements) '
        '| app.html | 0 |'
    )
    lines.insert(idx + 1, new_line)
    text = '\n'.join(lines)
    print('2b.10 build-log row inserted after line', idx + 1)

# ---- Error Log -----------------------------------------------------------
err_anchor = (
    '| 2026-04-18 | cowork-schedule | snapshot-rapper-stats-daily '
    'registered, cron "0 4 * * *", next run 2026-04-19 04:05 local | Active |'
)
if err_anchor not in text:
    raise SystemExit('error-log anchor not found (expected 2b.9 schedule row)')

err_signature = 'inline onclick silently void (CSP script-src-attr)'
if err_signature in text:
    print('2b.10 error-log rows already present - no change')
else:
    err_rows = [
        '| 2026-04-24 | app.html | artist-card click had no effect \u2014 '
        'root cause: inline onclick silently void (CSP script-src-attr '
        '\'none\'); fix: data-artist-index + grid-level delegation | '
        'Clicking Megan\u2019s card routes to #/artist/Megan%20Thee%20Stallion, '
        'detail panel populated from artistData[i] + /api/stats/history |',
        '| 2026-04-24 | app.html | Search button onclick="runSearch()" '
        'silently dead for the same CSP reason; Enter key still worked via '
        'addEventListener | Fix: swapped 13 inline onclicks for data-action '
        'attrs dispatched by a single body-level listener |',
        '| 2026-04-24 | app.html | End-to-end verify via tunnel \u2014 typed '
        '"xo muzik" + clicked Search \u2192 card added (191 subs / 25K views / '
        'Score 0), status bar "Added \u2018xo muzik\u2019 to tracker"; click '
        'card \u2192 detail view shows 4 stat tiles + synthetic chart + '
        'breakdown (Subs \u2192 +22.8, Lifetime views \u2192 +22); Back button '
        'returns to dashboard with hash cleared | Pass |',
    ]
    new_block = err_anchor + '\n' + '\n'.join(err_rows)
    text = text.replace(err_anchor, new_block, 1)
    print('2b.10 error-log rows inserted:', len(err_rows))

path.write_text(text)
print('Obsidian updated:', path)
