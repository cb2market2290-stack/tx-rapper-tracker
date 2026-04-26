-- migrations/005_snapshot_runs.sql
-- One row per scripts/snapshot-stats.js invocation. Lets the admin panel
-- answer "did last night's snapshot run, and did it succeed?" without
-- grepping server logs or inferring from artist_stats_daily row counts.
--
-- We write from the script itself — both success and failure paths —
-- so a silent YouTube-API outage doesn't go unnoticed for weeks.
--
-- Minimal schema on purpose: started_at is the primary key so runs are
-- unambiguously ordered; everything else is free-form for debugging.

CREATE TABLE IF NOT EXISTS snapshot_runs (
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now() PRIMARY KEY,
  finished_at     TIMESTAMPTZ,
  status          TEXT        NOT NULL CHECK (status IN ('ok', 'partial', 'error')),
  artists_total   INT,
  rows_upserted   INT,
  error_msg       TEXT,
  duration_ms     INT
);

-- Admin panel fetches "last N runs" — dominant query.
CREATE INDEX IF NOT EXISTS snapshot_runs_started_idx
  ON snapshot_runs (started_at DESC);
