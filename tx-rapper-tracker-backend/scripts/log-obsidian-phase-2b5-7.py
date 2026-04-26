#!/usr/bin/env python3
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()

# --- Build Log: insert three new rows after the Phase 2b.4 row -------------
anchor = '| 2026-04-18 | Claude (Cowork) | Phase 2b.4 first deploy: brew install cloudflared, quick tunnel https://auckland-fred-effect-gst.trycloudflare.com \u2192 localhost:8787 | 7/7 tunnel smoke tests green, YouTube upstream 0.74s via edge |'
if anchor not in text:
    raise SystemExit('anchor row not found - aborting; nothing changed')

# Idempotency guard: if 2b.5 already landed, skip rows section.
if '2b.5 same-origin frontend' not in text:
    new_rows = [
        '| 2026-04-18 | Claude (Cowork) | Phase 2b.5 same-origin frontend: backend serves app.html at /, admin.html at /admin, /reset for reset links; CORS same-origin bypass via URL.host compare; tightened CSP (connectSrc self, cdnjs for Chart.js, i.ytimg.com for thumbs) | end-to-end verified through tunnel: / renders 6 cards, /admin dashboard shows 9 users/14 sessions/31 audit rows |',
        '| 2026-04-18 | Claude (Cowork) | Phase 2b.6 password-reset backend: POST /forgot (202 enumeration-safe, async mailer tail), GET /reset/check, POST /reset (atomic single-use consume, revoke-all sessions, burn sibling tokens); pluggable mailer (ConsoleMailer writes /tmp/last-reset-email.txt, ResendMailer for prod); strict-auth rate bucket covers /forgot + /reset | 14/14 assertions in scripts/test-reset.sh green |',
        '| 2026-04-18 | Claude (Cowork) | Phase 2b.7 password-reset UI: "Forgot your password?" link on sign-in modal switches to forgot mode (email-only, enumeration-safe success msg); /reset?token=... landing view validates via /reset/check, new-password form POSTs to /reset, redirects to /?reset=ok with flash banner; backend adds /reset route serving app.html | app.html +~180 lines, node --check on inline JS clean, all 16 new IDs wired |',
    ]
    new_block = anchor + '\n' + '\n'.join(new_rows)
    text = text.replace(anchor, new_block, 1)

# --- Error Log: add reset + tunnel + admin + app.html smoke rows ----------
err_anchor = '| 2026-04-18 | backend | scripts/test-policy.sh \u2014 9 scenarios (weak/HIBP/strong/wrong-current/weak-new/success + session revocation) | All expected codes |'
if err_anchor in text and 'scripts/test-reset.sh' not in text:
    err_rows = [
        '| 2026-04-18 | backend | scripts/test-tunnel.sh \u2014 7 scenarios (health, upstream fetch, auth gating) | All pass |',
        '| 2026-04-18 | backend | scripts/test-admin.sh \u2014 5 admin read-only scenarios | All pass |',
        '| 2026-04-18 | backend | scripts/test-reset.sh \u2014 14 reset-flow assertions (signup, /forgot unknown=202, /forgot real=202, token extract, /reset/check, weak=400, strong=200, old cookie=401, old pw=401, new pw=200, reused token=400) | All pass |',
        '| 2026-04-18 | app.html | node --check on extracted inline JS (640 lines) | Clean |',
    ]
    err_block = err_anchor + '\n' + '\n'.join(err_rows)
    text = text.replace(err_anchor, err_block, 1)

# --- Next Steps: strike items we just shipped -----------------------------
text = text.replace(
    '1. **SMTP + password reset flow** \u2014 wire a route onto the password_reset_tokens table. Pick a provider (Resend / SES / Postmark).',
    '1. ~~**SMTP + password-reset flow**~~ \u2014 **DONE in 2b.6 / 2b.7**: ConsoleMailer (dev) + ResendMailer stub + full UI. Real Resend sender blocked on buying a domain.',
)
text = text.replace(
    "4. **Admin read-only UI** \u2014 small page behind requireUser('admin') that reads audit_log and sessions. All admin ops are raw SQL right now.",
    "4. ~~**Admin read-only UI**~~ \u2014 **DONE in 2b.3**: admin.html + /api/admin/stats|sessions|audit shipped.",
)

path.write_text(text)
print('obsidian updated:', path)
print('new build-log row count:', text.count('| 2026-04'))
