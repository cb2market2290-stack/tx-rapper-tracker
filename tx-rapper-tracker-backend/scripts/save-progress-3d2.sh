#!/usr/bin/env bash
# Stage + commit Phase 3d.2 — weekly digest backend (migration +
# service module + routes + cron + 22 unit tests). Frontend modal
# + onboarding empty-state + friendlier error copy will fold into
# 3d.3 since they touch the same app.html surface as the referral UI.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/migrations/017_digest_prefs.sql \
  tx-rapper-tracker-backend/src/services/digest.js \
  tx-rapper-tracker-backend/src/routes/digest.js \
  tx-rapper-tracker-backend/src/index.js \
  tx-rapper-tracker-backend/scripts/send-weekly-digest.js \
  tx-rapper-tracker-backend/test/digest.test.js \
  tx-rapper-tracker-backend/scripts/save-progress-3d2.sh

git commit -m "Phase 3d.2: weekly digest backend (migration + service + routes + cron)

Backend half of the digest feature locked in PHASE_3D_DESIGN.md.
22/22 unit tests pass; route + cron import cleanly. Frontend modal
+ onboarding empty-state will fold into 3d.3 since they share the
app.html edit surface with the referral UI.

* migrations/017_digest_prefs.sql
  Four columns on the existing users table:
  - digest_opted_in BOOLEAN NOT NULL DEFAULT TRUE
    (locked default per design doc)
  - digest_last_sent_at TIMESTAMPTZ — cron gate to prevent
    double-sending mid-Monday
  - digest_last_clicked_at TIMESTAMPTZ — engagement breadcrumb
    (collected for v2 use; not gating anything in v1)
  - digest_unsub_token TEXT — lazy-set on first send; HMAC of
    user_id allows one-click unsub without re-login
  Plus partial index users_digest_due_idx ON
    (digest_last_sent_at NULLS FIRST) WHERE digest_opted_in
  for the cron-s ORDER BY least-recently-sent-first scan.

* src/services/digest.js (new, ~330 lines)
  Pure surface (exported for tests):
  - DIGEST_HOUR_LOCAL (= 9) and DEFAULT_TZ (= America/Chicago)
    locked constants. DEFAULT_TZ used until users.tz exists.
  - isDigestHourFor(user, now) — Intl.DateTimeFormat
    timeZone gate; bad TZ string falls back to default rather
    than failing the cron pass for one bad row.
  - isDueForResend(user, now) — gate on RESEND_AFTER_DAYS = 6.
  - pickTopMovers(rows, n=5) — sort by view_growth_7d desc,
    drop nulls, take top N.
  - pickEmerging(rows, baseCap=5M) — highest pct_growth_7d
    from a base under the cap; null when no one qualifies.
    Skips zero-base junk so a rounding artifact does not
    surface a placeholder.
  - signUnsubToken(userId) — HMAC-SHA256 over -digest:- + userId
    using config.session.secret, base64url, 16 bytes.
    Constant-time verifyUnsubToken to prevent timing leaks.
  - buildDigestPayload({...}) — composes plain-text email with
    subject, top-N movers, optional emerging artist line,
    unsubscribe URL. Returns null when the digest would be
    near-empty (zero movers AND no emerging) — caller skips
    rather than ship a low-content email.

  I/O surface:
  - getUsersDueForDigest — opted-in + email-not-null, ORDER BY
    least-recently-sent-first.
  - recordDigestSent — UPDATE digest_last_sent_at + COALESCE
    digest_unsub_token (lazy-set) on send success.
  - sendDigestForUser — composes via buildDigestPayload, sends
    via the Phase 2b mailer, records the breadcrumb.

* src/routes/digest.js (new, ~200 lines)
  Mounted at /api/digest in src/index.js.
  - GET    /api/digest/preferences         requires session
  - PATCH  /api/digest/preferences         body opted_in (or
                                            optedIn — accept either
                                            for forward-compat with
                                            JSON-camelcase clients)
                                           writes audit_log row
                                           kind=digest.optin_changed
  - GET    /api/digest/preview             admin/dev: returns the
                                           digest payload that would
                                           be sent now. Returns 200
                                           + payload:null + reason
                                           when no_content (zero
                                           movers + no emerging).
  - GET    /api/digest/unsubscribe?u=&t=   public; HMAC-token-gated
                                           one-click unsub. Renders
                                           a small confirmation
                                           HTML page so the click
                                           feels like an action with
                                           feedback. Writes audit_log.

  Inline audit() helper mirrors the routes/auth.js pattern (we
  don-t have a centralized audit module yet; each route inlines its
  own writes). Best-effort: a failed audit write logs but does not
  fail the user-visible flow.

* scripts/send-weekly-digest.js (new, ~110 lines)
  Cron entry. Pulls breakout signals once (matview is artist-scoped,
  not user-scoped — same top-5 to every recipient; user-personalized
  movers based on saved-search artists is a follow-up). Walks
  getUsersDueForDigest, applies isDigestHourFor + isDueForResend
  gates per-user, sends via sendDigestForUser, logs aggregated
  counts. CLI flags: --dry-run (list who would be emailed without
  sending), --force (skip the 09:00-local-time gate), --user
  <email> (filter to one).

  Cron entry suggestion:
    0 6-14 * * 1   /path/to/node send-weekly-digest.js
  (hourly between 06:00 and 14:00 UTC, Mondays only — covers every
  US timezone-s 09:00 local)

* test/digest.test.js (22 tests, all passing)
  isDigestHourFor (4 cases incl. bad TZ fallback);
  DIGEST_HOUR_LOCAL + DEFAULT_TZ constants;
  isDueForResend (3 cases);
  pickTopMovers (3 cases incl. null-row skip + empty-input);
  pickEmerging (4 cases incl. base-cap, zero-base junk, none-qualify);
  signUnsubToken determinism + per-user difference + throws-on-empty;
  verifyUnsubToken accept + reject + bad-input cases;
  buildDigestPayload (3 cases incl. null-on-empty + no-emerging line).

Verification:
  * 22/22 digest tests PASS.
  * 69/69 across slugs + briefs + digest + health-deep.
  * routes/digest.js imports cleanly (mailer init is the only stdout).
  * scripts/send-weekly-digest.js node --check OK.

What 3d.2 deliberately does NOT include (folded into 3d.3 / future):
  * Frontend digest-preferences modal in app.html — bundled with
    the referral modal in 3d.3 since both touch the auth-widget
    header pattern + share the same auth-modal CSS scope.
  * Onboarding empty-state on the dashboard — same reasoning.
  * Friendlier error copy pass — same reasoning.
  * Daily-cron failure alert (would tie into 3.5.3 sendAdminAlert
    — covered there transitively when send-weekly-digest.js is
    wrapped in a cron-failure-mailer in deploy).

Live verify (deferred to user):
  npm run migrate                                      # apply 017
  bash scripts/restart-backend.sh                      # pick up routes
  curl -b cookies.txt /api/digest/preferences          # 200 + opted_in
  curl -X PATCH ... -d {opted_in:false}                # toggles + audits
  node scripts/send-weekly-digest.js --dry-run --force # logs would-send list

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
