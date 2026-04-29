#!/usr/bin/env python3
"""Obsidian backfill for Phase 3d.3b — referral routes + signup wiring +
webhook hook.

Same idempotent pattern: plain strings + __DATE__ substitution;
ensure_row + dedupe; safe to re-run.
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

BUILD_ROWS = [
    '| __DATE__ | Claude (Cowork) | Phase 3d.3b — Referral routes + signup wiring + checkout webhook hook. End-to-end backend reachability for the referral feature. After this commit, hitting POST /api/referrals/click with a valid token records a click; signing up while a tx_ref cookie is set persists users.referrer_token; converting via Stripe Checkout fires createReferralCoupon and writes the referral_coupons row. src/routes/referrals.js (~110 lines) mounted at /api/referrals: GET /me requireUser auto-creates the referrals row on first call via ensureToken (lazy backfill), returns token + shareable link (config.appBaseUrl with request-origin fallback) + stats; POST /click anonymous body {token} idempotent within 24h-same-(token,ip), returns 200 + kind:referrals.click_recorded OR referrals.click_deduped (both 200 by design — no leak between dedupe-hit + bad-token shape; defense-in-depth against fishing probes). src/routes/auth.js signup wiring pulls req.cookies.tx_ref before the INSERT, validates via getReferrerByToken, persists on users.referrer_token, clears the cookie on success, includes the token in the audit signup event details. Self-referral is impossible at this point because the user row is being created right now. Three failure modes (bogus shape, lookup blip, no resolution) all fall through with referrerToken=null; signup never tanks. src/routes/payments.js checkout.session.completed branch adds a coupon path: gate on shaped.paymentStatus in (paid, no_payment_required) — only converted sessions issue; LEFT JOIN users.referrer_token to referrals.user_id; call createReferralCoupon (service handles isDifferentUser + already-issued short-circuit + Stripe re-delivery idempotency via PK on referred_user_id). Best-effort try/catch — coupon path can never tank the rest of the webhook flow. Anti-fraud IP guard (ipIsSignupAbusing) NOT wired here because webhook context has Stripe-s IP not the user-s; TODO inlined to wire it at signup time instead. src/index.js: app.use(/api/referrals, referralsRoutes). Three modules import cleanly; 80/80 tests across slugs + briefs + digest + health-deep + referrals PASS. | src/routes/referrals.js, src/routes/auth.js, src/routes/payments.js, src/index.js, scripts/save-progress-3d3b.sh | 0 |',
]

ERROR_ROWS = [
    '| __DATE__ | backend | createReferralCoupon-s anti-fraud IP guard cannot run inside the Stripe webhook handler — the source IP is Stripe-s, not the original signing-up user-s. Decision: wire ipIsSignupAbusing at signup time instead (when req.ip is the real client IP), block coupon-issuance at that point by leaving users.referrer_token null. The TODO is inlined in routes/payments.js next to the coupon-path try/catch so the next-pass implementer sees the gap. Pattern: any anti-fraud guard whose evidence comes from request metadata must run at the request that has that metadata, not at a downstream webhook callback. | Pass — design |',
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

# Dedupe today-rows.
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
