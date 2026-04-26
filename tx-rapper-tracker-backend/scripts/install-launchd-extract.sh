#!/usr/bin/env bash
# Install a launchd agent that runs scripts/run-extract-worker.sh as a
# supervised long-running daemon. Idempotent — safe to re-run; an existing
# version is bootout'd before the new plist is written.
#
# Why launchd: the worker is a drain-and-sleep loop, not a one-shot. We
# want macOS to:
#   1. Restart it automatically if it crashes (KeepAlive=SuccessfulExit:false).
#   2. Throttle restarts so a fast crash loop doesn't burn CPU
#      (ThrottleInterval=30).
#   3. Resume after sleep/wake without manual intervention.
#
# Logs:
#   /tmp/extract-worker.out.log  (stdout — structured "LVL ts key=val")
#   /tmp/extract-worker.err.log  (stderr — Python tracebacks, etc.)
# Label: com.txrappertracker.extract  (see launchctl list | grep tx)
#
# Env passthrough:
#   DATABASE_URL must be set in the calling shell when this installer runs.
#   We snapshot it into the plist so launchd has it at boot — launchd does
#   not inherit the user's interactive env. To rotate the URL, re-run this
#   installer with the new value exported.
#
# Operator quick-ref:
#   bash scripts/install-launchd-extract.sh          # install / re-install
#   launchctl list | grep com.txrappertracker        # status
#   launchctl kickstart -k gui/$(id -u)/com.txrappertracker.extract  # restart
#   tail -F /tmp/extract-worker.out.log              # live logs
#   launchctl bootout gui/$(id -u) "$PLIST" && rm "$PLIST"   # uninstall

set -euo pipefail

LABEL="com.txrappertracker.extract"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

backend_root=$(cd "$(dirname "$0")/.." && pwd)
worker_script="$backend_root/scripts/run-extract-worker.sh"

if [[ ! -f "$worker_script" ]]; then
  echo "error: worker script missing at $worker_script" >&2
  exit 1
fi
chmod +x "$worker_script" 2>/dev/null || true

# --- Resolve binaries ---------------------------------------------------
# launchd's PATH is famously minimal (/usr/bin:/bin:/usr/sbin:/sbin), so we
# have to bake absolute paths or extend PATH via EnvironmentVariables.
bash_bin=$(command -v bash || true)
python_bin="${PYTHON_BIN:-$(command -v python3 || true)}"
node_bin=$(command -v node || true)
ytdlp_bin=$(command -v yt-dlp || true)
ffmpeg_bin=$(command -v ffmpeg || true)

# nvm / pyenv resolution: when invoked from a shell that's already loaded
# them, command -v returns shim paths. That's fine — launchd needs the
# absolute path, and the shim resolved itself when this script ran.
if [[ -z "$python_bin" ]]; then
  echo "error: python3 not found on PATH" >&2
  exit 1
fi
if [[ -z "$bash_bin" ]]; then
  echo "error: bash not found on PATH (?!)" >&2
  exit 1
fi

# --- DATABASE_URL is required ------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL must be exported before installing this agent" >&2
  echo "       (launchd does not inherit your shell env at boot)" >&2
  exit 1
fi

# Build a PATH the worker can actually call yt-dlp / ffmpeg / python from.
# Order: explicit binaries' dirs first, then the usual fallbacks.
declare -a path_dirs=()
for bin in "$python_bin" "$node_bin" "$ytdlp_bin" "$ffmpeg_bin"; do
  [[ -n "$bin" ]] && path_dirs+=("$(dirname "$bin")")
done
path_dirs+=(/usr/local/bin /opt/homebrew/bin /usr/bin /bin)
# Dedupe while preserving order.
launchd_path=$(printf '%s\n' "${path_dirs[@]}" | awk '!seen[$0]++' | paste -sd: -)

mkdir -p "$HOME/Library/LaunchAgents"

# --- Tear down any existing version ------------------------------------
# `bootout` is the modern equivalent of `unload`; both are tolerated, but
# bootout is required on macOS Sonoma+ when the plist already lives in
# ~/Library/LaunchAgents.
domain="gui/$(id -u)"
if launchctl print "${domain}/${LABEL}" >/dev/null 2>&1; then
  echo "stopping existing ${LABEL} ..."
  launchctl bootout "${domain}/${LABEL}" 2>/dev/null || \
    launchctl unload "$PLIST" 2>/dev/null || true
fi

# --- Write the plist ----------------------------------------------------
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
        <string>${worker_script}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${backend_root}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchd_path}</string>
        <key>DATABASE_URL</key>
        <string>${DATABASE_URL}</string>
        <key>PYTHON_BIN</key>
        <string>${python_bin}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Nice</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>/tmp/extract-worker.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/extract-worker.err.log</string>
</dict>
</plist>
EOF

# --- Boot it ------------------------------------------------------------
launchctl bootstrap "${domain}" "$PLIST"
launchctl kickstart "${domain}/${LABEL}" 2>/dev/null || true

cat <<MSG
installed:
  plist:   $PLIST
  label:   $LABEL
  bash:    $bash_bin
  python:  $python_bin
  cwd:     $backend_root
  worker:  $worker_script
  PATH:    $launchd_path
  KeepAlive: yes (restart on non-zero exit; throttle=30s)

verify:    launchctl list | grep $LABEL
status:    launchctl print ${domain}/${LABEL} | head -40
logs:      tail -F /tmp/extract-worker.out.log
restart:   launchctl kickstart -k ${domain}/${LABEL}
remove:    launchctl bootout ${domain}/${LABEL} && rm '$PLIST'
MSG
