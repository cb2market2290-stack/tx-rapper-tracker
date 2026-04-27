-- migrations/013_breakout_signals.sql
-- Phase 3a.1 — breakout signals.
--
-- A materialized view that turns the daily snapshot rows in
-- artist_stats_daily into per-artist movement metrics:
--
--   * views_now           - the most-recent snapshot of lifetime_views
--   * views_7d_ago        - the snapshot ~7 days before "now"
--   * views_14d_ago       - the snapshot ~14 days before "now"
--   * view_growth_7d      - views_now - views_7d_ago (raw delta)
--   * pct_growth_7d       - relative growth (lets small artists with big
--                           jumps surface alongside big artists)
--   * acceleration_7d     - week-over-week change in raw delta (positive =
--                           still picking up, negative = cooling off)
--   * has_full_window     - false until we have at least 14 days of data
--                           for the artist; lets the API hide noisy ranks
--                           on artists we've barely tracked
--
-- Why a materialized view, not a regular one or a table:
--
--   * Regular view → re-runs the 3 LATERAL subselects on every read. The
--     "movers strip" is on every dashboard load; that's a lot of replay
--     for data that only changes once a day.
--
--   * Table populated by a cron writer → equivalent in performance, but
--     splits the source-of-truth between SQL (the materialized view's
--     SELECT) and JS (the writer). With a matview the SQL is the contract;
--     `REFRESH MATERIALIZED VIEW CONCURRENTLY` is a one-liner.
--
--   * CONCURRENTLY needs a UNIQUE index — that's why breakout_signals_pk
--     exists (on artist_id). Without it readers see an empty matview for
--     a few hundred ms during refresh.
--
-- Refresh cadence: inline in scripts/snapshot-stats.js, right after the
-- snapshot rows are upserted. So the matview is always at most one
-- snapshot-cycle stale.

BEGIN;

-- Drop-and-recreate is fine here — the matview holds derivable data, so
-- we can rebuild it whenever the SELECT shape changes.
DROP MATERIALIZED VIEW IF EXISTS breakout_signals;

CREATE MATERIALIZED VIEW breakout_signals AS
WITH
  -- One reference date per refresh: the latest captured_on we have. If the
  -- table is empty we get NULL and the windowed CTEs short-circuit to
  -- NULLs everywhere — the matview will just have zero rows.
  params AS (
    SELECT MAX(captured_on) AS as_of FROM artist_stats_daily
  ),
  -- For each active artist, three correlated subselects: the most recent
  -- snapshot at or before "as_of", "as_of - 7d", and "as_of - 14d". Using
  -- "<= boundary" instead of "= boundary" tolerates a missed snapshot day
  -- (we just step back to the previous one we did capture).
  points AS (
    SELECT
      a.id   AS artist_id,
      a.name AS artist_name,
      p.as_of,
      (
        SELECT lifetime_views
          FROM artist_stats_daily s
         WHERE s.artist_name = a.name AND s.captured_on <= p.as_of
         ORDER BY s.captured_on DESC
         LIMIT 1
      ) AS views_now,
      (
        SELECT lifetime_views
          FROM artist_stats_daily s
         WHERE s.artist_name = a.name
           AND s.captured_on <= p.as_of - INTERVAL '7 days'
         ORDER BY s.captured_on DESC
         LIMIT 1
      ) AS views_7d_ago,
      (
        SELECT lifetime_views
          FROM artist_stats_daily s
         WHERE s.artist_name = a.name
           AND s.captured_on <= p.as_of - INTERVAL '14 days'
         ORDER BY s.captured_on DESC
         LIMIT 1
      ) AS views_14d_ago,
      (
        SELECT MIN(captured_on)
          FROM artist_stats_daily s
         WHERE s.artist_name = a.name
      ) AS first_snapshot
    FROM artists a, params p
    WHERE NOT a.is_archived
  )
SELECT
  artist_id,
  artist_name,
  as_of,
  views_now,
  views_7d_ago,
  views_14d_ago,
  COALESCE(views_now - views_7d_ago, 0)::BIGINT AS view_growth_7d,
  CASE
    WHEN views_7d_ago IS NULL OR views_7d_ago = 0 THEN NULL
    ELSE ((views_now - views_7d_ago)::DOUBLE PRECISION / views_7d_ago)
  END AS pct_growth_7d,
  COALESCE(
    (views_now - views_7d_ago) - (views_7d_ago - views_14d_ago),
    0
  )::BIGINT AS acceleration_7d,
  first_snapshot,
  -- has_full_window is the cheap way to filter out artists we haven't
  -- tracked long enough to make claims about. The API hides the others
  -- from the dashboard strip but still lets admins see them.
  (as_of IS NOT NULL
    AND first_snapshot IS NOT NULL
    AND (as_of - first_snapshot) >= INTERVAL '14 days'
  ) AS has_full_window,
  now() AS computed_at
FROM points;

-- Unique index on artist_id is mandatory for REFRESH ... CONCURRENTLY.
-- The PK conceptually — every active artist has at most one row.
CREATE UNIQUE INDEX breakout_signals_pk
  ON breakout_signals (artist_id);

-- Two sort indices for the dashboard's "top movers by X" queries. NULLS
-- LAST keeps artists with insufficient history out of the top of the
-- ranking instead of pinned to the top by Postgres's NULLS FIRST default.
CREATE INDEX breakout_signals_growth_idx
  ON breakout_signals (view_growth_7d DESC NULLS LAST)
  WHERE has_full_window;

CREATE INDEX breakout_signals_pct_idx
  ON breakout_signals (pct_growth_7d DESC NULLS LAST)
  WHERE has_full_window;

CREATE INDEX breakout_signals_accel_idx
  ON breakout_signals (acceleration_7d DESC NULLS LAST)
  WHERE has_full_window;

-- Initial population. Without this the very first call to the API after
-- migration returns nothing — `SELECT * FROM breakout_signals` on a
-- never-refreshed matview gives zero rows.
REFRESH MATERIALIZED VIEW breakout_signals;

COMMENT ON MATERIALIZED VIEW breakout_signals IS
  'Per-artist 7d/14d view-growth signals. Refreshed by scripts/snapshot-stats.js after each daily snapshot.';

COMMIT;
