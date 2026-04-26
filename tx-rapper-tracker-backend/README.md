# tx-rapper-tracker-backend

Small, hardened Node.js proxy that sits between `app.html` and third-party
APIs (YouTube Data API v3). Its job: keep API keys off the browser, plus
a thin auth + admin layer and a daily artist-stats snapshot job that powers
the 12-month chart.

This is the live build through **Phase 2d** of the Music Analytics
Platform. See `Music_Analytics_Platform_Brainstorm.md` for the full plan.
Phase 2a brought up the API-key proxy + logging baseline; Phase 2b added
Postgres, accounts, sessions, password reset, TOTP and WebAuthn 2FA, and
admin tooling; Phase 2c added per-track audio analysis (yt-dlp + librosa)
and the Stripe payments scaffolding; Phase 2d turns the Stripe pieces on
(Checkout + Customer Portal + paid-tier gating) and ships a long-running
launchd-supervised audio worker plus an `analyzer_version`-driven
re-extraction policy.

## What it does

- `/api/youtube/search`, `/channel`, `/channel/uploads`, `/videos` — YouTube
  Data API v3, with the API key attached server-side.
- `/api/stats/history` — per-artist daily YouTube-channel stats
  (subs + lifetime views), populated by `scripts/snapshot-stats.js`.
- `/api/artists`, `/api/artists/:id/features` — artist roster + the
  aggregated audio-feature summary (tempo, dominant key, energy, per-track
  rows) computed from `track_features`. The summary feeds the frontend
  ranking via a small bonus term and renders in the artist detail panel.
- `/api/auth/*`, `/api/auth/2fa/*`, `/api/auth/webauthn/*`, `/api/admin/*` —
  email + Argon2id password auth, TOTP and passkey enrolment / verification,
  audit-log + active-session admin views.
- `/api/payments/webhook`, `/api/payments/status` — Stripe webhook receiver
  (raw-body mounted before `express.json()` so signatures verify) and a
  diagnostic that reports whether keys are configured. The webhook is
  intentionally idempotent (`stripe_webhook_events.event_id`) and 503s
  when keys are unset rather than 404-ing — a misconfigured deploy is
  loud, not silent.
- `/api/payments/checkout`, `/api/payments/portal`, `/api/payments/plan`
  (Phase 2d) — `POST /checkout` creates a Stripe Checkout Session for the
  signed-in user (returns `{url}` for the frontend to `location.assign`);
  `POST /portal` creates a Customer Portal session so paying users can
  manage their subscription themselves; `GET /plan` returns the user's
  current `{plan, stripeStatus, currentPeriodEnd, cancelAtPeriodEnd}`
  derived from the `active_user_plan` view (Stripe-source-of-truth).
  Free-tier users hitting paid endpoints (e.g.
  `/api/artists/:id/features`) get a 402 with `{kind:'payments.required'}`
  so the SPA can render an inline Upgrade CTA instead of a generic error.
- `/health`, `/ready` — uptime and cache stats for monitoring.

_(Note: the old `/api/trends/interest` Google Trends proxy was removed
in phase 2b.9 — the unofficial endpoint started bot-blocking us and
nothing in the UI was calling it.)_

Every response is cached (`CACHE_TTL_SECONDS`, default 10 min) and concurrent
requests for the same key are collapsed into a single upstream call. Inputs
are validated with Zod, rate-limited per IP, and served behind Helmet
security headers + an allow-list CORS policy.

Logs are structured JSON (Pino) with a PII scrubber that masks Google API
keys, Stripe keys, Bearer tokens, and email addresses before writing.

## Requirements

