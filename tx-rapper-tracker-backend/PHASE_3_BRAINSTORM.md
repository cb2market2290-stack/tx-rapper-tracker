# Phase 3 — brainstorm

Status of writing: brainstorm, not a commitment. The point of this doc is to
lay out the candidate tracks for Phase 3, weigh them against each other, and
end with a recommended order — not to nail down a spec.

## Where we ended Phase 2

Capability surface as of `5f3afeb` (deploy log) / `3279513` (Phase 2e.B):

- **Auth, sessions, audit** — argon2id signup, password reset via mailer,
  zxcvbn + HIBP gates, TOTP + WebAuthn 2FA, admin disable/enable, full
  audit_log on every state-changing event.
- **Tracking surface** — YouTube channel-stats snapshots (daily cron at
  04:00), 12-month chart, ranking math (lifetime views + velocity).
- **Audio features** — yt-dlp + librosa worker draining
  `track_extraction_jobs` under launchd; `analyzer_version`-driven
  re-extraction; gated behind `requirePaid`.
- **Payments** — Stripe Checkout + Customer Portal + webhook,
  `active_user_plan` view as the single source of truth, multi-tier
  pricing (free / pro / premium) via the `pricing_tiers` lookup table.
- **Admin** — read-only audit + sessions, write surface for
  revoke/disable/enable + artist roster, audio extraction jobs panel
  (re-extract + retry).
- **Deploy** — DEPLOY.md runbook, verified through Cloudflare quick
  tunnel end-to-end (DEPLOY_LOG.md).

What we don't have yet: anything that *uses* the data we collect to push
information out to the user. Snapshots accumulate, audio features
accumulate, but nothing turns them into a notification, a digest, an
insight, or an alert. The user has to log in and hunt. That's the gap
Phase 3 should close.

## Candidate tracks

Not all of these survive — the point is to lay them out so the
trade-offs are visible.

### Track A — Insights that justify Pro/Premium

The pricing tiers shipped in 2e.A but the *reason* to upgrade is still
just "see audio features." Pro especially needs another lever or it
churns. Concrete pieces:

- **Breakout score / velocity signals.** Daily diff over
  `artist_stats_daily` → "biggest 7-day mover", "fastest velocity".
  Cheap to compute (one window function) and visually punchy on a
  dashboard.
- **Saved searches + email alerts.** "Alert me when any TX rapper
  crosses 1M views in 7 days." DB-side: `saved_searches` table,
  evaluator job piggybacking on the snapshot cron, mailer reuses
  Phase 2b's pluggable mailer.
- **AI-generated artist briefs.** Claude summarizes "what's happening
  with X" — pulls last 14 snapshots + last 5 features rows, returns a
  paragraph. Cache by `(artist_id, hash(latest_snapshot_id, latest_features_id))`
  so the same brief isn't regenerated until something changes. Premium-only
  so the API spend is bounded.
- **Custom comparison sets.** Users save 3-5 artists into a "set" and
  the dashboard pivots on that set. Builds on the existing compare bar.

### Track B — Distribution / growth

Multi-tier pricing only matters if the funnel is filling. Concrete
pieces:

- **Public artist profile pages.** Render a slug-routed read-only view
  (`/a/megan-thee-stallion`) with the snapshot chart + a sign-up CTA.
  Indexable. SEO win.
- **Shareable comparison links.** `/compare?ids=a,b,c` — same backend
  endpoint as the in-app compare, but un-gated and non-interactive.
- **Weekly digest email.** "Top 5 movers this week, plus 1 emerging
  artist we noticed." Free-tier opt-in; the email is the funnel.
- **Referral program.** A referred signup that converts to paid earns
  the referrer a month of Pro. Stripe coupons + a `referrals` table.

### Track C — Platform expansion

YouTube-only is a scoping decision, not a permanent one. Adding
sources is high-impact but the per-source integration cost is
non-trivial.

