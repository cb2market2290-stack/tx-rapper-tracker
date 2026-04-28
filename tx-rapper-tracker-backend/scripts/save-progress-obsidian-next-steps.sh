#!/usr/bin/env bash
# Stage + commit the Next Steps updater script that refreshed the
# Obsidian vault's roadmap section after Phase 3b closed.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/update-obsidian-next-steps.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-next-steps.sh

git commit -m "Phase 3 docs: refresh Obsidian Next Steps after 3a + 3b close

The '## Next Steps' section in the Obsidian vault was last touched
mid-Phase-2b and still listed Cloudflare Tunnel deploy + 2FA + Phase
2c as 'next.' All of those shipped a long time ago. Refreshed the
section to reflect the post-Phase-3b reality — Phase 3a + 3b are
closed; 3c (public profile pages + shareable compare) is the next
concrete deliverable; 3d (weekly digest + referral) is the optional
follow-on.

* scripts/update-obsidian-next-steps.py
  Idempotent in-place updater. Replaces the entire section between
  '## Next Steps' and the next top-level header (or '---' divider)
  with a fresh block. Re-running the script is a no-op when the
  section already matches.

  New block summarizes shipped items 1-7 (SMTP / Cloudflare deploy /
  2FA / admin UI / Phase 2c / 3a / 3b) as strikethrough-DONE rows so
  the history reads, then surfaces 3c + 3d as the live work, then
  lists explicit deferrals (Phase 4 platform expansion, native mobile
  beyond PWA, community surface).

* scripts/save-progress-obsidian-next-steps.sh
  This commit script. Vault file lives outside the repo so we don't
  commit it; the idempotent updater is what's tracked, so the
  refresh is reproducible.

Run history:
  python3 scripts/update-obsidian-next-steps.py
  → updated: replaced 672 chars with 2752 chars

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
