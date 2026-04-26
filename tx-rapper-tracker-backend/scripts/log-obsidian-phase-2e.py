#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phase 2e + deploy verification + Phase 3 doc.

Phase 2e shipped two parallel tracks (multi-tier pricing + admin re-extract
UI) on top of the Phase 2d "turn it on" pass. After 2e.B landed, we verified
the full bundle through a Cloudflare quick tunnel and then drafted the
Phase 3 brainstorm doc as the last item in the autonomous "do all in order"
run that started after 2d.

  * 2e.A — Multi-tier pricing (Pro + Premium): migrations/012_pricing_tiers.sql
    (pricing_tiers lookup table seeded with free/pro/premium + active_user_plan
    extended to JOIN tier metadata), services/stripe.js getPlanForUser shape
    extended with planSlug + planRank + planDisplayName (paid alias preserved
    for backward compat), routes/payments.js GET /tiers + POST /checkout
    accepts {tier} body param + 402 body shape gains tier metadata, frontend
    per-tier upgrade buttons via data-action="plan-upgrade" data-arg=<slug>
    (fixed dispatcher convention from data-action-arg → data-arg), 13 new
    test/payments.test.js cases + scripts/test-payments.sh sections 13–17.

  * 2e.B — Admin re-extract UI: routes/admin.js gains ExtractionJobsQuery
    zod schema (status enum locked to migration 009 CHECK constraint) +
    GET /extraction-jobs + GET /extraction-status + POST
    /extraction-jobs/:id/retry + POST /artists/:id/reextract (with
    optional dropFeatures: true), test/admin.test.js +7 hermetic schema
    tests, scripts/test-admin-write.sh sections 17–24, frontend admin.html
    Audio extraction section with 7-card stats grid + filter toolbar +
    7-column jobs table + per-row Retry button + per-artist Re-extract
    button. 34/34 admin tests + 57/57 admin smoke green.

  * Deploy verification — Cloudflare quick tunnel against bundle 3279513,
    pinned-DNS smoke harness (curl --resolve) walked health/auth/payments
    tiers/admin stats/extraction-status/extraction-jobs in 10/10 pass.
    DEPLOY_LOG.md + scripts/test-tunnel-pinned.sh.

  * Phase 3 brainstorm (PHASE_3_BRAINSTORM.md) — candidate tracks
    (insights, distribution, platform expansion, B2B tooling, PWA,
    community), recommended order (3a breakout signals + saved-search
    alerts → 3b AI artist briefs Premium-only/cached → 3c public profile
    pages + shareable compare → 3d optional digest+referral), explicit
    deferrals (TikTok/Spotify to Phase 4, native mobile, community),
    open design questions list.

Adds Build Log + Error Log rows for today's work and collapses any
exact-duplicate today-rows from prior reruns. Safe to run multiple
times — uses an exact-line sentinel match.

Run:
    python3 scripts/log-obsidian-phase-2e.py
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