- Node 20 or newer
- A YouTube Data API v3 key
  (https://console.cloud.google.com/apis/credentials)
- Postgres 14 or newer (Phase 2b onward — accounts, sessions, audit log,
  artist roster, and the Phase 2c audio-features tables all live here)
- Optional: Python 3.11+ with `yt-dlp` and `librosa` if you want to run
  the audio-extraction worker locally
  (`scripts/extract-features.py`)

## Setup

```bash
cd tx-rapper-tracker-backend
cp .env.example .env
# open .env and paste real values for YOUTUBE_API_KEY, DATABASE_URL,
# SESSION_SECRET, and (optionally) the Stripe keys.
npm install
npm run migrate           # apply migrations 001..010 in order
npm test                  # most suites are offline; cache.test.js needs Postgres
npm start                 # serves on :8787
```

The `npm test` command runs every `test/*.test.js` file. The offline
suites (auth, sessions, features, stripe, redaction, etc.) need no
network or DB. The `cache.test.js` suite exercises the Postgres-backed
upstream cache and requires `DATABASE_URL` to point at a running
database with the migrations applied.

For a deployment walk-through (Cloudflare Tunnel, launchd snapshot job,
prod env hardening), see `DEPLOY.md`.

## Env vars

See `.env.example` for the full list. Required:

- `YOUTUBE_API_KEY` — your key from Google Cloud Console.
- `DATABASE_URL` — Postgres connection string.
- `SESSION_SECRET` — at least 32 chars; see `.env.example` for a
  one-liner that generates one.

Useful to customize:

- `PORT` — default `8787`.
- `CORS_ORIGINS` — comma-separated allow-list. Includes `null` by default so
  `app.html` opened via `file://` can call it. In production, swap in the
  real hostnames only.
- `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_AUTHED_MAX` / `RATE_LIMIT_ANON_MAX`
  — tiered limits, defaults 10 / 240 / 30 per `RATE_LIMIT_WINDOW_MS`.
  The legacy `RATE_LIMIT_MAX` is unused but kept so old envs don't break.
- `CACHE_TTL_SECONDS` — default 600.
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_ID` —
  leave blank to disable payments (default in dev). The webhook route
  returns 503 until both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  are set.

**Never commit `.env`.** `.gitignore` blocks it; keep it that way.

## Running behind Cloudflare Tunnel

The proxy sets `app.set('trust proxy', 1)` so `req.ip` reflects the real
client IP from the tunnel, not `127.0.0.1`. Expose `:8787` through your
tunnel, point `app.html`'s `PROXY_BASE` at the public hostname, and keep the
home Mac Pro's real IP hidden.

## Quick sanity check once it's running

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"uptimeMs":123}

curl -s "http://127.0.0.1:8787/api/youtube/search?q=megan+thee+stallion&maxResults=3" | jq .items[].snippet.title
```

If either fails, check `.env` and the startup log (the key is redacted —
you'll see `AIza…redacted`, that's fine).

## Integrating with `app.html`

See `INTEGRATION.md` for the original Phase 2a swap (mechanical patch:
add `PROXY_BASE`, rewrite ~5 fetch URLs, delete the API-key input);
scoped for OpenClaw — see `TASK.md`. Phase 2b moved the frontend behind
the same origin (the backend now serves `app.html` and `admin.html` from
`../tx-rapper-tracker`), so for new local dev you can hit
http://localhost:8787/ directly.

## What this intentionally does NOT do yet

- No music upload or AI hit-prediction model — Phase 3+.
- No multi-tier pricing yet. Phase 2d ships a single Stripe price
  (`STRIPE_PRICE_ID`) → "paid" plan; tiers (analyst / pro / studio) and
  per-tier feature gates are a Phase 3 concern.
- No backfill UI for the re-extraction policy. The
  `node scripts/enqueue-features.js --reextract <version>` CLI flips stale
  jobs back to `pending`; an admin-panel button to trigger that is later
  work.

Keeping each phase narrow is the point: kill the in-browser API key
first, then sessions + 2FA, then audio + payments wiring, then the
revenue path. Each layer earns the next.

## Layout

```
src/
  config.js          # zod-validated env, fail-fast
  lib/
    cache.js         # node-cache + concurrent-load collapsing
    logger.js        # pino + PII scrubber
  middleware/
    security.js      # Helmet / CSP / HSTS
    cors.js          # allow-list
    rateLimit.js     # tiered (auth / authed / anon), keyed by user/ip
    errorHandler.js  # HttpError + JSON 404/500
    authenticate.js  # attachUser + requireUser
  services/
    youtube.js       # undici-based YouTube Data API v3 client
    features.js      # audio-feature aggregation + dominant-key picker
    stripe.js        # lazy SDK wrapper + webhook payload shaping + DB
  routes/
    health.js        # /health, /ready
    youtube.js       # /api/youtube/*
    stats.js         # /api/stats/history (artist daily snapshots)
    artists.js       # /api/artists, /api/artists/:id/features
    auth.js          # /api/auth/* (signup, login, password reset, sessions)
    twofactor.js     # /api/auth/2fa/* (TOTP enrol, verify, disable)
    webauthn.js      # /api/auth/webauthn/* (passkey registration + auth)
    admin.js         # /api/admin/* (audit log, active sessions; allow-list)
    payments.js      # /api/payments/{webhook,status} — raw-body mounted
  db/
    pool.js          # pg pool with graceful shutdown
  index.js           # wires it all together
migrations/          # 001..011 — applied in order by hand or by tool
  009_track_features.sql       # track_features + track_extraction_jobs
  010_stripe_payments.sql      # stripe_customers/subscriptions/webhook_events
  011_checkout_sessions.sql    # checkout_sessions audit trail + active_user_plan view
scripts/
  snapshot-stats.js            # daily YouTube-channel rollup → artist_stats_daily
  extract-features.py          # yt-dlp + librosa worker (drains the job queue)
  enqueue-features.js          # seed track_extraction_jobs from artist uploads
                               # (Phase 2d adds --reextract VERSION for the
                               # analyzer_version-driven re-extract policy)
  run-extract-worker.sh        # Phase 2d: long-running drain-and-sleep loop
                               # around extract-features.py, supervised by
                               # the launchd agent below.
  install-launchd-extract.sh   # Phase 2d: installs com.txrappertracker.extract
                               # LaunchAgent (KeepAlive on non-zero exit).
  install-launchd-snapshot.sh  # daily snapshot agent (Phase 2b)
  test-features.sh             # /api/artists/:id/features smoke
  test-payments.sh             # /api/payments/* smoke (signature + ordering;
                               # Phase 2d added /plan, /checkout, /portal,
                               # 402 gating cases)
test/
  *.test.js          # offline node:test suites; cache.test.js needs Postgres
```

## Phase 2d operations cheat sheet

### Stripe webhooks in local dev

The webhook handler verifies signatures against `STRIPE_WEBHOOK_SECRET`,
and Stripe signs the *raw* request bytes — not parsed JSON. Locally,
forward webhooks with the Stripe CLI so you get a fresh, scoped signing
secret every run:

```bash
# 1. Forward webhook events to the local backend.
stripe listen --forward-to http://localhost:8787/api/payments/webhook
# Output includes: "Ready! Your webhook signing secret is whsec_…"
# Copy that whsec_ string.

# 2. In ANOTHER terminal, export it before starting the server.
export STRIPE_WEBHOOK_SECRET=whsec_...
export STRIPE_SECRET_KEY=sk_test_...
export STRIPE_PRICE_ID=price_...
npm start

# 3. Trigger a few events to exercise the receiver.
stripe trigger checkout.session.completed
stripe trigger invoice.paid
stripe trigger customer.subscription.deleted
```

`scripts/test-payments.sh` exercises the gating cases (anonymous 401s,
`/plan` returns `free` for fresh users, `/checkout` and `/portal` return
503 when keys are unset, paid endpoints return 402 for free users). Run
it before declaring a Stripe deploy ready.

### Long-running audio worker

Phase 2d.B1 ships a launchd-supervised drain-and-sleep loop:

```bash
# Install the agent (idempotent — re-running re-bootstraps the plist).
# DATABASE_URL must be exported so it lands in the plist's env.
export DATABASE_URL=postgres://...
bash scripts/install-launchd-extract.sh

# Inspect.
launchctl list | grep com.txrappertracker.extract
tail -F /tmp/extract-worker.out.log

# Restart after pulling new code.
launchctl kickstart -k gui/$(id -u)/com.txrappertracker.extract
```

The worker (`scripts/run-extract-worker.sh`) loops calling
`extract-features.py --max $WORKER_BATCH`, sleeping `WORKER_IDLE_SLEEP`
seconds when the queue is empty. KeepAlive=`{SuccessfulExit:false}` makes
launchd restart it on non-zero exit; `ThrottleInterval=30` prevents tight
crash loops.

### Re-extraction policy (`analyzer_version`)

`track_features.analyzer_version` records which librosa build computed
each row (e.g. `librosa-0.10.2`). When you bump the worker's analyzer
(library upgrade, new key-detection heuristic, energy-formula change),
flip every stale row back into the queue without truncating the table:

```bash
# Inside backend/.
node scripts/enqueue-features.js --reextract librosa-0.11.0
# → scans track_features, finds rows with analyzer_version != argument,
#   flips their track_extraction_jobs row back to status='pending'
#   (attempts=0, last_error=NULL), bumps enqueued_at to now() so the
#   newly-stale work lands behind any genuinely new uploads.
# Combine with --artist NAME to scope to one roster entry, or --limit N
# to bound a one-off backfill.
```

Existing `track_features` rows are preserved until the worker upserts a
fresh result. If a re-extraction fails, the old data is still readable
— degraded but not deleted.

## Security notes (read these)

- The YouTube API key lives on the server only. If you ever see `AIza…` in
  the browser's DevTools, something is wrong. Stop and fix it.
- All log output passes through `lib/logger.js`'s redactor. If you add new
  log fields, double-check the PII patterns still cover them.
- Inputs are Zod-validated before they hit any upstream call. Don't bypass
  validation "just for one endpoint."
- Rate limiting uses `req.ip`, which requires `trust proxy` to be correct
  for the deployment — the default assumes exactly one proxy hop
  (Cloudflare Tunnel).
