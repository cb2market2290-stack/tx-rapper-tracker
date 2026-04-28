#!/usr/bin/env bash
# Restart the launchd-supervised backend (Phase 3.5.1). Convenience
# wrapper around `launchctl kickstart -k`. Use after a code change
# that needs to land in the running process.
#
# If the launchd agent isn't installed yet (= you're still running
# the backend manually from a terminal), the script tells you how to
# install it.

set -euo pipefail

LABEL="com.txrappertracker.backend"
domain="gui/$(id -u)"

if ! launchctl print "${domain}/${LABEL}" >/dev/null 2>&1; then
  cat >&2 <<MSG
${LABEL} is not loaded into launchd.

To install the agent (one-time):
  bash scripts/install-launchd-backend.sh

After that this restart script becomes the canonical "apply code changes"
command and you no longer need a terminal-attached node process.
MSG
  exit 1
fi

echo "Restarting ${LABEL} ..."
launchctl kickstart -k "${domain}/${LABEL}"
echo "  → restarted. Tail logs with:"
echo "      tail -F /tmp/tx-backend.out.log"
