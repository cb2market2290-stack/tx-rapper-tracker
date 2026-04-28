# Phase 3b — design + Claude prompt lock-in

Status of writing: locked design, NOT a brainstorm. The point of this
doc is to nail down the artist-brief feature end-to-end *before* writing
code, because the cache key and the prompt body have to be agreed in
advance. Any change to the prompt invalidates the cache; we want exactly
one round of "decide what we're cooking" so the rest of 3b is mechanical.

This is the doc 3b.1 produces. 3b.2-3b.5 implement against it.

## Goal

A Premium-only paragraph that summarizes "what's happening with this
artist right now" — the kind of thing a label A&R or a journalist would
write after staring at the dashboard for two minutes, but generated on
demand by Claude. ~80-120 words. One paragraph, plain prose, no
formatting markup.

This is the second Premium lever (after audio features). It's
deliberately light to ship — no streaming UI, no chat, no follow-up.
A single string field on the artist detail page that says "here's what
the data says, in English."

## Surface area

```
GET /api/artists/:id/brief        → 200 { kind:'artists.brief', brief, generatedAt, cacheHit, model, tokensIn, tokensOut }
                                  → 402 if requirePaid({ minTier:'premium' }) trips
                                  → 404 if artist not found / archived
                                  → 503 if Claude is misconfigured (no API key) or upstream errored
                                  → 504 if Claude takes >25s
```

The endpoint is GET because it's idempotent — the cache key folds in
all inputs that could change the output, so two calls with the same
inputs return the same bytes. POST would imply mutation; we don't want
the frontend to have to think about CSRF for "show me the summary."

Mounted in `src/index.js` after `/api/artists` so it lives next to its
siblings:

```js
app.use('/api/artists', requireUser(), artistsRoutes);
```

The Premium gate lives on the route itself (not on the mount), same as
`/api/artists/:id/features` carries `requirePaid()` per-route.

## Data going into the prompt

These are the only inputs the prompt sees. If a field isn't in this
list it's not in the cache key either:

1. **Artist name** (`artists.name`).
2. **Last 14 snapshots** from `artist_stats_daily` — `as_of`, `views`,
   `subs`. Bounded at 14 so the prompt is small + the cache key
   collapses cleanly to "as_of of the latest row."
3. **Breakout signals row** for this artist from
   `breakout_signals` — `views_now`, `views_7d_ago`, `views_14d_ago`,
   `view_growth_7d`, `pct_growth_7d`, `acceleration_7d`,
   `has_full_window`. The matview already has all the windowing math
   computed; we don't redo it in JS.
4. **Audio features summary** from `services/features.js#aggregate` —
   `trackCount`, `tempoBpmAvg`, `tempoBpmMin`, `tempoBpmMax`,
   `energyAvg`, `rmsDbAvg`, `dominantKey`. Per-track rows are NOT
   passed in (they bloat the prompt with no signal beyond the
   aggregate).

That's it. No video metadata, no roster context (who else is on the
list), no historical briefs. Keep the prompt small + the cache key
small.

## Cache key — the lock-in

The point of a cache key is "if these inputs are the same, the output
is the same, so we already have it." Anything that affects the output
must be in the key.

```
key_inputs = {
  artist_id:                    uuid,
  latest_snapshot_at:           date,         -- MAX(captured_on) from artist_stats_daily
  latest_features_extracted_at: timestamptz,  -- MAX(extracted_at) from track_features (NULL ok)
  prompt_version:               text,         -- 'v1' for the prompt below; bump on any change
  model:                        text,         -- e.g. 'claude-haiku-4-5-20251001'
}
fingerprint = sha256(JSON.stringify(key_inputs))
```

(Note: `artist_stats_daily` is keyed on `(artist_name, captured_on)`
with no surrogate id, so we use `MAX(captured_on)` as the snapshot
freshness signal. Same idea as a row id — it advances exactly once per
artist per day, and only when the snapshot cron writes new data.)

Why these fields specifically:

- `latest_snapshot_at` is the natural change signal for the snapshots
  input. The cron writes one row per artist per day; when it advances
  the brief is potentially stale.
- `latest_features_extracted_at` covers the audio-features input
  without us having to walk every track row. If a re-extract lands
  a fresher row, the timestamp bumps and the brief is stale.
- `prompt_version` covers prompt-engineering changes. Bumping `'v1'`
  → `'v2'` invalidates every cached row in one move, which is what we
  want when we change what Claude is asked.
- `model` covers Anthropic releasing a new Haiku. Same logic — output
  shape can shift, blow the cache.
