#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phase 2d.

Phase 2d shipped two parallel tracks:
  * 2d.A — Stripe Checkout + Customer Portal + paid-tier gating: migration
    011 (checkout_sessions audit + active_user_plan view), services/stripe
    Checkout/Portal helpers + getPlanForUser, routes/payments POST
    /checkout + POST /portal + GET /plan, middleware/requirePaid (402
    gate), webhook dispatch for checkout.session.completed +
    invoice.paid|failed, frontend Upgrade pill + inline feat-gate card +
    checkout flash + URL scrub, 11 new offline tests on
    shapeCheckoutSession + 1 getPlanForUser fast-path test, scripts/
    test-payments.sh extended with sections 5–12.
  * 2d.B — long-running audio worker + analyzer_version-driven
    re-extraction: scripts/run-extract-worker.sh (drain-and-sleep loop
    with structured logs + SIGTERM trap), scripts/install-launchd-extract.sh
    (KeepAlive=non-zero-exit, ThrottleInterval=30, idempotent
    bootstrap), services/features getStaleVideoIds +
    requeueForReextraction, scripts/enqueue-features.js
    --reextract VERSION + --limit N, 3 new offline tests on the
    re-extraction helpers (validation + filtering, no DB hits).

Plus 2d.C docs: README rewrite (Stripe CLI recipe, launchd ops, analyzer
version policy), BUILD_LOG_ENTRY.md prepended Phase 2d block,
save-progress-2d.sh.

Adds Build Log + Error Log rows for today's work and collapses any
exact-duplicate today-rows from prior reruns. Safe to run multiple
times — uses an exact-line sentinel match.

Run:
    python3 scripts/log-obsidian-phase-2d.py
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

# ---------------------------------------------------------------------------
# Rows to ensure present.  Each entry is one full markdown table row.
# ---------------------------------------------------------------------------
BUILD_ROWS = [
    # Phase 2d.A — Stripe Checkout + Customer Portal + paid-tier gating
    '| 2026-04-26 | Claude (Cowork) | Phase 2d.A — Stripe Checkout + Customer Portal + paid-tier gating: migration 011 (checkout_sessions audit table + active_user_plan view via LEFT JOIN LATERAL + DISTINCT ON over stripe_subscriptions, single source of truth for plan), src/services/stripe.js gains createCheckoutSessionForUser + createPortalSession + shapeCheckoutSession (pure) + recordCheckoutSession + getPlanForUser, src/routes/payments.js POST /checkout + POST /portal + GET /plan (all behind requireUser, 503 when stripe disabled), webhook handler dispatches checkout.session.completed + invoice.paid + invoice.payment_failed, src/middleware/requirePaid.js 402-gates /api/artists/:id/features with kind=\'payments.required\', frontend (app.html) plan-pill + .feat-gate card + loadPlan() after every sign-in path + 402 throw-with-status-and-body in proxyGet (does NOT flip backendOk so demo banner stays hidden) + ?checkout=success poll loop + URL-scrub flashes, scripts/test-payments.sh extended sections 5–12 (anonymous 401s on plan/checkout/portal, signed-in plan==free, 503 on disabled checkout/portal, 402 on free-user features), test/stripe.test.js extended 13→24 (11 shapeCheckoutSession + 1 getPlanForUser falsy-userId fast path) | src/services/stripe.js, src/routes/payments.js, src/middleware/requirePaid.js, src/routes/artists.js, migrations/011_checkout_sessions.sql, scripts/test-payments.sh, test/stripe.test.js, ../tx-rapper-tracker/app.html | 0 |',

    # Phase 2d.B — long-running audio worker + analyzer_version re-extraction
    '| 2026-04-26 | Claude (Cowork) | Phase 2d.B — long-running audio worker + analyzer_version re-extraction policy: scripts/run-extract-worker.sh (drain-and-sleep loop wrapping extract-features.py --max $WORKER_BATCH; reads --status JSON to short-circuit on empty queue with WORKER_IDLE_SLEEP; busy cycles take WORKER_BUSY_SLEEP between drains; SIGTERM/SIGINT trap stops the outer loop and lets Python finish its current job; structured stdout LVL ts key=val format), scripts/install-launchd-extract.sh (com.txrappertracker.extract LaunchAgent: KeepAlive {SuccessfulExit:false}, ThrottleInterval=30, ProcessType=Background, Nice=5, baked PATH from resolved python/yt-dlp/ffmpeg, idempotent bootout-then-bootstrap), src/services/features.js adds getStaleVideoIds (analyzer_version IS DISTINCT FROM current, NULL-safe, optional artistId + limit) and requeueForReextraction (UPSERT flipping track_extraction_jobs back to status=pending attempts=0 last_error=NULL enqueued_at=now(); existing track_features row preserved until worker upserts replacement so degraded data stays readable on failure), scripts/enqueue-features.js gains --reextract VERSION + --limit N (skips YouTube discovery loop, logs byVer breakdown), test/features.test.js extended 18→21 (getStaleVideoIds validation rejects missing/empty/null version; requeueForReextraction empty list + malformed pairs short-circuit without DB call) | src/services/features.js, scripts/run-extract-worker.sh, scripts/install-launchd-extract.sh, scripts/enqueue-features.js, test/features.test.js | 0 |',

    # Phase 2d.C — docs + ops
    '| 2026-04-26 | Claude (Cowork) | Phase 2d.C — docs + ops: README.md updated to "live build through Phase 2d" — new /api/payments/{checkout,portal,plan} endpoint inventory + 402 gating semantics; "Phase 2d operations cheat sheet" section with Stripe CLI `stripe listen --forward-to` recipe (signing-secret-per-run, raw-body justification), launchd install + kickstart ops, and the analyzer_version re-extraction policy with a worked CLI example; layout map updated with migration 011 + run-extract-worker.sh + install-launchd-extract.sh; "intentionally not yet" section trimmed (Stripe checkout + worker daemon now shipped) and replaced with multi-tier pricing + admin re-extract UI as deferred items. BUILD_LOG_ENTRY.md prepended Phase 2d block (3 rows + 4 error-log rows). scripts/log-obsidian-phase-2d.py idempotent Build Log writer + scripts/save-progress-2d.sh explicit-add commit script (skips .env, sibling projects, __pycache__). | README.md, BUILD_LOG_ENTRY.md, scripts/log-obsidian-phase-2d.py, scripts/save-progress-2d.sh | 0 |',
]

