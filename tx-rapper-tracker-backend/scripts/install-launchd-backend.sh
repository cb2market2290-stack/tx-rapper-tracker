#!/usr/bin/env bash
# Install a launchd agent that runs the Express backend (`node src/index.js`)
# as a supervised long-running service. Phase 3.5.1.
#
# Why launchd: today the backend runs in whatever terminal happened to
# launch it. If the process dies (uncaught exception, OOM, hardware
# blip), nothing brings it back until a human notices. Mirroring the
# audio-extract worker's plist pattern makes the backend self-healing
# in seconds.
#
# Idempotent — safe to re-run; an existing version is bootout'd before
# the new plist is written.
#
# Logs:
#   /tmp/tx-backend.out.log   (stdout — pino structured logs)
#   /tmp/tx-backend.err.log   (stderr — uncaught exception traces)
# Label: com.txrappertracker.backend
#
# Env passthrough (snapshotted into the plist at install time — launchd
# does not inherit your shell env at boot):
#   * Required: DATABASE_URL, SESSION_SECRET, YOUTUBE_API_KEY
#   * Optional: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ANTHROPIC_API_KEY,
#     RESEND_API_KEY, NODE_ENV, ADMIN_EMAILS, FRONTEND_DIR, etc.
#   * To rotate any of these, re-run this installer with the new values
#     exported in the calling shell.
#
# Operator quick-ref:
#   bash scripts/install-launchd-backend.sh                          # install / reinstall
#   launchctl list | grep com.txrappertracker.backend                # status
#   launchctl kickstart -k gui/$(id -u)/com.txrappertracker.backend  # restart
#   tail -F /tmp/tx-backend.out.log                                  # live logs
#   launchctl bootout gui/$(id -u) "$PLIST" && rm "$PLIST"           # uninstall

set -euo pipefail

LABEL="com.txrappertracker.backend"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

backend_root=$(cd "$(dirname "$0")/.." && pwd)
entry_point="$backend_root/src/index.js"

if [[ ! -f "$entry_point" ]]; then
  echo "error: backend entry point missing at $entry_point" >&2
  exit 1
fi

# --- Resolve binaries ---------------------------------------------------
# launchd's PATH is famously minimal (/usr/bin:/bin:/usr/sbin:/sbin), so
# we bake the absolute node path + extend PATH via EnvironmentVariables.
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" ]]; then
  echo "error: node not found on PATH" >&2
  echo "       (set NODE_BIN=/path/to/node and re-run if you use nvm)" >&2
  exit 1
fi

# nvm shim resolution: command -v node returns a shim when nvm is loaded.
# That's fine — the shim resolved itself when this script ran. We snapshot
# the absolute path either way.

# --- Required env -------------------------------------------------------
required_vars=(DATABASE_URL SESSION_SECRET YOUTUBE_API_KEY)
missing=()
for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then missing+=("$v"); fi
done
if (( ${#missing[@]} > 0 )); then
  echo "error: required env vars not set: ${missing[*]}" >&2
  echo "       (launchd does not inherit your shell env at boot)" >&2
  echo "       export them in the shell that runs this installer." >&2
  exit 1
fi

# Optional env. Empty values are fine — we just don't write them.
optional_vars=(
  NODE_ENV PORT LOG_LEVEL ADMIN_EMAILS FRONTEND_DIR APP_BASE_URL
  CORS_ORIGINS SESSION_COOKIE_NAME SESSION_COOKIE_DOMAIN
  SESSION_COOKIE_SECURE SESSION_TTL_SECONDS
  RESEND_API_KEY MAIL_FROM
  TOTP_ENC_KEY TOTP_ISSUER
  WEBAUTHN_RP_ID WEBAUTHN_RP_NAME WEBAUTHN_ORIGINS
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID
  STRIPE_PRICE_PRO STRIPE_PRICE_PREMIUM STRIPE_API_VERSION
  ANTHROPIC_API_KEY ANTHROPIC_BRIEF_MODEL ANTHROPIC_BRIEF_TIMEOUT_MS
  HIBP_REJECT_THRESHOLD ZXCVBN_MIN_SCORE
  RATE_LIMIT_WINDOW_MS RATE_LIMIT_MAX RATE_LIMIT_AUTH_MAX
  RATE_LIMIT_AUTHED_MAX RATE_LIMIT_ANON_MAX
  CACHE_TTL_SECONDS PASSWORD_RESET_TTL_MINUTES
)

# Build the PATH the backend can call from. Node's dir + the usual
# Homebrew + system locations.
declare -a path_dirs=("$(dirname "$node_bin")")
path_dirs+=(/usr/local/bin /opt/homebrew/bin /usr/bin /bin /usr/sbin /sbin)
launchd_path=$(printf '%s\n' "${path_dirs[@]}" | awk '!seen[$0]++' | paste -sd: -)

mkdir -p "$HOME/Library/LaunchAgents"

# --- Tear down any existing version ------------------------------------
domain="gui/$(id -u)"
if launchctl print "${domain}/${LABEL}" >/dev/null 2>&1; then
  echo "stopping existing ${LABEL} ..."
  launchctl bootout "${domain}/${LABEL}" 2>/dev/null || \
    launchctl unload "$PLIST" 2>/dev/null || true
fi

# --- Build the EnvironmentVariables dict --------------------------------
# Required vars first (we already validated they're set), then any
# optional ones the caller exported.
env_xml=""
xml_escape() {
  # Properly escape XML special chars in values. plist values can contain
  # almost anything, but '<', '>', '&' must be escaped.
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

append_env() {
  local key="$1" val="$2"
  env_xml+=$'\n        <key>'"$key"$'</key>\n        <string>'"$(xml_escape "$val")"$'</string>'
}

append_env PATH "$launchd_path"
append_env NODE_BIN "$node_bin"
for v in "${required_vars[@]}"; do
  append_env "$v" "${!v}"
done
for v in "${optional_vars[@]}"; do
  if [[ -n "${!v:-}" ]]; then
    append_env "$v" "${!v}"
  fi
done

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
        <string>${node_bin}</string>
        <string>${entry_point}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${backend_root}</string>
    <key>EnvironmentVariables</key>
    <dict>${env_xml}
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
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>/tmp/tx-backend.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/tx-backend.err.log</string>
</dict>
</plist>
EOF

# --- Boot it ------------------------------------------------------------
launchctl bootstrap "${domain}" "$PLIST"
launchctl kickstart "${domain}/${LABEL}" 2>/dev/null || true

cat <<MSG
installed:
  plist:    $PLIST
  label:    $LABEL
  node:     $node_bin
  cwd:      $backend_root
  entry:    $entry_point
  PATH:     $launchd_path
  KeepAlive: yes (restart on non-zero exit; throttle=30s)

verify:   launchctl list | grep $LABEL
status:   launchctl print ${domain}/${LABEL} | head -40
logs:     tail -F /tmp/tx-backend.out.log
restart:  launchctl kickstart -k ${domain}/${LABEL}
remove:   launchctl bootout ${domain}/${LABEL} && rm '$PLIST'

After install, the backend will:
  * start automatically on login (RunAtLoad)
  * restart automatically on crash (KeepAlive: SuccessfulExit=false)
  * back off 30s between restarts so a fast crash loop doesn't burn CPU
MSG