- We do NOT key on `breakout_signals`. The matview is refreshed by
  the same cron that writes a new snapshot row, so its freshness is a
  function of `latest_snapshot_id`. Adding it to the key would create
  spurious cache-misses.

The `(artist_id, fingerprint)` pair is the unique constraint on the
cache table. Two writes with the same fingerprint are no-ops.

## Cache table (3b.2)

See `migrations/015_artist_briefs.sql` — the migration is the
canonical schema. Summary: a `BIGSERIAL` PK plus a UNIQUE
`(artist_id, fingerprint)` constraint that doubles as the cache-key
lookup index, with the brief, tokens_in/out, prompt_version, and
model all stored on the row for billing + invalidation queries.

Read path: `SELECT brief, generated_at, model, tokens_in, tokens_out
FROM artist_briefs WHERE artist_id = $1 AND fingerprint = $2`. Returns
0 or 1 row. On 0, generate + insert. On 1, return immediately —
`cacheHit: true`.

Old fingerprints linger forever (no TTL). They're tiny (~600 bytes
each) and they make "show me how the brief changed when X happened"
trivially queryable. If this becomes a storage problem we add a
`DELETE FROM artist_briefs WHERE generated_at < NOW() - INTERVAL '90
days'` to the snapshot cron, but not yet.

## Service module (3b.3)

`src/services/briefs.js` exports:

```js
export async function getOrGenerateBrief(artistId)
export async function _generateForTests(inputs)   // test seam — bypasses cache + Claude
export const PROMPT_VERSION = 'v1'
export const DEFAULT_MODEL  = 'claude-haiku-4-5-20251001'
```

The Claude SDK is `@anthropic-ai/sdk` — added in 3b.3 as a new dep.
Installed via the existing dep policy (npm install, no global flags).

Config additions (3b.3):

```
ANTHROPIC_API_KEY=                      # required for /api/artists/:id/brief
ANTHROPIC_BRIEF_MODEL=                  # default: claude-haiku-4-5-20251001
ANTHROPIC_BRIEF_TIMEOUT_MS=25000        # 25s — past this we return 504
```

If `ANTHROPIC_API_KEY` is unset, `getOrGenerateBrief` throws a
`HttpError(503, 'briefs_unconfigured', '…')` for cache-miss requests.
Cache hits still return the stored brief — they don't need the SDK.

## The prompt — locked at v1

System message:

```
You are a music industry analyst writing a one-paragraph briefing for
a label A&R team. The team is looking at a dashboard that tracks Texas
female rappers via YouTube channel stats and audio features. They have
the numbers in front of them — your job is to interpret what the
numbers say in plain prose, the way a knowledgeable colleague would
narrate it over the analyst's shoulder.

Write 80 to 120 words, one paragraph, no bullet points, no headers, no
markdown formatting. Lead with the most interesting signal in the
data. If 7-day growth or acceleration is positive, say so concretely
("up roughly 1.4M views in the last week"). If audio features show a
distinct profile (a dominant key, a tight tempo range, unusually high
or low energy), weave it in as one short clause. End with a forward
look — what an A&R team should do or watch for, given the data.

Do not invent facts that are not in the input. Do not name songs,
collaborators, labels, or events that are not in the input. Do not
speculate about chart positions, streaming numbers on platforms not
shown, or industry rumors. The only ground truth is the JSON below.
If a field is null, treat it as unknown and skip it rather than
guessing.

Write in present tense. Write in declarative sentences. Do not start
with "This artist" or the artist's name — start with the most
interesting fact and let the subject emerge naturally. Do not use the
words "data" or "metrics" — talk about views, growth, tempo, energy,
the music itself.
```

User message:

```
Artist: ${artistName}

Last 14 daily snapshots (most recent last):
${snapshotsCompactJson}

Breakout-window signals (computed from the snapshots):
${breakoutSignalsJson}

Aggregated audio features:
${featuresAggregateJson}

Write the briefing.
```

`snapshotsCompactJson` is `[{d:"2026-04-15", v:38900000, s:1240000}, ...]`
— the keys are deliberately short to keep the token count down.
`breakoutSignalsJson` is the `shapeRow` output from
`services/breakout.js`, with null fields stripped. `featuresAggregateJson`
is the `aggregate` output from `services/features.js`, with null fields
stripped.

API call params:

```
model: DEFAULT_MODEL                      // claude-haiku-4-5
max_tokens: 320                            // ~250 words headroom; we trim post-hoc
temperature: 0.3                           // tight, consistent voice
system: <system message above>
messages: [{ role:'user', content:<user message above> }]
```

**Why temperature 0.3:** the brief is more "explain the data" than
"creative writing." We want consistent voice + low spread between
generations of the same input (helps the cache feel believable). 0
would feel robotic; 0.7 produces noticeably different briefs for the
same numbers.

