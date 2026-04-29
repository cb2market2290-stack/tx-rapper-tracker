#!/usr/bin/env python3
"""Obsidian backfill for Phase 3d.3a — referral migration + service.

Same idempotent pattern as the prior phase loggers. Plain strings +
__DATE__ substitution; ensure_row + dedupe; safe to re-run.
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

BUILD_ROWS = [
    '| __DATE__ | Claude (Cowork) | Phase 3d.3a — Referral program: migration 018 + services/referrals.js + 11 unit tests. First chunk of the referral feature locked in PHASE_3D_DESIGN.md; nothing reads these yet. migrations/018_referrals.sql adds 3 tables + 1 column: referrals (user_id PK + token UNIQUE; stable per-user, never auto-rotates), users.referrer_token TEXT (FK to referrals(token) ON DELETE SET NULL; FK added with NOT VALID + VALIDATE for fresh-DB no-op + populated-DB strict check), referral_clicks (BIGSERIAL PK, token, ip INET, user_agent, ts) + index on (token, ts DESC) for the route 24h dedupe gate, referral_coupons (referred_user_id PK = idempotency key for Stripe webhook re-deliveries, referrer_user_id, stripe_coupon_id, amount_off_cents, currency, expires_at, redeemed_at) + index (referrer_user_id, created_at DESC) for stat-page hot path. src/services/referrals.js (~340 lines) pure surface: generateToken (8 bytes -> 12 chars base64url, locked v1), isValidToken (alphanumeric + _- length 6-32), isDifferentUser (self-referral check; returns true on missing-id so no false-positive), buildCouponPayload (locked Stripe shape — duration:once, FIXED amount_off in cents, currency, max_redemptions:1, redeem_by 30d, metadata with both user IDs + source phase-3d). Locked constants: TOKEN_BYTES=8, CLICK_DEDUPE_HOURS=24, ANTI_FRAUD_SIGNUP_LIMIT=3 + WINDOW_HOURS=24 + PAUSE_DAYS=7, COUPON_AMOUNT_OFF_CENTS_DEFAULT=1900 (USD 19/mo Pro reference), COUPON_EXPIRY_DAYS=30. I/O surface: ensureToken (race-safe insert+select, idempotent), getReferrerByToken (null on miss), recordClick (idempotent within 24h same-token-same-IP), getStats (single 4-subquery SELECT returning clicks/signups/conversions/couponsIssued), ipIsSignupAbusing (counts via audit_log event=signup rather than adding users.last_signup_ip column — reuses existing audit infrastructure that already captures IP at signup), recordCoupon (INSERT ON CONFLICT (referred_user_id) DO NOTHING returns issued + row to distinguish first-write from Stripe re-delivery). Top-level orchestrator createReferralCoupon does self-referral guard, already-issued short-circuit, lazy-import of services/stripe.js#getStripe (importable without SDK), Stripe coupons.create, persist via recordCoupon. test/referrals.test.js +11 (generateToken shape + uniqueness across 1000, isValidToken accept/reject 8 cases, isDifferentUser 3 cases, buildCouponPayload locked Stripe shape + redeem_by COUPON_EXPIRY_DAYS in future + amountOffCents/currency overrides, TOKEN_BYTES=8 contract). | migrations/018_referrals.sql, src/services/referrals.js, test/referrals.test.js, scripts/save-progress-3d3a.sh | 0 |',
]

ERROR_ROWS = [
    '| __DATE__ | backend | Anti-fraud signup-velocity guard initially queried users.last_signup_ip — column does not exist. Fixed to count via audit_log (WHERE ip = $1 AND event = signup AND at > now() - interval). Reuses the existing audit infrastructure (every signup already records ip there) instead of adding a new column just for an anti-fraud counter. Spotted via grep before route load. | Pass — fix in tree |',
    '| __DATE__ | infra | save-progress-3d3a.sh initial run failed with "$1: unbound variable" because the commit message contained "USD 19/mo" written as a dollar-sign-prefixed integer (the literal "$19/mo Pro reference"). Bash inside double-quoted git commit -m expanded $19 as positional arg 19 and aborted. Fix: write the message as "USD 19/mo" instead. Pattern carried — every save-progress-*.sh commit message avoids "$N" with N a digit; treat literal dollar signs as suspect inside double-quoted message bodies. | Pass — fix in tree |',
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

# Dedupe today-rows from prior reruns.
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
