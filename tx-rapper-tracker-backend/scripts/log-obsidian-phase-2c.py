#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phases 2b.13, 2b.14, and 2c.

Covers the three pieces of work that landed since Phase 2b.12:
  * Phase 2b.13 — TOTP 2FA (auth/totp.js + recovery.js, routes/twofactor.js,
    migration 007, frontend enroll + login step, smoke).
  * Phase 2b.14 — WebAuthn / passkeys (src/auth/webauthn.js,
    routes/webauthn.js, migration 008, frontend register + sign-in step,
    tests + smoke).
  * Phase 2c — per-track audio features (yt-dlp + librosa worker,
    migration 009, src/services/features.js, GET /api/artists/:id/features,
    frontend audio panel + ranking bonus, 18 unit tests + features smoke)
    + Stripe payments scaffolding (migration 010, src/services/stripe.js,
    routes/payments.js with raw-body mounted ahead of express.json,
    config + .env.example wiring, 13 unit tests + payments smoke,
    README + BUILD_LOG_ENTRY.md updates).

Adds Build Log + Error Log rows for today's work and collapses any
exact-duplicate today-rows from prior reruns. Safe to run multiple
times — uses an exact-line sentinel match.

Run:
    python3 scripts/log-obsidian-phase-2c.py
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

# ---------------------------------------------------------------------------
# Rows to ensure present.  Each entry is one full markdown table row.
# ---------------------------------------------------------------------------
BUILD_ROWS = [
    # Phase 2b.13 — TOTP 2FA
    '| 2026-04-25 | Claude (Cowork) | Phase 2b.13 — TOTP 2FA: migration 007 (user_totp + recovery_codes), src/auth/totp.js (RFC-6238 + AES-256-GCM secret-at-rest, key derived from SESSION_SECRET in dev with prod warn), src/auth/recovery.js (10 single-use codes, hashed), src/routes/twofactor.js (/enroll, /enroll/verify, /verify, /disable), middleware/authenticate.js gains pre_2fa cookie path, login flow returns {kind:"login.2fa_required"} when TOTP enrolled, frontend enroll modal + sign-in step in app.html, scripts/test-2fa.sh smoke | src/auth/totp.js, src/auth/recovery.js, src/routes/twofactor.js, src/middleware/authenticate.js, migrations/007_totp.sql, app.html, scripts/test-2fa.sh, test/totp.test.js | 0 |',
    # Phase 2b.14 — WebAuthn / passkeys
    '| 2026-04-25 | Claude (Cowork) | Phase 2b.14 — WebAuthn / passkeys: migration 008 (webauthn_credentials + webauthn_challenges with TTL), src/auth/webauthn.js (challenge mint + verify, @simplewebauthn/server backed), src/routes/webauthn.js (/register/options + /register/verify behind requireUser, /authenticate/options + /authenticate/verify on the pre_2fa cookie path), config gains WEBAUTHN_RP_ID/RP_NAME/ORIGINS, frontend "Add a passkey" + sign-in branch in app.html, scripts/test-webauthn.sh smoke + test/webauthn.test.js | src/auth/webauthn.js, src/routes/webauthn.js, migrations/008_webauthn.sql, app.html, scripts/test-webauthn.sh, test/webauthn.test.js | 0 |',
    # Phase 2c.1 — audio features
    '| 2026-04-25 | Claude (Cowork) | Phase 2c.1 — per-track audio features: migration 009 (track_features numeric columns + extras JSONB, track_extraction_jobs queue), scripts/extract-features.py (yt-dlp 3-min audio rip → librosa tempo/chroma/RMS/spectral + Krumhansl-Schmuckler key picker → camelot label), scripts/enqueue-features.js (seed jobs from each artist\'s recent uploads), src/services/features.js (cleanRow + dominantKey duration-weighted + aggregate→featureBonus, all pure for offline tests), GET /api/artists/:id/features (gated by requireUser, 400 bad UUID, 404 unknown, 200 with null summary on empty queue), frontend audio panel in app.html + score formula gains featureBonus×5 (capped), 18 unit tests + scripts/test-features.sh — fixed Number(null)===0 averaging bug discovered by the test suite | src/services/features.js, src/routes/artists.js, scripts/extract-features.py, scripts/enqueue-features.js, scripts/test-features.sh, test/features.test.js, migrations/009_track_features.sql, ../tx-rapper-tracker/app.html | 0 |',
    # Phase 2c.2 — Stripe scaffolding
    '| 2026-04-25 | Claude (Cowork) | Phase 2c.2 — Stripe scaffolding (receiver-only, safe-off): migration 010 (stripe_customers + stripe_subscriptions + stripe_webhook_events for idempotency), src/services/stripe.js (lazy SDK import, getStripe throws when keys empty, pure helpers unixToDate / shapeSubscription / isActiveStatus, DB writers linkCustomer / upsertSubscription / recordEvent{Start,Finish}), src/routes/payments.js exported as buildRouter() so src/index.js mounts express.raw at /api/payments AHEAD of global express.json (Stripe signs raw bytes), POST /webhook 503-when-disabled, 400 on missing/invalid signature, dedupes on event.id, dispatches customer.subscription.{created,updated,deleted} → upsert; GET /payments/status diagnostic; config.stripe.* + redacted() masking + .env.example, 13 unit tests + scripts/test-payments.sh covering JSON-parser-still-works regression | src/services/stripe.js, src/routes/payments.js, src/config.js, src/index.js, .env.example, migrations/010_stripe_payments.sql, scripts/test-payments.sh, test/stripe.test.js | 0 |',
    # Phase 2c docs
    '| 2026-04-25 | Claude (Cowork) | Phase 2c docs + polish — README rewritten through Phase 2c (endpoint inventory, Postgres + optional Python prereqs, Stripe env vars, layout map covering services/features.js + services/stripe.js + routes/{artists,payments}.js + migrations 009 + 010), BUILD_LOG_ENTRY.md prepended with Phase 2c row in same format as 2a entry, audited log levels in routes/payments.js (warn for client-caused signature failure, info for duplicate, error for handler crash, debug for unhandled-but-recorded event types — already correctly tiered, no change needed), confirmed services delegate logging to routes (right separation) | README.md, BUILD_LOG_ENTRY.md | 0 |',
]