# ---------------------------------------------------------------------------
# Rows to ensure present.  Each entry is one full markdown table row.
# ---------------------------------------------------------------------------
BUILD_ROWS = [
    # Phase 2e.A — multi-tier pricing
    '| 2026-04-26 | Claude (Cowork) | Phase 2e.A — Multi-tier pricing (Pro + Premium): migrations/012_pricing_tiers.sql adds a pricing_tiers lookup table (slug PK, rank int, displayName, stripe_price_id, purchasable bool) seeded with free/pro/premium + extends active_user_plan to JOIN tier metadata so {planSlug, planRank, planDisplayName} fall out of the same view requirePaid + /api/payments/plan already use; src/services/stripe.js getPlanForUser preserves the legacy {plan:"paid"|"free"} alias alongside the new shape (no breaking change to existing 402 handling); src/routes/payments.js gains GET /tiers (anonymous, returns sorted purchasable tiers) and POST /checkout now accepts a {tier} body param validated against pricing_tiers (400 tier_invalid for unknown, 400 tier_not_purchasable for free); 402 body shape grows tier object {slug, rank, displayName} so the frontend can render per-tier prompts; src/middleware/requirePaid.js threads tier metadata through. Frontend (app.html) per-tier Upgrade buttons via data-action="plan-upgrade" data-arg=<slug>, dispatcher-bug fix: existing convention is data-arg (NOT data-action-arg) at line 1161, fixed line 3273 to match. test/payments.test.js +13 (tiers shape, /tiers anonymous-OK, sorted-by-rank, free/pro/premium present, /checkout accepts/rejects tier values), scripts/test-payments.sh sections 13–17. 113 unit tests + 37 smoke tests green. | src/services/stripe.js, src/routes/payments.js, src/middleware/requirePaid.js, migrations/012_pricing_tiers.sql, test/payments.test.js, scripts/test-payments.sh, ../tx-rapper-tracker/app.html | 0 |',

    # Phase 2e.B — admin re-extract UI
    '| 2026-04-26 | Claude (Cowork) | Phase 2e.B — Admin re-extract UI: src/routes/admin.js exports new ExtractionJobsQuery zod schema (status enum {pending|running|done|failed|skipped} locked to migration 009 CHECK constraint, optional artistId UUID, limit ≤500, offset ≥0) + 4 new endpoints: GET /api/admin/extraction-jobs (paginated job list joined to artist names, sorted COALESCE(finished_at, claimed_at, enqueued_at) DESC), GET /api/admin/extraction-status (single SELECT with subqueries returning {pending, running, done, failed, skipped, failed_24h, features_total} for dashboard stats strip), POST /api/admin/extraction-jobs/:id/retry (NumericIdParam coerce; resets one job to status="pending" attempts=0 last_error=NULL claimed_at=NULL finished_at=NULL enqueued_at=now(); 404 if not found), POST /api/admin/artists/:id/reextract with optional {dropFeatures:bool} body (404 if artist gone, otherwise pulls all track_features rows + calls requeueForReextraction + optionally DELETEs features for a from-scratch re-analysis after analyzer_version bump; emits admin.* audit events). All four endpoints stay 404 to non-admins. test/admin.test.js +7 (defaults, string coercion, status enum coverage incl. unknown rejection, UUID validation, 500-cap), scripts/test-admin-write.sh sections 17–24 (route hiding, list shape, status enum enforcement, status surface 7-field contract, retry 404 + id validation, reextract happy path on temp artist, reextract bogus uuid → 404, bad-body 400). Frontend (admin.html) Audio extraction section with 7-card stats grid + filter toolbar (status defaulting to "failed", limit) + 7-column jobs table with per-row Retry button + per-artist Re-extract button via data-action="artist-reextract" with confirm() prompt and {requeued} count toast. 34/34 admin unit tests + 57/57 admin smoke tests green. | src/routes/admin.js, test/admin.test.js, scripts/test-admin-write.sh, ../tx-rapper-tracker/admin.html | 0 |',

    # Deploy verification (Phase 2d/2e through Cloudflare quick tunnel)
    '| 2026-04-26 | Claude (Cowork) | Deploy verification — Phase 2d + 2e.A + 2e.B end-to-end through Cloudflare quick tunnel against bundle 3279513. cloudflared tunnel --url http://localhost:8787 spun up; smoke harness pinned DNS via curl --resolve (osascript-shell stale-resolver quirk on dev Mac, harmless to native cloudflared); 10/10 sections pass (health, /api/auth/me 401 anon, signup → 201 with cookie, /me with cookie → 200, /api/payments/status, /api/payments/tiers (3 tiers free/pro/premium), admin login + /api/admin/stats, /api/admin/extraction-status (all 7 counters present), /api/admin/extraction-jobs (kind=admin.extraction_jobs), logout). DEPLOY_LOG.md captures the result with the verified commit hash; scripts/test-tunnel-pinned.sh is a drop-in replacement for test-tunnel.sh that reads the trycloudflare URL from /tmp/tx-tunnel.log and pins resolution. Quick-tunnel URLs rotate so the URL itself is throwaway — the bundle hash is the contract. | DEPLOY_LOG.md, scripts/test-tunnel-pinned.sh | 0 |',

    # Phase 3 brainstorm doc
    '| 2026-04-26 | Claude (Cowork) | Phase 3 brainstorm (PHASE_3_BRAINSTORM.md) — candidate tracks laid out with trade-offs: Track A insights that justify Pro/Premium (breakout score/velocity, saved searches + alerts, AI artist briefs cached on (snapshot_id, features_id), custom comparison sets), Track B distribution/growth (public artist profile pages, shareable compare links, weekly digest email, referral via Stripe coupons), Track C platform expansion (TikTok/Spotify/Apple Music — deferred to Phase 4), Track D Pro tooling for B2B (CSV export, API access, bulk ops, white-label PDF reports), Track E PWA polish + push notifications, Track F community (out of scope). Recommended order: 3a breakout signals + saved-search alerts (~2wk) → 3b AI briefs Premium-only (~1wk) → 3c public profiles + shareable compare (~1wk) → 3d optional digest + referral (~1wk). Open design questions list (cron split, Claude prompt cache key, robots.txt policy, mailer cap, coupon shape) keeps the design-pass scope explicit. | PHASE_3_BRAINSTORM.md | 0 |',
]