**Why max_tokens 320:** 100 English words ≈ 130-150 tokens. 320 gives
Claude room to overshoot into the cache-rejected zone (>120 words →
truncate or re-ask), but also caps cost at <$0.001 per call on Haiku
4.5 pricing.

**Why Haiku 4.5 specifically:** the prompt is 800-1200 tokens of input
+ ~150 tokens of output. Haiku 4.5 is the cost-effective choice; Sonnet
or Opus are overkill for "summarize this JSON in 100 words." We can
swap to Sonnet via env var if quality complaints land — the cache key
includes `model` so it'll regenerate cleanly.

## Output shaping

Post-call:
1. Trim leading/trailing whitespace.
2. Reject (and re-call once with `temperature: 0.1`) if word count
   <50 or >180. After one retry, return whatever Claude gave us — we
   don't want infinite loops.
3. Reject (and surface a soft fail to the route) if the response
   contains URLs, code fences, list markers, or markdown headers — the
   prompt says no formatting; if Claude breaks the rule we don't
   silently ship it.

## Frontend (3b.5)

Artist detail page surface:

```
┌─ Artist brief ────────────────── [Premium] ──┐
│ <paragraph>                                  │
│                                              │
│ <small>Generated 2 hours ago · Haiku 4.5     │
│  Refresh available when new data arrives.    │
└──────────────────────────────────────────────┘
```

- For Premium users: render the brief, plus a small "Generated <when>"
  caption showing `generatedAt`. The caption uses the same time-ago
  helper the freshness badge uses.
- For Free / Pro: render the upgrade-card pattern from
  `/api/artists/:id/features`, with the same CTA copy ("Unlock AI
  briefs with Premium"). The 402 dispatch already exists in app.html;
  3b.5 just adds another branch.
- For artists with 0 snapshots: render "No data yet — the brief will
  appear after the next snapshot." Don't call Claude — that would
  produce a low-information brief on a useless input.
- There is no manual "Refresh" button. The brief regenerates when the
  cache key changes (next snapshot, next re-extract, or prompt-version
  bump). Manual refresh would let users burn API credits on an
  unchanged input.

## Tests + smoke (3b.5)

Unit tests in `test/briefs.test.js`:

1. `fingerprint(...)` is deterministic for the same inputs.
2. `fingerprint(...)` differs when any of `prompt_version`, `model`,
   `latest_snapshot_id`, `latest_features_extracted_at` change.
3. `_generateForTests({ ... }, fakeClaudeClient)` returns the
   shaped brief without hitting the network.
4. `getOrGenerateBrief` returns `cacheHit: true` on the second call
   with identical inputs (mock the DB).
5. The output-shaping rejection logic flips `(temperature: 0.1)` on
   retry and returns whatever the second call produced.

Integration smoke `scripts/test-briefs.sh`:

1. Sign up → upgrade to Premium (mock the webhook) → request brief →
   200 + `cacheHit: false`.
2. Same artist, same window → 200 + `cacheHit: true`, byte-identical
   brief.
3. Free user → 402 with `kind:'payments.required'` and
   `minTier:'premium'`.
4. Unknown artist → 404.
5. With `ANTHROPIC_API_KEY` unset → 503 on cache-miss, 200 on cache
   hit (an old brief survives the misconfiguration).

## What gets explicitly deferred

- Streaming the brief token-by-token. The latency cap (25s) covers
  the worst case fine; streaming adds frontend complexity for a
  marginal UX win on a one-paragraph response.
- A "thumbs up / thumbs down" on the brief. Useful eventually for
  prompt iteration, but it requires a second table + frontend wiring;
  defer to 3c if 3b ships well.
- A digest email built from the briefs. That's what 3d in the Phase 3
  brainstorm covers. Don't conflate it with 3b.
- TikTok / Spotify inputs. 3b uses only what we already collect.
  Track C in the Phase 3 brainstorm covers adding sources later.

## Open questions explicitly closed by this doc

These were the open questions in the Phase 3 brainstorm. Answers below
are the locked-in decisions:

| # | Question | Answer |
|---|----------|--------|
| 1 | What's the Claude prompt for the AI brief? | Locked above (v1). Bump to v2 on any change. |
| 2 | Where does the cache key fold in? | (artist_id, fingerprint(snap_id, features_ts, prompt_v, model)). |
| 3 | Which model? | Haiku 4.5 (`claude-haiku-4-5-20251001`); env-overridable. |
| 4 | Streaming? | No — non-streaming, capped at 25s. |
| 5 | Manual refresh button? | No — cache invalidation drives regeneration. |
