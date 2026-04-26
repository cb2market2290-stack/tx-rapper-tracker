# Paste into Obsidian → Build Log

Copy the block(s) below and paste them as new rows in the Build Log note.
Latest entry first.

---

## 2026-04-26 — Phase 2d: Stripe Checkout + Customer Portal + audio worker daemon (Claude)

**Who did it:** Claude (Cowork). Phase 2d was the "turn it on" pass for
the receiver-shaped Stripe scaffolding from Phase 2c plus the long-running
half of the audio pipeline. No new architectural ground — every piece had
been pre-shaped — but a lot of small wiring decisions to keep the
production system loud-when-broken and quiet-when-healthy.

**What shipped** (in `~/clawd/projects/tx-rapper-tracker-backend/` and
`~/clawd/projects/tx-rapper-tracker/`):

- Stripe Checkout + Customer Portal
  - Migration `011_checkout_sessions.sql` — `checkout_sessions` audit
    trail (one row per Checkout Session we mint, with the `customer`,
    `subscription`, `price_id`, and `payment_status` fields we care
    about) plus an `active_user_plan` view that resolves `(plan,
    stripe_status, current_period_end, cancel_at_period_end)` for any
    user via a LEFT JOIN LATERAL over the most recent `stripe_subscription`
    row + `DISTINCT ON` on subscription id. The view is the single source
    of truth used by the gating middleware AND the `/api/payments/plan`
    endpoint, so the frontend, the request gate, and any future admin UI
    never disagree about a user's plan.
  - `src/services/stripe.js` adds `createCheckoutSessionForUser`,
    `createPortalSession`, `shapeCheckoutSession` (pure, testable),
    `recordCheckoutSession`, `getPlanForUser`. Lazy-imports the SDK so a
    sandbox without `stripe` installed still boots — the new helpers
    throw `'stripe disabled'` from `getStripe()` when keys are missing,
    and the route translates that into a 503.
  - `src/routes/payments.js` adds `POST /checkout` (creates Session,
    returns `{kind:'payments.checkout', url}` for the frontend to
    `location.assign`), `POST /portal` (Customer Portal redirect URL),
    and `GET /plan` (plan + subscription state). All three are behind
    `requireUser`. The webhook handler also dispatches
    `checkout.session.completed`, `invoice.paid`, and
    `invoice.payment_failed` so the audit table fills in even before a
    `customer.subscription.*` event lands.
  - `src/middleware/requirePaid.js` — gate keyed on `active_user_plan`.
    Free users hitting paid endpoints get a 402 with
    `{kind:'payments.required', plan:'free', message:…}`. Wired into
    `GET /api/artists/:id/features` so the audio panel becomes the
    upgrade prompt.
  - Frontend (`tx-rapper-tracker/app.html`) — `loadPlan()` after every
    sign-in success path, `userPlan` global, `.plan-pill` next to the
    auth widget that flips to "Paid" or "Upgrade" based on
    `active_user_plan`, `startCheckout()` / `openCustomerPortal()`
    handlers, 402 path through `proxyGet` raises an Error with
    `.status=402` and `.body=<server payload>` (and notably does NOT
    flip `backendOk = false` so the demo banner doesn't trip), audio
    panel renders an inline `.feat-gate` Upgrade card when `gated:true`,
    `?checkout=success` flash + 5-attempt poll loop for the plan flip,
    `?checkout=cancel` flash, `?portal=closed` URL scrub. CSP-clean
    (`script-src-attr 'none'`) — every interaction is `data-action` +
    delegated dispatcher.

- Long-running audio worker + re-extraction policy
  - `scripts/run-extract-worker.sh` — drain-and-sleep loop around
    `extract-features.py`. Reads queue counts (`--status` JSON) before
    each cycle so an empty queue sleeps the long-idle interval instead
    of spinning up Python; busy cycles run `--max $WORKER_BATCH` then
    short-sleep. SIGTERM/SIGINT trap stops the loop gracefully (Python
    can finish the current job; a second TERM hard-kills). All env-knob
    driven (`WORKER_BATCH`, `WORKER_IDLE_SLEEP`, `WORKER_BUSY_SLEEP`,
    `WORKER_MAX_RUNTIME_SEC`). Structured stdout (`LVL ts key=val …`).
  - `scripts/install-launchd-extract.sh` — installs
    `com.txrappertracker.extract` LaunchAgent. KeepAlive on non-zero
    exit, `ThrottleInterval=30` so a fast crash doesn't burn CPU,
    `ProcessType=Background` + `Nice=5` so it stays out of the way of
    interactive use. PATH baked from resolved python/yt-dlp/ffmpeg dirs
    so launchd's bare PATH doesn't bite. Idempotent — `bootout`s any
    existing version before writing.
  - `src/services/features.js` adds `getStaleVideoIds(opts)` and
    `requeueForReextraction(pairs)`. Stale = `analyzer_version IS
    DISTINCT FROM` the supplied current version (NULL-safe). The
    re-enqueue helper does an UPSERT that flips `track_extraction_jobs`
    rows back to `status='pending'`, `attempts=0`, `last_error=NULL`,
    `enqueued_at=now()` — the existing track_features row is left in
    place (the worker upserts a fresh one on success, so degraded data
    is still readable on failure).
  - `scripts/enqueue-features.js` adds `--reextract VERSION` (and
    `--limit N` to cap one-off backfills). When invoked with
    `--reextract`, skips the YouTube discovery loop entirely; calls
    the new helpers and logs grouped counts of stale versions
    ("byVer: {librosa-0.10.2: 80, '<null>': 4}").

- Tests + smoke
  - `test/stripe.test.js` extended from 13 → 24 tests (11 new
    `shapeCheckoutSession` cases + 1 `getPlanForUser` falsy-userId fast
    path).
  - `test/features.test.js` extended from 18 → 21 tests
    (`getStaleVideoIds` validation, `requeueForReextraction` empty +
    malformed-pair short-circuits — both verified to NOT touch the DB).
  - `scripts/test-payments.sh` extended (anonymous 401s on /plan,
    /checkout, /portal; signed-in /plan returns `free`; /checkout +
    /portal return 503 with kind=='payments.disabled' when keys are
    unset; free user /api/artists/:id/features returns 402 with
    kind=='payments.required').

- Phase 2d docs + ops
  - `README.md` — bumped to "live build through Phase 2d", new endpoint
    inventory (checkout/portal/plan, 402 gating semantics), Phase 2d
    operations cheat sheet (Stripe CLI `stripe listen` recipe + launchd
    install + analyzer_version policy), layout map updated with
    migration 011 + the new scripts.
  - `BUILD_LOG_ENTRY.md` — this entry prepended above the Phase 2c block.
  - `scripts/log-obsidian-phase-2d.py` — idempotent Build Log + Error
    Log row writer.
  - `scripts/save-progress-2d.sh` — explicit-add commit script that
    skips `.env`, `node_modules`, sibling projects, and `__pycache__`.

- Live-verification fixes (caught by smoke, not by unit tests)
  - `src/index.js` — middleware-order bug. `cookieParser()` and
    `attachUser()` were mounted AFTER `app.use('/api/payments', …)`,
    so `requireUser()` inside the payments router never saw `req.user`
    and signed-in `/plan`, `/checkout`, `/portal` all returned 401
    instead of 200/503. Fix: hoisted `cookieParser` + `attachUser` ABOVE
    the `/api/payments` mount. Both only read headers + do a session-
    cookie DB lookup — they don't touch `req.body`, so the route-level
    `express.raw()` for the Stripe webhook is unaffected. Live smoke
    went 18/26 → 26/26 PASS after restart.
  - `scripts/test-payments.sh` — signup status check accepted only
    HTTP 200; live server returns 201 (correct REST semantics for
    resource creation). Loosened to `200 or 201`.

---

## 2026-04-25 — Phase 2c: audio features + Stripe scaffolding (Claude)

**Who did it:** Claude (Cowork). Two-track build per the brainstorm: per-
track audio analysis (yt-dlp + librosa) feeding the existing ranking, and
a Stripe payments scaffolding that's safe to ship "off" so Phase 2d can
turn it on without a refactor. Original Phase 2c scope was Stripe-only;
the audio side jumped the queue because the ranking engine was the
weakest signal in the app and the Stripe receiver-shaped half can sit
behind a kill-switch waiting on real keys.

**What shipped** (in `~/clawd/projects/tx-rapper-tracker-backend/` and
`~/clawd/projects/tx-rapper-tracker/`):

- Audio pipeline
  - Migration `009_track_features.sql` — `track_features` (numeric columns
    for tempo/key/mode/energy/RMS/spectral, derived camelot label, plus
    `extras JSONB` for forward-compat) + `track_extraction_jobs` work
    queue keyed `(artist_id, video_id)` with TEXT-CHECK status.
  - `scripts/extract-features.py` — Python worker. yt-dlp pulls a 3-min
    audio rip, librosa computes tempo / chroma / RMS / spectral
    centroid+bandwidth+rolloff, Krumhansl-Schmuckler picks the key and
    mode, results land in `track_features` and the job row goes
    `processing → done`/`failed`.
  - `scripts/enqueue-features.js` — seeds `track_extraction_jobs` from
    each artist's recent YouTube uploads so the worker has something to
    drain.
  - `src/services/features.js` — pure helpers (`cleanRow`, `dominantKey`
    duration-weighted with deterministic tie-break, `aggregate` returning
    summary + per-track rows + `featureBonus` in [0,1]) plus DB readers.
  - `GET /api/artists/:id/features` — gated like the rest of `/api/artists`,
    400 on bad UUID, 404 on unknown artist, 200 with `null` summary when
    the queue is empty (a deliberate "we know this artist, we just have
    no audio yet" answer rather than 404).
  - Frontend (`tx-rapper-tracker/app.html`) — `loadRoster()` keeps the
    full `{id, name}` pair from `/api/artists` so the detail page can
    fetch features by UUID. New "Audio features" panel renders summary
    grid (tempo, dominant key as Camelot pill, energy meter, sample
    size, score bonus) + per-track table truncated to 8 rows. Ranking
    formula gains `featureBonus * 5` (capped at 5 pts) so signal from
    audio analysis nudges placement without dominating it.
  - Tests: `test/features.test.js` (18 cases) covers `cleanRow` (incl.
    NUMERIC string coercion + mode 0→minor), `dominantKey` (1s floor +
    deterministic ties), and `aggregate` (averages, mins/maxes, the
    `featureBonus` formula, and a regression for `Number(null) === 0`
    polluting averages — caught and fixed during the run).
    `scripts/test-features.sh` covers the HTTP shape with a real signup.

- Stripe scaffolding
  - Migration `010_stripe_payments.sql` — `stripe_customers` (one row per
    user), `stripe_subscriptions` (PK on `stripe_subscription_id`, full
    period/cancel state, last raw payload as JSONB), and
    `stripe_webhook_events` for idempotency (PK `event_id`, ok flag,
    error message, payload).
  - `src/config.js` — env schema for `STRIPE_SECRET_KEY`,
    `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_API_VERSION`
    (pinned to `2024-06-20` so a Stripe-side default bump can't silently
    shift payload shapes). `stripe.enabled` flag + secrets masked in
    `redacted()`.
  - `src/services/stripe.js` — lazy dynamic-import of the Stripe SDK so
    the dev sandbox doesn't need it installed; `getStripe()` throws when
    keys are unset; pure helpers (`unixToDate`, `shapeSubscription`,
    `isActiveStatus`) tested offline.
  - `src/routes/payments.js` exported as `buildRouter()` so `index.js`
    can mount `express.raw({type:'application/json'})` AT THE ROUTE,
    ahead of the global `express.json()` — Stripe signs the raw bytes
    and a parsed body breaks signature verification. `POST /webhook`
    returns 503 when keys are unset (loud, not silent), 400 on missing
    or invalid signature, dedupes on `event.id`, dispatches
    `customer.subscription.{created,updated,deleted}` to upsert into
    `stripe_subscriptions`, and acks 200 even on internal handler
    errors (Stripe re-delivery doesn't fix our buggy code; the failure
    is persisted in `stripe_webhook_events`).
  - `GET /payments/status` — diagnostic for the readiness script /
    future admin widget. No subscription data leaked.
  - Tests: `test/stripe.test.js` (13 cases) covers the pure helpers and
    the disabled-config error path. `scripts/test-payments.sh` verifies
    the route mounting (incl. that `/api/auth/me` still works — i.e. the
    raw-body mount didn't accidentally swallow the JSON parser path).

- Docs: `README.md` updated to reflect the live build through Phase 2c
  (new endpoints, layout, what's still NOT done). `.env.example` extended
  with the four Stripe vars and a `LEAVE BLANK to disable payments` note.

**Why this order:** the ranking page was the user-facing weak link —
"who's blowing up?" with only subs + views + recency is shallow. Audio
features add a bounded but real signal (you can see it move). Stripe
in the same phase, but as scaffolding only: the receiver side is the
hard, security-critical piece (raw body, signature verification, idempotency,
disabled-state safety). Getting that right with no real keys means
Phase 2d is "wire checkout + portal", not "redesign the webhook layer".

**Next up:**

- [ ] Phase 2d (Claude): Stripe Checkout + Customer Portal redirects,
      `/api/payments/checkout` endpoint, frontend "Upgrade" CTA, paid-tier
      gating (probably on `/api/artists/:id/features` first since it's the
      most expensive path), real `stripe listen` end-to-end smoke.
- [ ] Phase 2d (Claude): long-running audio worker / cron driver so
      `track_extraction_jobs` drains on its own; re-extraction policy
      tied to `analyzer_version`.
- [ ] Polish pass: README cross-links, audit Build Log gaps from 2b.x,
      tighten log levels around the new code.
- [ ] Pre-launch: third-party pen test ($3K–$8K range per brainstorm).

**Security posture after 2c:** webhook signatures verified against raw
bytes (express.raw mounted ahead of express.json); webhooks idempotent
by event id; Stripe disabled-state returns 503 not 404 so misconfigured
deploys are loud; secrets masked in `config.redacted()`; the audio
pipeline runs server-side only (no yt-dlp invocation reachable from any
HTTP route). No new public-facing endpoints — `/features` is gated by
`requireUser()` like the rest of `/api/artists`.

---

## 2026-04-17 — Phase 2a: API-key proxy backend (Claude)

**Who did it:** Claude (Cowork). OpenClaw was not suited — qwen2.5-coder:1.5b
is too small for a ~1,000-line multi-file Node service. Per the Model
Limitation Note, small targeted edits only.

**What shipped** (in `~/clawd/projects/tx-rapper-tracker-backend/`):

- Node 20 / Express 4 skeleton, ES modules
- YouTube Data API v3 proxy: `/api/youtube/search`, `/channel`,
  `/channel/uploads`, `/videos`
- YouTube channel-stats history: `/api/stats/history` (daily subscriber/
  view counts, populated by `scripts/snapshot-stats.js`). Replaced the
  Google-Trends proxy in phase 2b.9 — upstream was bot-blocking.
- Zod input validation on every route
- node-cache with concurrent-load collapsing (`getOrFetch`)
- Helmet security headers (CSP, HSTS 2y preload, COOP, CORP, referrer-policy)
- Allow-list CORS including `null` origin for `file://` during dev
- Per-IP rate limit (60/min, draft-7 headers), skips `/health` + `/ready`
- Pino structured JSON logs + PII scrubber (masks `AIza…`, `sk_live/test_…`,
  `Bearer …`, emails, cookies, authorization headers)
- Fail-fast env validation (`src/config.js`); `redacted()` for safe log dumps
- Graceful SIGTERM/SIGINT shutdown with 10s force-exit
- `test/smoke.test.js` — offline tests for config, redaction, cache,
  concurrent-load collapsing
- `README.md`, `.env.example`, `.gitignore`
- `INTEGRATION.md` — step-by-step frontend patch guide
- `TASK.md` — scoped follow-up for OpenClaw (patch `app.html`)

**Why this order:** Phase 2a's single job is to get the YouTube API key off
the browser. Everything else in Phase 2 (Postgres, auth, Stripe, tracking)
assumes a trustworthy server surface — building those first without the key
moved would bake the anti-pattern in deeper.

**Next up:**

- [ ] OpenClaw: apply `TASK.md` (patch `app.html`, ~5 URL swaps + delete key
      input)
- [ ] Paul: copy `.env.example` → `.env`, paste real `YOUTUBE_API_KEY`,
      `npm install && npm test && npm start`
- [ ] Phase 2b (Claude): Postgres schema + user accounts + Argon2id auth +
      WebAuthn/TOTP MFA skeleton
- [ ] Phase 2c (Claude): Stripe Elements (SAQ-A), subscription plans
- [ ] Phase 2d (Claude): tracking/snapshot endpoints (persist chart points
      over time)
- [ ] Pre-launch: third-party pen test ($3K–$8K range per brainstorm)

**Security posture after 2a:** keys off the browser, logs scrubbed, inputs
validated, rate-limited, strict CSP, Cloudflare-Tunnel-ready. That's the
baseline the rest of the stack builds on.
