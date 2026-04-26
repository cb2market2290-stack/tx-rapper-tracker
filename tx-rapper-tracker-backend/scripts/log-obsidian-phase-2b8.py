#!/usr/bin/env python3
"""Idempotent append of Phase 2b.8 rows (admin write UI) to Build Log + Error Log."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()

# Build-Log anchor: last existing Build-Log row. Placing new rows after it
# keeps chronological order and lets the script be rerun idempotently.
build_anchor_marker = '| 2026-04-18 | Claude (Cowork) | Phase 2b.7'
if build_anchor_marker not in text:
    raise SystemExit('build-log anchor for 2b.7 not found - aborting')

# Idempotency: the 2b.8 row's signature.
if '| Phase 2b.8 —' in text:
    print('2b.8 build-log row already present - no change')
else:
    # Find the last line starting with "| 2026-04-18 | Claude (Cowork) | Phase 2b.7"
    # and append immediately after it. We do this by string replace on that whole
    # line, which must therefore be unique.
    lines = text.split('\n')
    idx = None
    for i, ln in enumerate(lines):
        if ln.startswith(build_anchor_marker):
            idx = i
    if idx is None:
        raise SystemExit('could not locate Phase 2b.7 line')
    new_line = (
        '| 2026-04-18 | Claude (Cowork) | Phase 2b.8 — admin write UI: Users panel '
        '+ Revoke/Disable/Enable buttons with confirm() + auto-refresh | admin.html 322 | 0 |'
    )
    lines.insert(idx + 1, new_line)
    text = '\n'.join(lines)
    print('2b.8 build-log row inserted after line', idx + 1)

# Error-Log: add the smoke-test + live-UI rows.
err_anchor = '| 2026-04-18 | app.html | node --check on extracted inline JS (640 lines) | Clean |'
if err_anchor not in text:
    raise SystemExit('error-log anchor not found - aborting')

err_signature = 'scripts/test-admin-write.sh \u2014 21 assertions'
if err_signature in text:
    print('2b.8 error-log rows already present - no change')
else:
    err_rows = [
        '| 2026-04-18 | backend | scripts/test-admin-write.sh \u2014 21 assertions '
        '(non-admin 404, revoke session, dead cookie 401, disable+sessionsRevoked, '
        '403 account_disabled, self-disable 400, re-disable 409, enable 200, '
        're-enable 409, login after enable, 3 audit events) | 21/21 pass |',
        '| 2026-04-18 | admin.html | node --check on inline <script> (217 lines) | Clean |',
        '| 2026-04-18 | admin.html | live UI via tunnel — Disable flips pill+button, '
        'Enable flips back, Revoke drops session row (21\u219220) + audit event, '
        'self-disable alerts 400 | All green |',
    ]
    new_block = err_anchor + '\n' + '\n'.join(err_rows)
    text = text.replace(err_anchor, new_block, 1)
    print('2b.8 error-log rows inserted:', len(err_rows))

path.write_text(text)
print('Obsidian updated:', path)
