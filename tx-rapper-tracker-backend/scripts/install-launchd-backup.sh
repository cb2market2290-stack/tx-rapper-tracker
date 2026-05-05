#!/usr/bin/env bash
# Install a launchd agent that runs scripts/backup-postgres.sh daily
# at 03:30 local. Idempotent — bootouts an existing version before
# writing a fresh plist.
#
# Operator quick-ref:
#   bash scripts/install-launchd-backup.sh                          # install
#   launchctl list | grep com.txrappertracker.backup                # status
#   launchctl kickstart -k gui/$(id -u)/com.txrappertracker.backup  # run now
#   tail -F /tmp/tx-backup.out.log                                  # logs
#   ls ~/backups/                                                   # results
#   launchctl bootout gui/$(id -u) "$PLIST" && rm "$PLIST"          # uninstall

set -euo pipefail

LABEL="com.txrappertracker.backup"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

backend_root=$(cd "$(dirname "$0")/.." && pwd)
backup_script="$backend_root/scripts/backup-postgres.sh"

if [[ ! -f "$backup_script" ]]; then
  echo "error: $backup_script missing" >&2
  exit 1
fi
chmod +x "$backup_script" 2>/dev/null || true

bash_bin=$(command -v bash || echo /bin/bash)
pg_dump_bin=$(command -v pg_dump || true)
declare -a path_dirs=(/usr/local/bin /opt/homebrew/bin /usr/bin /bin)
[[ -n "$pg_dump_bin" ]] && path_dirs=("$(dirname "$pg_dump_bin")" "${path_dirs[@]}")
launchd_path=$(printf '%s\n' "${path_dirs[@]}" | awk '!seen[$0]++' | paste -sd: -)

mkdir -p "$HOME/Library/LaunchAgents"

domain="gui/$(id -u)"
if launchctl print "${domain}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${domain}/${LABEL}" 2>/dev/null || true
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bash_bin}</string>
        <string>${backup_script}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${backend_root}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchd_path}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/tx-backup.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/tx-backup.err.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "${domain}" "$PLIST"

cat <<MSG
installed:
  plist:    $PLIST
  schedule: daily at 03:30 local
  output:   ~/backups/tx-YYYYMMDD-HHMM.sql.gz
  retain:   14 days (override RETENTION_DAYS in env if you want longer)

verify:    launchctl list | grep $LABEL
trigger:   launchctl kickstart -k ${domain}/${LABEL}
logs:      tail -F /tmp/tx-backup.out.log
MSG
