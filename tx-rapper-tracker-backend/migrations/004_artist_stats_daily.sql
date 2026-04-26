-- migrations/004_artist_stats_daily.sql
-- One row per (artist, day) holding YouTube channel stats. Powers the
-- "12-month interest" chart on app.html with real data instead of the
-- synthetic noise+drift curve we started with.
--
-- We key on artist_name (the human-friendly string used in app.html's seed
-- list) so the chart can fetch history without resolving channel_id first.
-- channel_id is stored alongside for debugging and future joins.
--
-- Snapshots are idempotent: scripts/snapshot-stats.js runs an UPSERT on
-- (artist_name, captured_on), so re-running the script the same day is
-- a no-op aside from refreshing the values.

CREATE TABLE IF NOT EXISTS artist_stats_daily (
  artist_name    TEXT        NOT NULL,
  captured_on    DATE        NOT NULL,
  channel_id     TEXT,
  subs           BIGINT,
  lifetime_views BIGINT,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_name, captured_on)
);

-- The chart wants "give me this artist's last N days, oldest-first" — this
-- index makes that O(N) on the points, no sorts.
CREATE INDEX IF NOT EXISTS artist_stats_daily_artist_idx
  ON artist_stats_daily (artist_name, captured_on DESC);