ERROR_ROWS = [
    # Phase 2b.13 — TOTP
    '| 2026-04-25 | backend | TOTP enroll → verify → login round-trip via test-2fa.sh — secret encrypted at rest (AES-256-GCM, IV per row), recovery codes single-use, pre_2fa cookie path scoped, 5/5 smoke pass | Pass |',
    # Phase 2b.14 — WebAuthn
    '| 2026-04-25 | backend | WebAuthn register options + verify + authenticate options + verify smoke via test-webauthn.sh — challenge TTL enforced, RP_ID localhost in dev, simplewebauthn server-side checks pass | Pass |',
    # Phase 2c.1 — features
    '| 2026-04-25 | backend | features.test.js exposed Number(null)===0 averaging bug — null energies were polluting averages with phantom zeros; fix: drop null/undefined BEFORE Number() coercion in src/services/features.js. 18/18 unit tests pass after fix | Pass — bug caught and fixed pre-deploy |',
    '| 2026-04-25 | backend | scripts/test-features.sh: anonymous /api/artists 401, anonymous features 401, signup→session, /api/artists shape with first artist UUID extraction, UUID validation 400, unknown UUID 404, real artist features 200 with shape + null featureBonus regression on empty queue — all green | Pass |',
    # Phase 2c.2 — Stripe
    '| 2026-04-25 | backend | Stripe webhook receiver: missing-key path returns 503 (not 404, deliberate "loud not silent"), missing Stripe-Signature 400, bogus signature → invalid_signature 400; with raw-body mounted at route /api/payments BEFORE global express.json, /api/auth/me still returns 401 (regression check that the parser path is intact). 4/4 sections green | Pass |',
    '| 2026-04-25 | backend | stripe.test.js — 13 offline tests pass: unixToDate null/zero/string handling, shapeSubscription (throws on missing id, pulls priceId from items.data[0], handles expanded customer object form, defaults status to "incomplete"), isActiveStatus (active/trialing/past_due true; canceled/incomplete/unpaid/null false), getStripe error path when STRIPE_SECRET_KEY empty, config.stripe.enabled false when keys missing | Pass |',
    # Frontend
    '| 2026-04-25 | app.html | Detail-page Audio features panel renders with Camelot pill, energy meter (6px bar + span fill), per-track table truncated to 8 rows; loadRoster() now keeps {id,name} pairs from /api/artists so detail can fetch features by UUID; ranking score formula gains featureBonus×5 capped at +5 — visible nudge in placement when worker has enriched a roster | Pass |',
    # Test summary
    '| 2026-04-25 | suite | npm test: 31 new offline tests (18 features + 13 stripe) all green; pre-existing 5 cache.test.js failures unchanged (require live Postgres, sandbox doesn\'t have one) | Acceptable — pre-existing, unrelated |',
]


# ---------------------------------------------------------------------------
# Insertion helper
# ---------------------------------------------------------------------------
def ensure_row(all_lines, row, section_header):
    """Insert `row` into the markdown table under `section_header` if not
    already present as an exact line. Returns (new_lines, inserted_bool)."""
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

# ---------------------------------------------------------------------------
# Dedupe: collapse exact-duplicate today-rows (safe across reruns)
# ---------------------------------------------------------------------------
seen = {}
out = []
removed = 0
for ln in lines:
    if ln.startswith('| 2026-04-25 |'):
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
