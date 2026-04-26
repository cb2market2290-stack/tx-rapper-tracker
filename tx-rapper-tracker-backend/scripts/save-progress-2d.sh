#!/usr/bin/env bash
# Idempotent save-progress for Phase 2d.
#
# What this commits (everything that's piled up on top of the Phase 2c commit):
#   * Phase 2d.A — Stripe Checkout + Customer Portal + paid-tier gating
#     (migration 011, services/stripe extended, routes/payments adds
#     /checkout + /portal + /plan, middleware/requirePaid 402-gates
#     /api/artists/:id/features, frontend plan-pill + Upgrade CTA + 402
#     handling, test/stripe.test.js + scripts/test-payments.sh extended)
#   * Phase 2d.B — long-running audio worker + analyzer_version-driven
#     re-extraction (scripts/run-extract-worker.sh,
#     scripts/install-launchd-extract.sh, services/features +
#     enqueue-features.js extended, test/features.test.js extended)
#   * Phase 2d docs — README rewrite, BUILD_LOG_ENTRY.md prepended,
#     scripts/log-obsidian-phase-2d.py + this script.
#
# Obsidian Build Log is NOT touched here — run scripts/log-obsidian-phase-2d.py
# separately (it writes to ~/Documents/Obsidian Vault/ on this machine).
#
# Run from any cwd:
#   bash tx-rapper-tracker-backend/scripts/save-progress-2d.sh

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
backend_root=$(cd "$script_dir/.." && pwd)
parent=$(cd "$backend_root/.." && pwd)
frontend_root="$parent/tx-rapper-tracker"

if [[ ! -d "$frontend_root" ]]; then
  echo "error: expected frontend at $frontend_root" >&2
  exit 1
fi

cd "$parent"

# Clean any stale lock left over from a previous half-run / sandbox quirk.
if [[ -f .git/index.lock ]]; then
  echo "note: stale .git/index.lock present; removing"
  rm -f .git/index.lock || true
fi

# Stage explicitly — never `git add -A`. Avoids accidentally committing
# .env, node_modules, sibling projects, Python __pycache__, etc.

# Frontend
git add tx-rapper-tracker/app.html
git add tx-rapper-tracker/admin.html

# Backend platform code + docs
git add tx-rapper-tracker-backend/.env.example
git add tx-rapper-tracker-backend/.env.production.example 2>/dev/null || true
git add tx-rapper-tracker-backend/.gitignore
git add tx-rapper-tracker-backend/package.json
git add tx-rapper-tracker-backend/package-lock.json
git add tx-rapper-tracker-backend/README.md
git add tx-rapper-tracker-backend/BUILD_LOG_ENTRY.md
git add tx-rapper-tracker-backend/DEPLOY.md 2>/dev/null || true
git add tx-rapper-tracker-backend/INTEGRATION.md 2>/dev/null || true
git add tx-rapper-tracker-backend/TASK.md 2>/dev/null || true

# Backend src/ (whole tree — explicit subdirs so a new top-level src dir
# doesn't get auto-included).
git add tx-rapper-tracker-backend/src/config.js
git add tx-rapper-tracker-backend/src/index.js
git add tx-rapper-tracker-backend/src/auth/
git add tx-rapper-tracker-backend/src/db/
git add tx-rapper-tracker-backend/src/lib/
git add tx-rapper-tracker-backend/src/middleware/
git add tx-rapper-tracker-backend/src/routes/
git add tx-rapper-tracker-backend/src/services/

# Migrations 001..011
git add tx-rapper-tracker-backend/migrations/

# Tests
git add tx-rapper-tracker-backend/test/

# Scripts (explicit list — skips __pycache__ and any half-baked file).
git add tx-rapper-tracker-backend/scripts/auth-smoke.sh
git add tx-rapper-tracker-backend/scripts/check-prod-ready.js
git add tx-rapper-tracker-backend/scripts/dedupe-obsidian-phase-2b10.py
git add tx-rapper-tracker-backend/scripts/enqueue-features.js
git add tx-rapper-tracker-backend/scripts/extract-features.py
git add tx-rapper-tracker-backend/scripts/install-launchd-extract.sh
git add tx-rapper-tracker-backend/scripts/install-launchd-snapshot.sh
git add tx-rapper-tracker-backend/scripts/log-obsidian-errorlog.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b5-7.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b8.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b9.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b10.py 2>/dev/null || true
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b11-12.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2c.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2d.py
git add tx-rapper-tracker-backend/scripts/restart-server.sh
git add tx-rapper-tracker-backend/scripts/run-all-tests.sh
git add tx-rapper-tracker-backend/scripts/run-extract-worker.sh
git add tx-rapper-tracker-backend/scripts/save-progress.sh
git add tx-rapper-tracker-backend/scripts/save-progress-2c.sh
git add tx-rapper-tracker-backend/scripts/save-progress-2d.sh
git add tx-rapper-tracker-backend/scripts/snapshot-stats.js
git add tx-rapper-tracker-backend/scripts/test-2fa.sh
git add tx-rapper-tracker-backend/scripts/test-admin-write.sh
git add tx-rapper-tracker-backend/scripts/test-admin.sh
git add tx-rapper-tracker-backend/scripts/test-features.sh
git add tx-rapper-tracker-backend/scripts/test-payments.sh
git add tx-rapper-tracker-backend/scripts/test-policy.sh
git add tx-rapper-tracker-backend/scripts/test-reset.sh
git add tx-rapper-tracker-backend/scripts/test-tunnel.sh
git add tx-rapper-tracker-backend/scripts/test-webauthn.sh

