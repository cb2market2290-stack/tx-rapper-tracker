#!/usr/bin/env bash
# Install a launchd agent that runs scripts/snapshot-stats.js every day at 04:00.
# Idempotent: safe to re-run - unloads any existing version before reinstall.
#
# Why launchd instead of cron? Two reasons:
#   1. launchd is the supported, supervised path on modern macOS.
#   2. It runs even if you skipped 04:00 while asleep - launchd wakes the
#      job on the next login instead of just missing the window.
#
# Logs:  /tmp/snapshot-stats.out.log  (stdout)
#        /tmp/snapshot-stats.err.log  (stderr)
# Label: com.txrappertracker.snapshot  (see launchctl list | grep tx)

set -euo pipefail

LABEL="com.txrappertracker.snapshot"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

backend_root=$(cd "$(dirname "$0")/.." && pwd)
node_bin=$(command -v node || true)
if [[ -z "$node_bin" ]]; then
  # Fallback: try to resolve nvm's current version (nvm shims aren't on
  # launchd's PATH, so we pick up the absolute binary path once here).
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
    node_bin=$(command -v node || true)
  fi
fi
if [[ -z "$node_bin" ]]; then
  echo "error: node binary not found on PATH; install node or edit this script" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node_bin}</string>
        <string>${backend_root}/scripts/snapshot-stats.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${backend_root}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>4</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/snapshot-stats.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/snapshot-stats.err.log</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF

# Unload a previous version (ignore "not loaded" errors) then reload.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "installed:"
echo "  plist: $PLIST"
echo "  node:  $node_bin"
echo "  cwd:   $backend_root"
echo "  when:  daily at 04:00 local time"
echo
echo "verify:  launchctl list | grep ${LABEL}"
echo "logs:    tail /tmp/snapshot-stats.out.log /tmp/snapshot-stats.err.log"
echo "kick:    launchctl start ${LABEL}   # run once right now"
echo "remove:  launchctl unload '$PLIST' && rm '$PLIST'"
