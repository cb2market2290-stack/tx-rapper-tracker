#!/usr/bin/env bash
# Stage + commit Phase 3.5.1 — launchd plist + installer + restart
# helper for the backend. After this commit the backend can be moved
# off a terminal-attached process onto a launchd-supervised one that
# auto-restarts on crash.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/install-launchd-backend.sh \
  tx-rapper-tracker-backend/scripts/restart-backend.sh \
  tx-rapper-tracker-backend/scripts/save-progress-3-5-1.sh

git commit -m "Phase 3.5.1: launchd plist for backend auto-restart

The single biggest self-healing win in the Phase 3.5 hardening pass.
Today node src/index.js runs in whatever terminal happened to launch
it. Crash → manual recovery. After this commit, the backend lives
under a launchd LaunchAgent that auto-restarts on non-zero exit.

* scripts/install-launchd-backend.sh

  Mirrors the existing install-launchd-extract.sh pattern. Idempotent
  (existing version bootout'd before the new plist is written). Writes
  ~/Library/LaunchAgents/com.txrappertracker.backend.plist with:

  - ProgramArguments: [<resolved node path>, src/index.js]
  - WorkingDirectory: backend root (so import.meta resolves correctly)
  - EnvironmentVariables: snapshotted at install time. Required —
    DATABASE_URL, SESSION_SECRET, YOUTUBE_API_KEY (validated up
    front; installer aborts if any are unset). Optional — every
    Stripe / Anthropic / Resend / TOTP / WebAuthn / rate-limit /
    feature-flag env var the app reads. Empty optionals are skipped
    so the plist stays small.
  - PATH: node's dir + the usual Homebrew + system locations,
    deduped. Required because launchd's default PATH is famously
    minimal (/usr/bin:/bin:/usr/sbin:/sbin) — without this any
    child-process spawn (Stripe SDK, Python worker invocation
    in admin re-extract) would fail to find binaries.
  - RunAtLoad: true (start on login)
  - KeepAlive: { SuccessfulExit: false } (restart on crash, not
    on clean exit — same posture as the audio-extract worker)
  - ThrottleInterval: 30 (back off 30s between restarts so a fast
    crash loop doesn't burn CPU; matches extract worker)
  - ProcessType: Interactive (vs Background for the worker;
    backend has user-facing latency requirements + shouldn't be
    deprioritized by macOS App Nap)
  - StandardOut/ErrPath: /tmp/tx-backend.{out,err}.log

  XML escaping on env values (sed for &/</>) so a webhook secret
  with an ampersand in it doesn't break the plist.

* scripts/restart-backend.sh

  Convenience wrapper around launchctl kickstart -k. Use after a
  code change that needs to land in the running process. If the
  agent isn't loaded yet (= you're still on terminal-attached
  node), prints install instructions instead of failing silently.

Operator quick-ref baked into both scripts:
  bash scripts/install-launchd-backend.sh    # install / reinstall
  bash scripts/restart-backend.sh            # restart on code change
  launchctl list | grep com.txrappertracker.backend       # status
  tail -F /tmp/tx-backend.out.log                          # live logs
  launchctl bootout gui/\$(id -u) <plist> && rm <plist>    # uninstall

Verification (live, deferred to user):
  1. kill -9 the running pid; watch /tmp/tx-backend.err.log show
     a relaunch within 30s.
  2. launchctl print gui/\$(id -u)/com.txrappertracker.backend
     reports state=running.
  3. Restart the Mac, log in, confirm the backend is reachable
     without manual start.

Rollback: launchctl bootout + rm of the plist; backend goes back to
terminal-launched. Single-step revert.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
