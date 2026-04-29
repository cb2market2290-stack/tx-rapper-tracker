#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phase 3.5.2-3.5.4 + Phase 3d.1.

Picks up where log-obsidian-phase-3c.py left off (which covered Phase
3c + the 3.5 design + 3.5.1). Adds rows for the rest of the hardening
pass + the 3d.1 design doc:

  * 3.5.2 — CSP nonce migration (drop 'unsafe-inline')
  * 3.5.3 — cron failure alerting (stale data + aux failures)
  * 3.5.4 — GET /api/health/deep composite freshness
  * 3d.1  — design doc for weekly digest + referral program

Same shape as the prior phase-3 loggers: plain strings with a
__DATE__ placeholder substituted at runtime, ensure_row inserts under
'## Build Log' or '## Error Log' only on miss, dedupe pass at end.
Safe to re-run.

Run:
    python3 scripts/log-obsidian-phase-3-5-and-3d1.py
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

BUILD_ROWS = [
    # ── Phase 3.5.2 — CSP nonce migration ───────────────────────────────
    '| __DATE__ | Claude (Cowork) | Phase 3.5.2 — CSP nonce migration. Closes the TODO that lived in middleware/security.js since Phase 2a. Inline <script> + <style> blocks in app.html, admin.html, and the public-page templates now ride a per-request nonce; "unsafe-inline" is gone from script-src and style-src. New cspNonce() middleware generates 16 random bytes per request as base64url (22 chars), stores on res.locals.cspNonce, must run BEFORE securityHeaders(). securityHeaders directives are now callable values ((req, res) => "nonce-${res.locals.cspNonce}") that helmet re-evaluates per request so the header always carries the fresh nonce. cdnjs.cloudflare.com remains allowed by URL for Chart.js. Static-html serving moved off res.sendFile to readFileSync at startup + per-request String.replaceAll("__CSP_NONCE__", nonce) — cache-once-at-startup keeps things fast (the launchd backend restarts on every code change, so the cache is naturally invalidated). routes/public.js#pageShell takes a cspNonce arg and emits nonce= attrs on its inline <style> + JSON-island <script>; the two render fns plumb cspNonce through; route handlers source the nonce from res.locals.cspNonce. app.html line 8 + 1261 and admin.html line 7 + 147 carry nonce="__CSP_NONCE__". External Chart.js <script src=cdnjs...> stays unchanged. All 45 unit tests still pass. DOM-injected scripts (XSS) without the right nonce are now blocked at the browser level. | src/middleware/security.js, src/index.js, src/routes/public.js, ../tx-rapper-tracker/app.html, ../tx-rapper-tracker/admin.html, scripts/save-progress-3-5-2.sh | 0 |',

    # ── Phase 3.5.3 — cron failure alerting ─────────────────────────────
    '| __DATE__ | Claude (Cowork) | Phase 3.5.3 — Cron failure alerting via the existing Phase 2b mailer. Closes three silent-failure modes that were just writing logger.warn lines nobody reads. (1) Run reports status=ok but MAX(captured_on) > 36h ago — two cron passes both no-op-d, YouTube quota exhausted, roster mismatch. (2) breakout_signals matview refresh fails — saved-search alerts + dashboard movers strip read yesterday-s deltas the rest of the day. (3) saved-search evaluator fails — a paid feature silently does nothing. New sendAdminAlert({subject, lines}) generic helper sends one email per recipient with try/catch around the send so an SMTP blip never tanks the snapshot run. New alertOnStaleSnapshots(startedAt) called when status === ok queries MAX(captured_on) + age_hours via EXTRACT(EPOCH FROM (now() - MAX)) and fires when age > 36h with a body explaining likely causes (YouTube auth/quota, roster mismatch); skips when there are zero snapshots ever (first-run state shouldn-t false-alarm). The breakout-refresh + savedsearch-evaluator try/catch blocks now also call sendAdminAlert on error, still wrapped in try/catch so a mailer failure does not cascade. logger.warn lines retained for log-aggregation ingestion. node --check passes. Best-effort throughout — none of the alert paths can throw out of main(). | scripts/snapshot-stats.js, scripts/save-progress-3-5-3.sh | 0 |',

    # ── Phase 3.5.4 — GET /api/health/deep ──────────────────────────────
    '| __DATE__ | Claude (Cowork) | Phase 3.5.4 — GET /api/health/deep composite freshness check. Closes Phase 3.5 end-to-end (4/4 hardening items). Single endpoint that says yes-or-no the system is alive AND fresh, not just that the HTTP server is answering. Wires to two consumers: external uptime monitor (UptimeRobot / Better Stack / Cloudflare Health Checks) and a launchd-side cron-of-last-resort that pages on non-200. Public + un-authenticated by design (no PII, no enumeration); mounted under /api/* so the existing rate limiter applies. Four parallel checks via Promise.all (max wall-clock = slowest, not sum): db (SELECT 1 raced against a 1s timeout — pool exhaustion fails fast rather than hanging the health check itself), snapshot_fresh (MAX(captured_on) ≤ 26h; daily cron 04:00 + 26h = one full miss + 2h slack; empty-state reports applicable=false and passes), extract_fresh (MAX(extracted_at) ≤ 7d; opt-in per artist; empty-state passes), briefs_configured (only when config.briefs.enabled = true; reports applicable=false when feature is OFF, same posture as Stripe disabled in dev). 200 on green, 503 on any red with a "failed" array of which-check-keys-failed. test/health-deep.test.js +2 (default export is an Express router with non-empty layer stack; router contains the three expected paths /health, /ready, /api/health/deep). DB-touching paths exercised by manual verify against live Postgres. | src/routes/health.js, test/health-deep.test.js, scripts/save-progress-3-5-4.sh | 0 |',

    # ── Phase 3d.1 — design + decisions ─────────────────────────────────
    '| __DATE__ | Claude (Cowork) | Phase 3d.1 — design + decisions for weekly digest + referral program (PHASE_3D_DESIGN.md). Locks user-facing contracts before code: cadence, opt-in mechanics, coupon shape. Surface — digest: GET/PATCH /api/digest/preferences, GET /api/digest/preview (admin/dev), GET /api/digest/unsubscribe?token (one-click HMAC unsub no-relogin), scripts/send-weekly-digest.js cron. Surface — referral: GET /api/referrals/me (token + link + stats), POST /api/referrals/click (anon, idempotent within 24h same-IP), signup wiring (?ref=<token> cookie -> users.referrer_token), checkout webhook hook (issue Stripe coupon when referred user converts to paid). Cadence: weekly Mondays 09:00 user-local TZ (cron runs hourly 06:00-14:00 UTC, per-user gate is "is it 09:00 locally AND have we already sent this Monday"); default America/Chicago for users without TZ set. Content: plain-text v1, top-5 movers + 1 emerging-artist (highest pct growth from base under 5M lifetime views); HTML email deferred until click-through justifies DKIM/DMARC work. Default opt-in (digest_opted_in DEFAULT TRUE) — the digest IS the funnel back into the app for free-tier users. Mailer cap: one digest per user per Monday gated by users.digest_last_sent_at via SELECT FOR UPDATE; per-user max 4 emails per week across all channels. Token: 8 random bytes -> 12 chars base64url, stable per-user, never auto-rotates, backfilled lazily on first GET /me. Coupon shape: Stripe one-shot fixed amount_off in cents (= 1-month Pro), max_redemptions=1, redeem_by 30d, metadata carries referrer + referred IDs. Fixed-amount preferred over pct so pricing changes do not drift the payout. Issued via existing checkout.session.completed webhook with INSERT INTO referral_coupons ON CONFLICT (referred_user_id) DO NOTHING — Stripe re-deliveries are no-ops. Self-referral rejected (referrer === referred); same-IP guard 3-signups-per-24h disables coupons for that IP for 7d. Migration shapes locked: 017_digest_prefs.sql (ALTER users + partial index), 018_referrals.sql (referrals + referral_clicks + referral_coupons + users.referrer_token). Frontend additions for 3d.2/3d.3: Email-preferences modal, Refer-a-friend button + modal, onboarding empty-state on signed-in dashboard with zero saved searches, friendlier error copy pass through app.html (both bundled in 3d.2-3d.3 not separate phases). Closes brainstorm open Q4 (mailer cap) + Q5 (coupon shape) and adds 4 new locked Qs (cadence + send hour, default opt-in posture, token entropy, self-referral guard). Out of scope: HTML email, custom digest content, referral leaderboard, multi-tier coupons, email-domain anti-fraud. | PHASE_3D_DESIGN.md, scripts/save-progress-3d1.sh | 0 |',
]

