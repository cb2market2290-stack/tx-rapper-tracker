# Phase 3.5 — hardening + self-healing pass

Status: locked design. Inserted between Phase 3c (public profile pages)
and Phase 3d (digest + referral). 3-4 days of work, no customer-visible
features. Yields material gains on every one of the four product
factors (security / simplicity / upgrade-friendliness / self-healing).

## Why now

Every later phase becomes safer to ship after this. We have a real
revenue path (Stripe Premium), a real third-party spend surface
(Anthropic API for briefs), a real cron pipeline (snapshots →
breakout matview → alert evaluator), and a public surface coming in
3c. The hardening gaps that were tolerable in dev start to matter once
real users + real money are involved.

The four items below are the highest-impact-per-day wins from a
post-3c review. All four are additive — none of them require redesign,
none touch existing route surfaces, and each can roll back to a single
revert commit.

## Surface area

### 3.5.1 — launchd plist for the backend itself

Today: `node src/index.js` runs in a terminal session. If it crashes
(uncaught exception, OOM, hardware blip), nothing brings it back until
a human notices. This is the single biggest self-healing gap.

Mirror the existing audio-extract worker pattern from
`config/launchd/com.txrappertracker.extract.plist`:

```
~/Library/LaunchAgents/com.txrappertracker.backend.plist

* ProgramArguments: ['/usr/local/bin/node', 'src/index.js']
* WorkingDirectory: ~/clawd/projects/tx-rapper-tracker-backend
* RunAtLoad: true       (start on login)
* KeepAlive: true       (restart on exit, regardless of exit code)
* StandardOutPath / StandardErrorPath:
    /tmp/tx-backend.out / /tmp/tx-backend.err
* EnvironmentVariables: NODE_ENV=production
* ThrottleInterval: 30  (don't hot-loop on a crash that fires
                          immediately on start; back off 30s)
```

Plus `scripts/install-launchd-backend.sh` (loads the plist via
`launchctl bootstrap gui/<uid>`) and `scripts/restart-backend.sh`
(uses `launchctl kickstart -k`). Same shape as the existing
extract-worker scripts.

Verification:
* `kill -9` the running pid, watch `tx-backend.err` show a relaunch.
* Verify `launchctl print` shows the agent state.
* Restart the Mac, confirm the backend comes up automatically on login.

### 3.5.2 — CSP nonce migration (drop `'unsafe-inline'`)

Today: `src/middleware/security.js` line 22:
```
"'unsafe-inline'", // inline <script> blocks in app.html / admin.html
```
TODO comment on line 9 already calls this out: "migrating to nonces is
a follow-up." Closing the TODO closes the only material XSS gap left
in the helmet config.

Approach:
1. New middleware `cspNonce()` runs early, generates 16 bytes of
   crypto-random per request, attaches to `res.locals.cspNonce`.
2. `securityHeaders()` reads `res.locals.cspNonce` and emits
   `script-src 'self' 'nonce-${nonce}' https://cdnjs.cloudflare.com`
   (no `'unsafe-inline'`).
3. `app.get('/', ...)` and the other static-html sendFile routes
   become tiny render functions that read the nonce, replace a
   `__CSP_NONCE__` token in app.html / admin.html, and send the
   result. (Keeps app.html as a single file; no template engine.)
4. Every inline `<script>` and `<style>` block in app.html /
   admin.html gets `nonce="__CSP_NONCE__"`. The replace step at
   step 3 substitutes the real value per request.

Why nonces and not hashes: the inline blocks are big and they change
across phases. Maintaining hashes by hand is brittle. Nonces are
per-request so they invalidate correctly and require no build step.

Verification:
* Curl the page, grep for `nonce="` — should appear on every inline
  block.
* Curl the page twice, confirm the nonce values differ between
  responses.
* Open Chrome devtools → Console: any inline script that LACKS the
  nonce should show a CSP violation. Confirms `'unsafe-inline'` is
  gone.
* Existing E2E smokes still pass — proves we didn't break any
  app behavior.

### 3.5.3 — snapshot + cron failure alerting

Today: `scripts/snapshot-stats.js` runs at 04:00 daily. If it
throws (rate-limit hits YouTube API, DB blip, schema drift), the
job dies silently. The dashboard shows stale data and nobody
notices until the next manual refresh.

Wrap the existing snapshot work in try/catch + reuse the Phase 2b
mailer (`services/mailer.js`):

```
try {
  await runSnapshot();
} catch (err) {
  await mailer.send({
    to: config.adminEmails[0],
    subject: '[TX Rapper Tracker] Snapshot job failed',
    text: `Job died at ${new Date().toISOString()}\n\n${err.stack}`,
  });
  process.exit(1);  // launchd / cron sees the failure too
}
```

