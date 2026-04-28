#!/usr/bin/env bash
# Tiny one-shot — run npm test and tail the summary. Used by Claude
# during development to confirm the full test suite passes after a
# change. Not part of any release path.

set -uo pipefail
# osascript runs a non-login shell — npm/node aren't on PATH. Bootstrap.
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
[ -s "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null 2>&1 || true
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Run all *.test.js. Filter to the summary lines + any "not ok" failures.
node --test test/*.test.js 2>&1 | awk '
/^# tests/ || /^# pass/ || /^# fail/ || /^# duration/ { print; next }
/^not ok/ { print; next }
/^# Subtest:.*$/ { last_subtest = $0; next }
END { exit 0 }
'