ERROR_ROWS = [
    # Phase 2d.A — Stripe wiring
    '| 2026-04-26 | backend | Stripe Checkout + Portal smoke (test-payments.sh sections 5–12): anonymous /plan + /checkout + /portal all return 401; signed-in /plan returns {kind:"payments.plan", plan:"free", stripeStatus:"free"}; /checkout + /portal return 503 with kind=="payments.disabled" when STRIPE_SECRET_KEY unset; free-user /api/artists/:id/features returns 402 with kind=="payments.required". 26/26 sections green after middleware-order fix | Pass |',
    # Live-smoke-only fixes
    '| 2026-04-26 | backend | Live smoke caught a middleware-order bug in src/index.js: cookieParser() + attachUser() were mounted AFTER `/api/payments`, so requireUser() inside the payments router never saw req.user — signed-in /plan, /checkout, /portal all returned 401 instead of 200/503. Fix: hoisted cookieParser + attachUser ABOVE the /api/payments mount (they only read headers + do a session-cookie DB lookup, so the raw-body Stripe webhook is unaffected). Smoke went 18/26 → 26/26 after restart | Pass — bug caught and fixed pre-deploy |',
    '| 2026-04-26 | backend | scripts/test-payments.sh signup status check accepted only HTTP 200; live server returns 201 (correct REST semantics for resource creation). Loosened to `200 or 201`, smoke unblocked | Pass |',
    '| 2026-04-26 | backend | stripe.test.js extended 13→24: shapeCheckoutSession throws on missing id, normalizes string customer, unwraps expanded customer object, returns null customer when neither, reads priceId from line_items.data[0].price.id, falls back to metadata.price_id, defaults mode="subscription", unwraps subscription object id, surfaces customer_details.email + payment_status; getPlanForUser({userId:null}) returns {plan:"free"} without DB call. 24/24 pass | Pass |',
    # Phase 2d.B — audio worker
    '| 2026-04-26 | backend | features.test.js extended 18→21: getStaleVideoIds rejects missing/empty/null currentAnalyzerVersion with explicit error; requeueForReextraction returns {requeued:0} for [], null, undefined; filters malformed pairs (missing artist_id, missing video_id, both empty, null entries) without issuing a SQL call (verified by absence of DB error). 21/21 pass | Pass |',
    # Frontend
    '| 2026-04-26 | app.html | Frontend Upgrade CTA + 402 handling: plan-pill renders "Paid" / "Upgrade" beside auth widget after every sign-in path (TOTP, WebAuthn, plain), proxyGet 402 throws Error with .status=402 and .body=<server payload> (does NOT flip backendOk → demo banner stays hidden), audio panel renders inline .feat-gate Upgrade card with sign-in fallback when 402-gated, ?checkout=success flash + 5-attempt plan-poll-and-flip + URL scrub, ?checkout=cancel + ?portal=closed flashes + scrubs. Bash node --check on extracted JS clean | Pass |',
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
    if ln.startswith('| 2026-04-26 |'):
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