Same wrapper pattern for:
* The audio-extract worker (already has retry-on-claim, but a
  permanent failure should email the admin).
* The Phase 3a saved-search evaluator (already runs inline with the
  snapshot cron; covered by the same wrapper).
* (When 3.5.4 ships) the deep-health check itself becomes a
  cron-of-last-resort that emails on red status.

Stale-data detection: also fire the alert when `runSnapshot()`
SUCCEEDS but the most-recent `artist_stats_daily.captured_on` is
still > 36h old (= the last 2 cron runs both no-op'd or wrote zero
rows). Distinguishes "snapshot couldn't run" from "snapshot ran but
the API returned nothing useful."

### 3.5.4 — GET /api/health/deep

Today: there's a basic `GET /` health that just confirms the
process is up. Doesn't tell you whether the SYSTEM is healthy —
just whether the HTTP server is.

New endpoint that returns 200 on green, 503 on any red:

```
GET /api/health/deep

200 OK
{
  "kind": "health.deep",
  "status": "ok",
  "checks": {
    "db":               { ok: true },
    "snapshot_fresh":   { ok: true,  lastAt: '2026-04-28', ageHours: 4.2 },
    "extract_fresh":    { ok: true,  lastAt: '...',         ageHours: 18.0 },
    "briefs_configured":{ ok: true,  enabled: true }   // null when feature off
  }
}

503 Service Unavailable
{
  "kind": "health.deep",
  "status": "degraded",
  "checks": { ... },
  "failed": ['snapshot_fresh']
}
```

Thresholds:
* DB: a `SELECT 1` round-trip succeeds within 1s.
* Snapshot fresh: most recent `MAX(captured_on)` from
  artist_stats_daily ≤ 26 hours old.
* Extract fresh: most recent `MAX(extracted_at)` from
  track_features ≤ 7 days old (only checked when at least one
  artist exists; new boxes pass trivially).
* Briefs configured: only included as a check when
  `config.briefs.enabled` is true; otherwise reported as null /
  not-applicable so it doesn't false-alarm dev environments.

Wires to two consumers:
1. **External uptime monitor** (UptimeRobot, Better Stack, whatever
   the user wants) — point at this URL.
2. **launchd-side cron** — a 5-minute LaunchAgent curls the URL,
   pipes any non-200 to the Phase 3.5.3 mailer. Means even if
   the snapshot cron's own alerting breaks, the deep-health probe
   catches it.

Public + un-authenticated. No PII. Safe to expose.

## Migration / rollback plan

Every item is one route or one config block — easy individual reverts.

* 3.5.1 — `launchctl bootout` removes the agent; backend goes back
  to terminal-launched.
* 3.5.2 — re-add `'unsafe-inline'` to the CSP if the nonce wiring
  breaks anything; one-line revert in security.js. The
  `__CSP_NONCE__` placeholders in app.html become harmless strings.
* 3.5.3 — try/catch wrappers can be removed without consequence.
* 3.5.4 — new endpoint; deletion is a clean revert.

## Verification matrix

| Item | Unit tests | Live smoke | Manual verify |
|---|---|---|---|
| 3.5.1 | n/a (plist only) | `kill -9` → relaunch | `launchctl print` |
| 3.5.2 | nonce middleware: 16 bytes hex, unique per req | curl + grep | Chrome devtools console clean |
| 3.5.3 | mailer-call assertion in test | force-fail snapshot in dev → admin email | mailbox check |
| 3.5.4 | each check fn pure-tested | curl /api/health/deep | curl after stopping snapshot for 27h |

## Out of scope for 3.5 (deferred)

* Migration rollback plan — forward-only stays fine until first
  "oh no" moment.
* Staging environment — dev → prod tunnel is enough until first
  paying user.
* CI via GitHub Actions — recommended but not strictly hardening;
  pull into a 3.5+ housekeeping commit if time permits, otherwise
  defer.
* Friendlier error copy + onboarding empty-state — folded into 3d.

## What "done" looks like

After 3.5 ships:
* Backend crash → auto-recovers in seconds via launchd.
* XSS injection has materially harder surface (no
  `'unsafe-inline'`).
* Cron failure → admin gets an email within minutes, not the next
  time someone opens the dashboard.
* External monitoring has a single URL that says yes-or-no
  everything-is-fine.

Two of the four items (3.5.1, 3.5.4) work even if the other two
don't ship. So we can incremental-ship and keep moving toward 3d.
