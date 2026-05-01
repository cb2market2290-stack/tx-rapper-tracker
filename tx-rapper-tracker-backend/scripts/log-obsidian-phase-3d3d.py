#!/usr/bin/env python3
"""Obsidian backfill for Phase 3d.3d — Phase 3d close-out smokes."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

BUILD_ROWS = [
    '| __DATE__ | Claude (Cowork) | Phase 3d.3d — Smoke + close-out for Phase 3d (digest + referral). Closes Phase 3d end-to-end across 7 commits (3d.1 design 8de0536, 3d.2 digest backend a21f49a, 3d.3a referral migration+service ed37860, 3d.3b referral routes+signup+webhook hook 1158038, 3d.3c frontend bundle 871c16c, 3d.3d smoke close-out this commit). scripts/test-digest.sh has 9 subtests: anonymous GET/PATCH /preferences -> 401; signup -> session; signed-in GET /preferences -> 200 + opted_in=true (default per locked design); PATCH opt-out -> 200 + persisted on read-back; GET /preview -> 200 (payload may be null on empty signals); /unsubscribe with bogus token -> 400 + HTML; missing params -> 400; send-weekly-digest.js parses cleanly via node --check. scripts/test-referrals.sh has 9 subtests: anonymous /me -> 401; signup -> session; /me -> 200 + token + link containing ?ref=<token> + zero stats; /me stable token across calls; /click malformed token -> 200 + click_deduped (no leak); /click shape-OK-but-non-existent -> 200 deduped; /click real token -> 200 + click_recorded; /click again same-IP within 24h -> 200 + click_deduped (dedup gate works); /me stats.clicks reflects recorded click. What both smokes deliberately CANNOT do without manual setup: real-mailer send for digest (needs RESEND_API_KEY + verified domain), Stripe coupon issuance for referrals (needs STRIPE_SECRET_KEY + a real conversion via scripts/test-payments.sh). Manual-verify paths documented inline at the top of each script. Live verify steps for user: npm run migrate (017 + 018) -> restart backend -> bash scripts/test-digest.sh -> bash scripts/test-referrals.sh -> open app + sign in + click Email + Refer -> open /?ref=<token> in incognito + sign up -> verify users.referrer_token persisted in audit log. | scripts/test-digest.sh, scripts/test-referrals.sh, scripts/save-progress-3d3d.sh | 0 |',
]

ERROR_ROWS = []


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

inserted_build = 0
for row in BUILD_ROWS:
    lines, ok = ensure_row(lines, row, '## Build Log')
    if ok:
        inserted_build += 1

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

if inserted_build or removed:
    path.write_text('\n'.join(out))
    print(f'build-log: +{inserted_build} row(s)')
    print(f'duplicates removed: {removed}')
else:
    print('no changes needed — everything already in place')
print('Obsidian:', path)