- **TikTok integration** — biggest discovery surface for music in 2026,
  but the API access tier matters and may force scraping.
- **Spotify integration** — clean OAuth, monthly listeners + popularity
  + "fans also like." Cleanest API of the bunch.
- **Apple Music** — Apple's MusicKit JS exists but the data is thin
  compared to Spotify.
- **SoundCloud** — culturally relevant for the genre, but API is shaky.

### Track D — Pro tooling for B2B users

If Premium is going to anchor at $30/mo+, the buyer is probably a label
A&R or a small agency, not an individual fan. Things they want:

- **CSV / Excel export** — one click on any artist or comparison.
- **API access** — read-only endpoints with a token, rate-limited
  per token. Documents the contract we already have.
- **Bulk operations** — a label cares about 30 artists at once, not 1.
- **White-label PDF reports** — Claude-generated, branded with the
  user's logo. Big differentiator vs. spreadsheets.

### Track E — Mobile + PWA polish

The app is responsive but not installable. Low effort, real impact:

- **PWA manifest + service worker** — installable, offline-tolerant
  for the dashboard (cached snapshots).
- **Push notifications** — for the alerts work in Track A. Web Push
  is mature on iOS Safari and Android Chrome now.

### Track F — Community

The least obvious lever. Comments, fan profiles, "I called this artist
first" badges. High moderation cost, slow to bootstrap, easy to
undercut by a Twitter thread instead. Probably not Phase 3.

## Recommended path

The thing that increases retention AND unlocks Premium pricing is
Track A. The thing that fills the top of the funnel is Track B. So:

**3a. Breakout signals + alerts (≈2 weeks).**
Migration for `breakout_signals` (materialized view refreshed by cron),
saved_searches, evaluator job. New `/api/insights/breakout` and
`/api/saved-searches`. Frontend: a "movers" strip on the dashboard +
modal to save a search + an alerts panel in account settings. Reuses
the snapshot cron + the mailer; no new infra.

**3b. AI artist briefs (≈1 week).**
Premium-only `/api/artists/:id/brief` that calls Claude with a tight
prompt + the cached payload, returns markdown. UI on the detail page.
Bounded spend by caching on `(latest_snapshot_id, latest_features_id)`.

**3c. Public profile pages + shareable compare (≈1 week).**
New mount `/a/:slug` and `/compare/:hash` that bypass `requireUser`,
serve a stripped-down view, and inject a "Sign up to track this artist"
CTA. SEO matters here — server-renders the snapshot table for crawlers
even though the chart hydrates on the client.

**3d. Weekly digest + referral (≈1 week, optional).**
Cron-driven digest email keyed on the breakout signals from 3a, plus
a Stripe coupon issued via the existing webhook on a referred signup.

That gives Phase 3 ≈4-5 weeks of focused work where every piece
reinforces the pricing model that just shipped, without taking on the
integration cost of a second platform yet.

## What gets explicitly deferred

- TikTok/Spotify/Apple Music — Phase 4. Bundle them as "platform
  expansion" and pick one based on whichever data we *most* miss when
  building the breakout-signal insights in 3a.
- Native mobile — PWA covers 80% of it. Skip to native only if the
  push-notification-on-iOS path through PWA breaks down.
- Community — out of scope until the data side feels finished.

## Open questions for the design pass

1. Does the breakout-signal evaluator run inline in the snapshot cron
   or as a separate launchd job? (Inline is simpler; separate is more
   inspectable.)
2. What's the Claude prompt for the AI brief? Lock it in early — every
   change invalidates the cache.
3. Do public profile pages need a robots.txt allow-list per artist, or
   blanket-allow? (Some artists might object; default opt-in feels
   right but it's a real choice.)
4. Does the digest email use the Pro plan's email cap or its own? Same
   for push notifications.
5. Stripe coupon for referral — fixed-amount or percentage? The
   `pricing_tiers` shape will determine which is cleaner.

These don't need answers in this doc. They need answers before 3a
ships.
