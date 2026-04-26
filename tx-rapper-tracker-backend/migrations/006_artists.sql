-- migrations/006_artists.sql
-- Move the tracked-artist roster out of source code (was duplicated in
-- app.html's ARTISTS const + scripts/snapshot-stats.js's ARTISTS const)
-- and into a proper table so admins can edit it without a deploy.
--
-- Design notes:
--   * name is the business key — artist_stats_daily.artist_name and the
--     frontend both identify artists by name. The UUID id is a surrogate
--     for admin API URLs.
--   * Soft delete via is_archived so toggling an artist off doesn't
--     orphan their historical stats rows.
--   * sort_order controls the order the frontend displays them. Ties
--     break by name for deterministic output.
--   * Seed row set matches the old hardcoded list exactly — callers that
--     don't know about this table yet still see the same roster.

CREATE TABLE IF NOT EXISTS artists (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  sort_order  INT         NOT NULL DEFAULT 100,
  is_archived BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artists_active_idx
  ON artists (sort_order, name) WHERE NOT is_archived;

-- Seed. ON CONFLICT so this migration is safe to re-run (e.g. rolled into
-- a new dev box). Sort_order mirrors the original array order.
INSERT INTO artists (name, sort_order) VALUES
  ('Megan Thee Stallion', 10),
  ('Tay Money',           20),
  ('Asian Doll',          30),
  ('Cuban Doll',          40),
  ('KenTheMan',           50),
  ('GloRilla',            60)
ON CONFLICT (name) DO NOTHING;
