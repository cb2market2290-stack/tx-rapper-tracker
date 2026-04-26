#!/usr/bin/env python3
"""Idempotent append of reset/tunnel/admin smoke-test rows to Error Log."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()

err_anchor = '| 2026-04-18 | backend | scripts/test-policy.sh \u2014 9 scenarios (weak/HIBP/strong/wrong-current/weak-new/success + session revocation) | All expected codes |'
if err_anchor not in text:
    raise SystemExit('error-log anchor not found - aborting')

# Idempotency: look for a signature that only exists in the new error-log rows.
if '\n| 2026-04-18 | backend | scripts/test-tunnel.sh' in text:
    print('error-log rows already present - no change')
    raise SystemExit(0)

err_rows = [
    '| 2026-04-18 | backend | scripts/test-tunnel.sh \u2014 7 scenarios (health, upstream fetch, auth gating) | All pass |',
    '| 2026-04-18 | backend | scripts/test-admin.sh \u2014 5 admin read-only scenarios | All pass |',
    '| 2026-04-18 | backend | scripts/test-reset.sh \u2014 14 reset-flow assertions (signup, /forgot unknown=202, /forgot real=202, token extract, /reset/check, weak=400, strong=200, old cookie=401, old pw=401, new pw=200, reused token=400) | All pass |',
    '| 2026-04-18 | app.html | node --check on extracted inline JS (640 lines) | Clean |',
]
err_block = err_anchor + '\n' + '\n'.join(err_rows)
text = text.replace(err_anchor, err_block, 1)

path.write_text(text)
print('error-log updated; rows added:', len(err_rows))