# Repo-root .gitignore (catches .env etc.)
git add .gitignore

# Sanity: refuse to commit .env (defense-in-depth — gitignore should
# already block).
if git diff --cached --name-only | grep -E '(^|/)\.env$' >/dev/null; then
  echo "error: .env is staged — aborting." >&2
  git reset HEAD -- '*.env' || true
  exit 1
fi

if git diff --cached --quiet; then
  echo "no staged changes — nothing to commit"
else
  today=$(date +%Y-%m-%d)
  git commit -m "$(cat <<EOF
${today}: Phases 2b.13 + 2b.14 + 2c + 2d — TOTP + WebAuthn + audio + Stripe Checkout

This commit collapses the entire chain of phases that landed since the
last live commit (5056524). Each phase is self-contained but they were
never individually committed; this brings the tree back in sync.

Phase 2b.13 (TOTP 2FA)
- migrations/007_totp.sql: user_totp + recovery_codes
- src/auth/totp.js (RFC-6238 + AES-256-GCM secret-at-rest)
- src/auth/recovery.js (10 single-use hashed codes)
- src/routes/twofactor.js (/enroll, /enroll/verify, /verify, /disable)
- src/middleware/authenticate.js: pre_2fa cookie path
- ../tx-rapper-tracker/app.html: enroll modal + sign-in step
- scripts/test-2fa.sh + test/totp.test.js

Phase 2b.14 (WebAuthn / passkeys)
- migrations/008_webauthn.sql: webauthn_credentials + webauthn_challenges
- src/auth/webauthn.js + src/routes/webauthn.js
- WEBAUTHN_RP_ID/RP_NAME/ORIGINS in config + .env.example
- ../tx-rapper-tracker/app.html: "Add a passkey" + sign-in branch
- scripts/test-webauthn.sh + test/webauthn.test.js

Phase 2c (audio features + Stripe scaffolding)
- migrations/009_track_features.sql + 010_stripe_payments.sql
- scripts/extract-features.py (yt-dlp + librosa)
- scripts/enqueue-features.js
- src/services/features.js + src/services/stripe.js (receiver-only)
- src/routes/artists.js GET /:id/features + src/routes/payments.js webhook
- ../tx-rapper-tracker/app.html: audio panel + ranking featureBonus×5
- 18 features.test.js + 13 stripe.test.js + smoke scripts

Phase 2d.A (Stripe Checkout + Customer Portal + paid-tier gating)
- migrations/011_checkout_sessions.sql: audit table + active_user_plan view
- src/services/stripe.js: createCheckoutSessionForUser + createPortalSession
  + shapeCheckoutSession + recordCheckoutSession + getPlanForUser
- src/routes/payments.js: POST /checkout, POST /portal, GET /plan
  (behind requireUser; 503 when stripe disabled). Webhook dispatches
  checkout.session.completed + invoice.paid + invoice.payment_failed
- src/middleware/requirePaid.js: 402-gate keyed on active_user_plan
- src/routes/artists.js: requirePaid() on GET /:id/features
- src/index.js: hoisted cookieParser + attachUser ABOVE the /api/payments
  mount (live-smoke caught: requireUser could not see req.user inside the
  payments router otherwise). Webhook still uses route-level express.raw()
- ../tx-rapper-tracker/app.html: plan-pill + .feat-gate Upgrade card +
  loadPlan() + 402 throw-with-status + ?checkout=success poll-and-flip
- test/stripe.test.js: 13→24
- scripts/test-payments.sh: extended sections 5-12 + accept HTTP 201 from signup

Phase 2d.B (long-running audio worker + analyzer_version re-extraction)
- scripts/run-extract-worker.sh: drain-and-sleep loop + SIGTERM trap
- scripts/install-launchd-extract.sh: com.txrappertracker.extract LaunchAgent
- src/services/features.js: getStaleVideoIds + requeueForReextraction
- scripts/enqueue-features.js: --reextract VERSION + --limit N
- test/features.test.js: 18→21

Phase 2d docs + ops
- README.md: rewritten through Phase 2d
- BUILD_LOG_ENTRY.md: Phase 2c + Phase 2d blocks
- scripts/log-obsidian-phase-2{c,d}.py + scripts/save-progress-2{c,d}.sh

Live verification (executed before this commit on a real Mac)
- npm run migrate: 008..011 applied to local Postgres
- node --test stripe.test.js features.test.js: 45/45 pass
- bash scripts/test-payments.sh: 26/26 pass after middleware-order fix
EOF
)"
  echo "committed."
fi

# Push if a remote is configured.
if git remote | grep -q .; then
  remote=$(git remote | head -n1)
  branch=$(git rev-parse --abbrev-ref HEAD)
  echo "pushing to $remote/$branch ..."
  git push -u "$remote" "$branch"
else
  echo "no git remote configured — skipping push"
fi