ERROR_ROWS = [
    '| __DATE__ | infra | save-progress-3-5-3.sh initial run failed because the heredoc commit message contained nested double-quote phrases (e.g. "the snapshot run itself failed"). Bash split the commit message at those quotes; git interpreted the suffixes as separate pathspecs (pathspec snapshot did not match, pathspec run did not match, pathspec itself did not match). Fix: rewrite the message body to avoid double-quoted phrases, swap status≠ok arrow to "is not ok", swap unicode arrows for plain "->" for safety. Pattern carried forward — every save-progress-*.sh commit message uses single-quote phrasing for emphasis since the message itself is wrapped in double quotes. | Pass — fix in tree |',

    '| __DATE__ | backend | CSP nonce wiring threads nonce all the way from middleware to inline tags. cspNonce() middleware MUST run before securityHeaders() — if it does not, res.locals.cspNonce is undefined when helmet builds the header. Confirmed by import-smoke + 45/45 unit tests. The static-html sendFile path was the trickiest part — readFileSync once at startup keeps the request hot path fast (no per-request file I/O) but means a content change to app.html / admin.html requires a backend restart to take effect. With the 3.5.1 launchd supervisor in place restart is one bash scripts/restart-backend.sh away, so the tradeoff is fine. | Pass — design choice, documented |',

    '| __DATE__ | backend | /api/health/deep checkDb races SELECT 1 against a 1s timeout via Promise.race. Without the timeout a wedged DB connection would hang the health check itself, defeating the whole point of having one. 1s is comfortably above normal SELECT 1 latency (sub-5ms in practice) and well below the 5-min cron-of-last-resort interval, so a temporary DB blip does not cascade into a flap-storm of admin emails. Same-pattern timeout could be added to the snapshot/extract freshness checks if they ever start blocking; current sub-millisecond behavior makes it unnecessary. | Pass — design |',
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

# Dedupe: collapse exact-duplicate today-rows from prior reruns.
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
