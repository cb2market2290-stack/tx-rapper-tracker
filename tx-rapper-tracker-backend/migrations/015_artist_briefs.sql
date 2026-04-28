-- migrations/015_artist_briefs.sql
-- Phase 3b.2 — cache table for AI-generated artist briefs.
--
-- The brief is a Claude-generated paragraph (~80-120 words) that
-- interprets an artist's recent snapshot history + audio features in
-- plain prose. Generation is expensive (Claude API call); the read
-- path is hot (Premium-only artist detail page). So: cache.
--
-- Cache key design (locked in PHASE_3B_DESIGN.md):
--
--   fingerprint = sha256(JSON.stringify({
--     artist_id,
--     latest_snapshot_at,            -- MAX(captured_on) from artist_stats_daily
--     latest_features_extracted_at,  -- MAX(extracted_at) from track_features (NULL ok)
--     prompt_version,                -- 'v1' for this commit; bump invalidates
--     model                          -- e.g. 'claude-haiku-4-5-20251001'
--   }))
--
-- Two requests with identical (artist_id, fingerprint) hit the same row;
-- one snapshot day later or one prompt-version bump later, the
-- fingerprint changes and we generate fresh. The snapshot cron is the
-- only thing that advances latest_snapshot_at, so the cache invalidates
-- exactly once per artist per day in steady state — bounded API spend.
--
-- Why we DON'T key on breakout_signals: that matview is downstream of
-- artist_stats_daily and gets refreshed by the same cron pass that
-- writes new snapshots. Its freshness is a function of
-- latest_snapshot_at, not an independent input. Adding it to the key
-- would cause a spurious extra cache miss the first time the matview
-- is refreshed after a snapshot lands.
--
-- Old fingerprints linger forever (no TTL). They're tiny (~600 bytes
-- each) and they make "show me how the brief shifted when X happened"
-- trivially queryable. If storage becomes a problem we add a sweep to
-- the snapshot cron, but not yet.

BEGIN;

CREATE TABLE IF NOT EXISTS artist_briefs (
  id              BIGSERIAL PRIMARY KEY,
  artist_id       UUID         NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  -- sha256 hex of the canonicalized key_inputs JSON. 64 chars; we use
  -- TEXT not BYTEA because comparing text in WHERE is faster than
  -- bytea on small payloads and the read path filters on this column.
  fingerprint     TEXT         NOT NULL CHECK (length(fingerprint) = 64),
  -- Captured for debugging + for the regenerate-on-prompt-change
  -- workflow ("show me every cached row generated against v1").
  prompt_version  TEXT         NOT NULL,
  model           TEXT         NOT NULL,
  -- The paragraph itself. CHECK so a corrupted-write doesn't park an
  -- empty brief in the cache; the service module does word-count
  -- shaping before insert.
  brief           TEXT         NOT NULL CHECK (length(brief) > 0),
  -- Billing telemetry — handy for "what did this feature cost us this
  -- month" without parsing logs. Nullable because old rows from before
  -- we tracked tokens stay valid; we don't want to re-call Claude
  -- just to fill in a column.
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  generated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- The (artist_id, fingerprint) pair is the cache key. Two writes
  -- with the same fingerprint should be a no-op; the read path uses
  -- this constraint as the lookup index too.
  CONSTRAINT artist_briefs_unique UNIQUE (artist_id, fingerprint)
);

-- Lookup pattern: "the latest brief I've ever generated for this
-- artist, regardless of cache key". Rare — used by an admin debug
-- endpoint and a possible future "history" view — but the cost of the
-- index is one btree on a small table, so cheap to keep.
CREATE INDEX IF NOT EXISTS artist_briefs_artist_recent_idx
  ON artist_briefs (artist_id, generated_at DESC);

COMMENT ON TABLE artist_briefs IS
  'Cached Claude-generated artist briefs. Cache key = (artist_id, fingerprint) where fingerprint folds in latest_snapshot_at + latest_features_extracted_at + prompt_version + model. See PHASE_3B_DESIGN.md.';

COMMIT;
