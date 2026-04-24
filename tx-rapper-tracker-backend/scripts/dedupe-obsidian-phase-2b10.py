#!/usr/bin/env python3
"""One-shot dedupe for the Phase 2b.10 error-log rows that got inserted
twice (script was rerun; my idempotency check used a signature that didn't
match what I actually wrote). Safe to run multiple times - only removes
exact-duplicate consecutive lines within the 2026-04-24 block."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

# Collapse consecutive exact duplicates inside the 2026-04-24 / app.html rows.
seen = set()
out = []
removed = 0
for ln in lines:
    is_2b10_err = ln.startswith('| 2026-04-24 | app.html |') or ln.startswith(
        '| 2026-04-24 | backend | End-to-end verify via tunnel'
    )
    if is_2b10_err and ln in seen:
        removed += 1
        continue
    if is_2b10_err:
        seen.add(ln)
    out.append(ln)

if removed:
    path.write_text('\n'.join(out))
    print(f'removed {removed} duplicate 2b.10 error-log row(s)')
else:
    print('no duplicates found - nothing to do')
print('Obsidian:', path)
