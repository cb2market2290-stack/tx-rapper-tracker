#!/usr/bin/env python3
"""Obsidian backfill for Phase 3d.3c — frontend bundle (email-prefs +
refer modals + onboarding empty-state + ?ref capture)."""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

BUILD_ROWS = [
    '| __DATE__ | Claude (Cowork) | Phase 3d.3c — Frontend bundle for digest + referral. After this commit the auth widget exposes Email + Refer buttons (next to Alerts/Security), the dashboard greets brand-new users with an onboarding card, and a /?ref=<token> URL sets the tx_ref cookie + records the click before signup. Two new buttons in the auth-widget header (btnEmail data-action=email-prefs-open + btnReferral data-action=referrals-open) mirror btnSecurity/btnAlerts signed-in/out lifecycle in renderAuthWidget. Three new modal HTML blocks: emailPrefsOverlay (single switch for digest_opted_in; loads via GET /api/digest/preferences saves via PATCH; shows last-sent-at; reuses .auth-overlay/.auth-modal/.sec-modal scaffold), referralsOverlay (readonly input with share link + Copy + 4 stats clicks/signups/couponsIssued/conversions; loads via GET /api/referrals/me auto-creates row on first call; Copy reuses 3c.4 copyToClipboard + showShareToast when present), onboardingCard (gradient-tinted card placed inline above the movers strip with 3 numbered steps + digest preference link + Got-it dismiss button). maybeShowOnboarding short-circuits when GET /api/saved-searches returns ANY saved-search row (= the user figured this out on their own). dismissOnboarding sets localStorage tx_onboarded=1. captureReferralFromUrl runs FIRST in window.onload — validates token shape (regex 6-32 chars), sets tx_ref cookie (30d, SameSite=Lax, path=/), strips ?ref= via history.replaceState, fires POST /api/referrals/click best-effort. All wrapped in try/catch so it never throws out of onload. 9 new dispatcher cases (email-prefs-{open,close,overlay-bg,save}, referrals-{open,close,overlay-bg,copy}, onboarding-dismiss). ~330 new JS lines + 1 CSS rule (.onboarding-card with accent-tint gradient + hidden override). Inline JS still parses cleanly (148KB single block); 80/80 unit tests still PASS. | ../tx-rapper-tracker/app.html, scripts/save-progress-3d3c.sh | 0 |',
]

ERROR_ROWS = [
    '| __DATE__ | frontend | onboardingCard initially defined adjacent to the modal blocks at the bottom of <body> — but it needs to render INLINE in the dashboard (.container) so it appears above the movers strip when un-hidden. Moved the HTML to inside the dashboard container right before the Movers section title. Modal-style positioning would have required overlay markup, which is overkill for a non-blocking hint card. Pattern: hint cards live in document flow, modals live at body-level. | Pass — design choice |',
    '| __DATE__ | frontend | captureReferralFromUrl deliberately runs BEFORE checkSession in window.onload — the cookie has to be set before the user clicks Sign Up (which posts to /api/auth/signup, which reads req.cookies.tx_ref). If we ran it after checkSession+renderAuthWidget the order still works for users who arrive then sign up later, but for the rare case of a referral URL that bounces straight into the signup modal, the earlier-the-better. The function is wrapped in try/catch with no-op fallthrough on any throw because page-load is the worst place to break. | Pass — design |',
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
    print(f'duplicates removed: {removed}')
else:
    print('no changes needed — everything already in place')
print('Obsidian:', path)
