#!/usr/bin/env bash
# Phase 2d.B1 — long-running audio-feature extract worker.
#
# Wraps scripts/extract-features.py in a supervised drain-and-sleep loop so
# the queue is processed continuously without launching a fresh Python
# interpreter per job. Designed to be run by launchd
# (com.txrappertracker.extract) but works fine standalone for dev:
#
#   bash scripts/run-extract-worker.sh
#
# Behavior:
#   * Drains up to $WORKER_BATCH jobs per cycle (default 10), then sleeps.
#   * Sleeps $WORKER_IDLE_SLEEP seconds when the queue is empty (default 60).
#   * Sleeps $WORKER_BUSY_SLEEP seconds between cycles when work was done
#     (default 5) — gives Postgres a breather and prevents tight loops if
#     a video keeps failing fast.
#   * Caps total runtime at $WORKER_MAX_RUNTIME_SEC (default 0 = unbounded).
#     launchd-style supervisors prefer recycled processes; a non-zero cap
#     lets the agent restart fresh after N seconds.
#   * Exits cleanly on SIGTERM / SIGINT (in-flight job is allowed to finish
#     because the underlying Python call is uninterruptible mid-extract).
#   * Structured stdout: every line is `LVL ts message=…` so a tail -F
#     against /tmp/extract-worker.out.log is grep-friendly.
#
# Env knobs:
#   DATABASE_URL          required by the Python worker
#   WORKER_BATCH          jobs per drain cycle           (default 10)
#   WORKER_IDLE_SLEEP     sleep secs after empty cycle   (default 60)
#   WORKER_BUSY_SLEEP     sleep secs after working cycle (default 5)
#   WORKER_MAX_RUNTIME_SEC graceful exit after N secs    (default 0 = off)
#   PYTHON_BIN            python3 binary to use          (default `python3`)
#   EXTRACT_FEATURES_SCRIPT   path to extract-features.py
#                              (default <this script dir>/extract-features.py)
#
# Logs:
#   stdout / stderr are owned by the supervisor (launchd writes them to
#   /tmp/extract-worker.{out,err}.log via the plist). Don't open files in
#   here — keep this script restartable and stateless.

set -u

# Resolve script-relative paths first so we can be invoked from any cwd.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BACKEND_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

PYTHON_BIN="${PYTHON_BIN:-python3}"
EXTRACT_FEATURES_SCRIPT="${EXTRACT_FEATURES_SCRIPT:-$SCRIPT_DIR/extract-features.py}"
WORKER_BATCH="${WORKER_BATCH:-10}"
WORKER_IDLE_SLEEP="${WORKER_IDLE_SLEEP:-60}"
WORKER_BUSY_SLEEP="${WORKER_BUSY_SLEEP:-5}"
WORKER_MAX_RUNTIME_SEC="${WORKER_MAX_RUNTIME_SEC:-0}"

START_EPOCH=$(date +%s)
RUN_LOOP=1

log() {
  # Line format: LVL ISO8601-ish-ts key=val key=val …
  local lvl="$1"; shift
  printf '%s %s %s\n' "$lvl" "$(date +'%Y-%m-%dT%H:%M:%S%z')" "$*"
}

on_signal() {
  # Stop the outer loop. The current python invocation is allowed to finish
  # naturally — interrupting librosa mid-load tends to leave temp files
  # behind. The Python worker itself has no signal handler beyond Python's
  # default, so a second SIGTERM will hard-kill it.
  log INFO "msg=signal-received signal=$1 action=stop-after-current-cycle"
  RUN_LOOP=0
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT

if [[ -z "${DATABASE_URL:-}" ]]; then
  log FATAL "msg=missing-env var=DATABASE_URL"
  exit 2
fi
if [[ ! -f "$EXTRACT_FEATURES_SCRIPT" ]]; then
  log FATAL "msg=script-missing path=$EXTRACT_FEATURES_SCRIPT"
  exit 2
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  log FATAL "msg=python-missing bin=$PYTHON_BIN"
  exit 2
fi

log INFO "msg=worker-starting pid=$$ batch=$WORKER_BATCH idle_sleep=$WORKER_IDLE_SLEEP busy_sleep=$WORKER_BUSY_SLEEP max_runtime=$WORKER_MAX_RUNTIME_SEC python=$PYTHON_BIN"

cycle=0
while [[ "$RUN_LOOP" = "1" ]]; do
  cycle=$((cycle + 1))

  # Capture queue counts before draining so we can short-circuit on an empty
  # queue (sleeping is cheaper than spinning up Python just to find nothing
  # to do).
  status_json=$("$PYTHON_BIN" "$EXTRACT_FEATURES_SCRIPT" --status 2>/tmp/extract-worker.status.err || true)
  # Single-pass extract of the two counts we care about. Any parse error or
  # missing key collapses to "0 0" so the caller treats it as empty.
  read -r pending failed <<EOF
$(printf '%s' "$status_json" | "$PYTHON_BIN" -c '
import json, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception:
    d = {}
print(int(d.get("pending", 0) or 0), int(d.get("failed", 0) or 0))
' 2>/dev/null || echo "0 0")
EOF
  pending="${pending:-0}"
  failed="${failed:-0}"

  if [[ "$pending" = "0" && "$failed" = "0" ]]; then
    log INFO "msg=cycle-skip cycle=$cycle reason=empty-queue sleep=$WORKER_IDLE_SLEEP"
    # Sleep in 1s slices so SIGTERM gets noticed quickly.
    slept=0
    while [[ "$slept" -lt "$WORKER_IDLE_SLEEP" && "$RUN_LOOP" = "1" ]]; do
      sleep 1
      slept=$((slept + 1))
    done
  else
    log INFO "msg=cycle-start cycle=$cycle pending=$pending failed=$failed batch=$WORKER_BATCH"
    cycle_start=$(date +%s)
    # The Python worker's exit code is 0 on success, 1 on at-least-one
    # failure, 2 on config error. We tolerate 1 (a single bad video
    # shouldn't stop the loop) but bail on 2.
    set +e
    "$PYTHON_BIN" "$EXTRACT_FEATURES_SCRIPT" --max "$WORKER_BATCH"
    rc=$?
    set -e 2>/dev/null || true
    cycle_end=$(date +%s)
    elapsed=$((cycle_end - cycle_start))
    log INFO "msg=cycle-end cycle=$cycle exit=$rc elapsed_sec=$elapsed"
    if [[ "$rc" = "2" ]]; then
      log FATAL "msg=worker-config-error exit=$rc"
      exit 2
    fi
    # Brief pause between busy cycles to keep this from monopolizing the DB.
    slept=0
    while [[ "$slept" -lt "$WORKER_BUSY_SLEEP" && "$RUN_LOOP" = "1" ]]; do
      sleep 1
      slept=$((slept + 1))
    done
  fi

  if [[ "$WORKER_MAX_RUNTIME_SEC" -gt 0 ]]; then
    now=$(date +%s)
    if [[ $((now - START_EPOCH)) -ge "$WORKER_MAX_RUNTIME_SEC" ]]; then
      log INFO "msg=runtime-cap-hit max=$WORKER_MAX_RUNTIME_SEC action=exit"
      RUN_LOOP=0
    fi
  fi
done

log INFO "msg=worker-stopped cycles=$cycle elapsed_sec=$(( $(date +%s) - START_EPOCH ))"
exit 0