ERROR_ROWS = [
    # Phase 2e.A specifics
    '| 2026-04-26 | frontend | Frontend dispatcher convention mismatch: Phase 2e.A initially wrote per-tier upgrade buttons with data-action-arg=<slug> but the existing click dispatcher at app.html:1161 reads data-arg (not data-action-arg). Caught at code-review pass; fixed at line 3273. No live-smoke regression because the bug surface is per-button click, but a live click would have been a no-op | Pass — caught pre-smoke |',
    '| 2026-04-26 | backend | scripts/test-payments.sh sections 13–17 cover the new /tiers + tier-aware /checkout + 402 tier shape. Used Python heredoc for tiers shape validation (sorted-by-rank + slug membership + purchasable filter). 37/37 smoke green | Pass |',

    # Phase 2e.B specifics
    '| 2026-04-26 | backend | admin.test.js +7 cases for ExtractionJobsQuery: defaults limit=100 offset=0, string coercion, accepts every CHECK-constraint status (pending|running|done|failed|skipped) and rejects unknown ("queued"), rejects non-uuid artistId, accepts real uuid, caps limit at 500. Locks the contract so a future refactor that drops "skipped" from the enum throws a red unit test rather than a runtime 500 the next time the worker writes that status | Pass |',
    '| 2026-04-26 | backend | First test-admin-write.sh run after Phase 2e.B code-complete: sections 17–24 all returned 404 because the running server was still loading pre-2e.B admin.js. Killed pid + restarted via /tmp/tx-start-server.sh; second run 57/57 green. Lesson: every Phase that adds admin routes needs a server-restart between code change and live smoke | Pass — restart resolved |',

    # Deploy verification
    '| 2026-04-26 | infra | Cloudflare quick tunnel smoke from osascript-shell context: cloudflared registered the tunnel and the trycloudflare hostname resolved via nslookup, but curl in the same shell returned "Could not resolve host" — the AppleScript shell environment uses a different name-service stack than the system resolver. Workaround: dig +short the host out-of-band and pass --resolve $HOST:443:$IP to curl. Native cloudflared and the Mac-side tunnel are unaffected; this is purely a smoke-harness shell quirk. Codified in scripts/test-tunnel-pinned.sh | Pass — workaround in tree |',
    '| 2026-04-26 | sandbox | Claude sandbox cannot reach trycloudflare.com from its own WebFetch path (egress proxy returns 403 on CONNECT). Tunnel verification ran via osascript on the host instead; sandbox restriction is unrelated to the deploy bundle and doesn\'t block any verification path | Pass — N/A |',
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
