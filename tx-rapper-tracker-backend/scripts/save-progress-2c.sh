#!/usr/bin/env bash
# Idempotent save-progress for Phase 2b.13 → 2c.
#
# What this commits (everything that's piled up since 5056524 on 2026-04-24):
#   * Phase 2b.13 — TOTP 2FA (auth/totp + recovery, routes/twofactor,
#     migration 007, frontend enroll + login step, smoke + tests)
#   * Phase 2b.14 — WebAuthn / passkeys (auth/webauthn, routes/webauthn,
#     migration 008, frontend register + sign-in, smoke + tests)
#   * Phase 2c.1 — audio features (services/features, routes/artists feature
#     endpoint, scripts/extract-features.py + enqueue-features.js,
#     migration 009, frontend audio panel + score bonus, smoke + tests)
#   * Phase 2c.2 — Stripe scaffolding (services/stripe, routes/payments,
#     migration 010, config wiring, smoke + tests)
#   * Phase 2c docs — README + BUILD_LOG_ENTRY rewrites + this script +
#     log-obsidian-phase-2c.py
#
# Obsidian Build Log is NOT touched here — run scripts/log-obsidian-phase-2c.py
# separately (it writes to ~/Documents/Obsidian Vault/ on this machine).
#
# Run from any cwd:
#   bash tx-rapper-tracker-backend/scripts/save-progress-2c.sh

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
# .env, node_modules, sibling projects (bitrue-analyzer/, cmc-analyzer/),
# Python __pycache__, etc. Each line is a relative path from $parent.
git add tx-rapper-tracker/app.html
git add tx-rapper-tracker/admin.html

# Backend platform code
git add tx-rapper-tracker-backend/.env.example
git add tx-rapper-tracker-backend/.env.production.example
git add tx-rapper-tracker-backend/.gitignore
git add tx-rapper-tracker-backend/package.json
git add tx-rapper-tracker-backend/package-lock.json
git add tx-rapper-tracker-backend/README.md
git add tx-rapper-tracker-backend/BUILD_LOG_ENTRY.md
git add tx-rapper-tracker-backend/DEPLOY.md
git add tx-rapper-tracker-backend/INTEGRATION.md
git add tx-rapper-tracker-backend/TASK.md

# Backend src/
git add tx-rapper-tracker-backend/src/config.js
git add tx-rapper-tracker-backend/src/index.js
git add tx-rapper-tracker-backend/src/auth/
git add tx-rapper-tracker-backend/src/db/
git add tx-rapper-tracker-backend/src/lib/
git add tx-rapper-tracker-backend/src/middleware/
git add tx-rapper-tracker-backend/src/routes/
git add tx-rapper-tracker-backend/src/services/

# Migrations 001..010
git add tx-rapper-tracker-backend/migrations/

# Tests
git add tx-rapper-tracker-backend/test/

# Scripts (excluding __pycache__)
git add tx-rapper-tracker-backend/scripts/auth-smoke.sh
git add tx-rapper-tracker-backend/scripts/check-prod-ready.js
git add tx-rapper-tracker-backend/scripts/dedupe-obsidian-phase-2b10.py
git add tx-rapper-tracker-backend/scripts/enqueue-features.js
git add tx-rapper-tracker-backend/scripts/extract-features.py
git add tx-rapper-tracker-backend/scripts/install-launchd-snapshot.sh
git add tx-rapper-tracker-backend/scripts/log-obsidian-errorlog.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b5-7.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b8.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b9.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b10.py 2>/dev/null || true
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b11-12.py
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2c.py
git add tx-rapper-tracker-backend/scripts/restart-server.sh
git add tx-rapper-tracker-backend/scripts/run-all-tests.sh
git add tx-rapper-tracker-backend/scripts/save-progress.sh
git add tx-rapper-tracker-backend/scripts/save-progress-2c.sh
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

# Frontend extras
git add tx-rapper-tracker/run_model.py 2>/dev/null || true
git add tx-rapper-tracker/update_obsidian.py 2>/dev/null || true

# Repo-root .gitignore (catches .env etc.)
git add .gitignore

# Sanity: refuse to commit .env (defense-in-depth — gitignore should already block).
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
${today}: Phase 2b.13 + 2b.14 + 2c — TOTP, WebAuthn, audio features, Stripe scaffolding

Phase 2b.13 (TOTP 2FA)
- migrations/007_totp.sql: user_totp + recovery_codes
- src/auth/totp.js: RFC-6238 + AES-256-GCM secret-at-rest
- src/auth/recovery.js: 10 single-use hashed recovery codes
- src/routes/twofactor.js: enroll, enroll/verify, verify, disable
- src/middleware/authenticate.js: pre_2fa cookie path
- app.html: enroll modal + login 2fa step
- scripts/test-2fa.sh, test/totp.test.js

Phase 2b.14 (WebAuthn / passkeys)
- migrations/008_webauthn.sql: webauthn_credentials + challenges (TTL)
- src/auth/webauthn.js: @simplewebauthn/server-backed register + verify
- src/routes/webauthn.js: register options/verify + authenticate options/verify
- config: WEBAUTHN_RP_ID/RP_NAME/ORIGINS
- app.html: passkey register + sign-in branch
- scripts/test-webauthn.sh, test/webauthn.test.js

Phase 2c.1 (Audio features)
- migrations/009_track_features.sql: track_features + track_extraction_jobs
- scripts/extract-features.py: yt-dlp + librosa worker, Krumhansl-Schmuckler
- scripts/enqueue-features.js: seed jobs from artist uploads
- src/services/features.js: cleanRow + dominantKey + aggregate (pure)
- src/routes/artists.js: GET /api/artists/:id/features
- ../tx-rapper-tracker/app.html: Audio features panel + featureBonus×5 in score
- test/features.test.js (18 tests), scripts/test-features.sh
- Bug fix: drop null BEFORE Number() to prevent phantom-zero averaging

Phase 2c.2 (Stripe scaffolding — receiver-only, safe-off)
- migrations/010_stripe_payments.sql: stripe_customers + subscriptions + webhook_events
- src/services/stripe.js: lazy SDK import + pure shapers + DB writers
- src/routes/payments.js: buildRouter() so index.js mounts express.raw at route
  ahead of global express.json (Stripe signs raw bytes)
- POST /webhook: 503 disabled, 400 missing/invalid sig, idempotent on event.id
- GET /payments/status: diagnostic
- src/config.js + .env.example: STRIPE_* env, redacted() masking
- test/stripe.test.js (13 tests), scripts/test-payments.sh

Phase 2c docs + polish
- README.md: rewritten through Phase 2c (endpoints, prereqs, layout)
- BUILD_LOG_ENTRY.md: prepended Phase 2c row
- scripts/log-obsidian-phase-2c.py + scripts/save-progress-2c.sh
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
