#!/usr/bin/env bash
# Idempotent save-progress helper: commits today's frontend changes and
# (if a remote is configured) pushes. Run from EITHER project root:
#   ./scripts/save-progress.sh
#   ../tx-rapper-tracker-backend/scripts/save-progress.sh
#
# What it commits:
#   - tx-rapper-tracker/app.html          (detail view + CSP sweep + save-to-roster + compare mode + auto-drill)
#   - tx-rapper-tracker-backend/scripts/  (log-obsidian-phase-2b10.py, save-progress.sh itself)
#
# Obsidian Build Log is NOT touched here - run log-obsidian-phase-2b10.py
# separately (it writes to ~/Documents/Obsidian Vault/ on this machine).

set -euo pipefail

# Resolve both project paths relative to this script's location so it works
# from any cwd.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
backend_root=$(cd "$script_dir/.." && pwd)
parent=$(cd "$backend_root/.." && pwd)
frontend_root="$parent/tx-rapper-tracker"

if [[ ! -d "$frontend_root" ]]; then
  echo "error: expected frontend at $frontend_root" >&2
  exit 1
fi

# Git root lives at the parent containing both projects. Init if missing so
# the script is safe to run on a fresh clone/checkout.
cd "$parent"
if [[ ! -d .git ]]; then
  echo "note: no git repo at $parent - initializing"
  git init -q
  # Sensible default ignores for this monorepo.
  if [[ ! -f .gitignore ]]; then
    cat > .gitignore <<'EOF'
# node
node_modules/
# secrets
.env
.env.local
.env.*.local
# backups
*.pre-proxy-backup
EOF
  fi
fi

# Stage only the files we know about today (no -A: avoids accidentally
# committing .env, node_modules, or the bitrue/cmc sibling projects).
git add tx-rapper-tracker/app.html
git add tx-rapper-tracker-backend/scripts/log-obsidian-phase-2b10.py
git add tx-rapper-tracker-backend/scripts/save-progress.sh

if git diff --cached --quiet; then
  echo "no staged changes - nothing to commit"
else
  today=$(date +%Y-%m-%d)
  git commit -m "frontend $today: Phase 2b.10 + 2b.11 — detail view, CSP sweep, save-to-roster, compare mode, auto-drill

- app.html: data-action dispatcher (13 inline onclicks swapped for CSP compliance)
- app.html: artist detail page (#/artist/<name>), 12-month chart via /api/stats/history
- app.html: + Save button on custom-search cards (POST /api/admin/artists)
- app.html: compare mode — pick up to 5 artists, overlay via Promise.all over /api/stats/history
- app.html: auto-drill to detail view after custom search adds an artist
- scripts/log-obsidian-phase-2b10.py: idempotent Build+Error log rows"
  echo "committed."
fi

# Push if a remote is configured.
if git remote | grep -q .; then
  remote=$(git remote | head -n1)
  branch=$(git rev-parse --abbrev-ref HEAD)
  echo "pushing to $remote/$branch ..."
  git push -u "$remote" "$branch"
else
  echo "no git remote configured - skipping push"
  echo "  to add one later:  git -C '$parent' remote add origin <url> && git -C '$parent' push -u origin main"
fi
