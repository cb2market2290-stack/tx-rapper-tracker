#!/usr/bin/env python3
"""Idempotent Obsidian log updater for Phase 3d.2 — weekly digest backend.

One Build Log row + one Error Log row. Same plain-string + __DATE__
substitution pattern as the prior phase loggers; safe to re-run.
"""
from pathlib import Path

path = Path.home() / 'Documents' / 'Obsidian Vault' / 'tx-rapper-tracker.md'
text = path.read_text()
lines = text.split('\n')

DATE = '2026-04-28'

BUILD_ROWS = [
    '| __DATE__ | Claude (Cowork) | Phase 3d.2 — Weekly digest backend (migration + service + routes + cron). Backend half of the digest feature locked in PHASE_3D_DESIGN.md; 22/22 unit tests pass. migrations/017_digest_prefs.sql adds 4 columns on users (digest_opted_in BOOLEAN NOT NULL DEFAULT TRUE per locked design, digest_last_sent_at TIMESTAMPTZ as the cron mid-Monday-double-send gate, digest_last_clicked_at engagement breadcrumb for v2, digest_unsub_token TEXT lazy-set on first send) + partial index users_digest_due_idx ON (digest_last_sent_at NULLS FIRST) WHERE digest_opted_in for the cron-s least-recently-sent-first scan. src/services/digest.js (~330 lines) exports pure helpers — DIGEST_HOUR_LOCAL=9 + DEFAULT_TZ=America/Chicago locked constants, isDigestHourFor (Intl.DateTimeFormat timeZone gate; bad-TZ fallback), isDueForResend (RESEND_AFTER_DAYS=6), pickTopMovers (sort by view_growth_7d desc, drop nulls, top 5), pickEmerging (highest pct_growth_7d from base under 5M; skips zero-base junk; null when none qualify), signUnsubToken (HMAC-SHA256 over digest:userId with config.session.secret, base64url, 16 bytes), constant-time verifyUnsubToken, buildDigestPayload (returns null when zero movers AND no emerging — caller skips rather than ship low-content email). I/O surface: getUsersDueForDigest, recordDigestSent, sendDigestForUser composing payload + mailer + breadcrumb. src/routes/digest.js (~200 lines) mounted at /api/digest exposes GET/PATCH /preferences (requires session, audits digest.optin_changed), GET /preview (admin/dev, returns 200+payload:null on no_content rather than error), GET /unsubscribe?u=&t= (public, HMAC-token-gated, renders confirmation HTML page so click feels like an action with feedback, audits digest.unsubscribed). Inline audit() helper mirrors the routes/auth.js pattern (no central audit module yet). scripts/send-weekly-digest.js cron entry pulls breakout signals once (matview is artist-scoped — same top-5 to every recipient; user-personalized movers a follow-up), walks getUsersDueForDigest, applies isDigestHourFor + isDueForResend gates per-user, sends + records breadcrumb, logs aggregated counts. CLI flags: --dry-run, --force (skip 09:00 gate), --user <email>. Suggested cron: 0 6-14 * * 1 (hourly between 06:00 and 14:00 UTC, Mondays only — covers every US TZ-s 09:00 local). 22/22 digest tests + 69/69 across slugs+briefs+digest+health-deep PASS. Frontend modal + onboarding empty-state + friendlier error copy deliberately deferred to 3d.3 since they share app.html edit surface with the referral UI. | migrations/017_digest_prefs.sql, src/services/digest.js, src/routes/digest.js, src/index.js, scripts/send-weekly-digest.js, test/digest.test.js, scripts/save-progress-3d2.sh | 0 |',
]

ERROR_ROWS = [
    '| __DATE__ | backend | routes/digest.js initially imported writeAuditEvent from src/auth/audit.js but no centralized audit module exists in this codebase — every route inlines INSERT INTO audit_log. Fixed by inlining the same audit() helper that routes/auth.js uses (best-effort try/catch around the INSERT; audit failure logs but does not fail the user-visible flow). Spotted via grep before the route was loaded; would have failed import at module load. Pattern carried forward — until a central audit module exists, new routes inline the helper from routes/auth.js. | Pass — fix in tree |',
    '| __DATE__ | backend | users table has no tz column in v1 (collecting timezone at signup is a future change). isDigestHourFor falls back to DEFAULT_TZ (America/Chicago) for every user; getUsersDueForDigest still returns the tz field in its row shape (always null for now) so the rest of the pipeline does not have to special-case the future where we collect it. The tz-fallback path is exercised by a unit test (isDigestHourFor with tz:null at 14:00 UTC returns true == 09:00 CDT). | Pass — design choice |',
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

# Dedupe today-rows
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
