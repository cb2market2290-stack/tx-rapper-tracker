-- migrations/014_saved_searches.sql
-- Phase 3a.2 — saved searches + tier-capped quota.
--
-- A saved search is a user-level alert predicate against the breakout_signals
-- matview (and a couple of raw artist_stats_daily metrics). It's the input
-- to the 3a.3 evaluator: every snapshot cycle we walk every enabled saved
-- search, check the predicate, and maybe email the owner.
--
-- Why one row per (predicate, threshold) instead of a JSON-blob "rule":
--
--   * Tier-cap enforcement is a SELECT count(*) on (user_id) — trivial, and
--     SQL stays the source of truth for "how many do you have left".
--   * The evaluator's hot path is a join: saved_searches × breakout_signals
--     on the predicate. A normalised shape lets us put a partial index on
--     `enabled` (only enabled rows ever fire) and on `metric` if we ever
--     want to evaluate a subset of metrics independently.
--   * Adding a new predicate kind ('lifetime_views_above') means a CHECK
--     constraint update + an evaluator branch — tracked cost.
--
-- Tier caps live in JS (services/savedsearches.js TIER_CAPS), not the DB.
-- The DB enforces shape; the application layer enforces "how many you can
-- have at this tier" against active_user_plan, so changing caps is a
-- code-deploy not a migration.

BEGIN;

CREATE TABLE IF NOT EXISTS saved_searches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Free-form label the user picks ("Megan over 1M weekly", "Anyone
  -- accelerating fast"). Bounded so the DB row stays sane.
  name                  TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  -- Which signal to evaluate. Mirrors the breakout_signals matview
  -- columns + one raw lifetime_views passthrough. Adding to this list
  -- means: update the CHECK, update VALID_METRICS in the service module,
  -- and add a branch in the 3a.3 evaluator.
  metric                TEXT NOT NULL CHECK (metric IN (
                          'view_growth_7d',
                          'pct_growth_7d',
                          'acceleration_7d',
                          'lifetime_views'
                        )),
  -- Threshold to compare against. DOUBLE PRECISION so pct (0.05 = +5%)
  -- and view counts (250000.0) both fit. The service module rejects
  -- thresholds that don't make sense for the chosen metric (e.g. negative
  -- view count, pct outside [-1.0, 100.0]) before they reach the DB.
  threshold             DOUBLE PRECISION NOT NULL,
  -- Comparison operator. '>'/'>=' for "alert when bigger", '<'/'<='
  -- for cooling-off alerts ("alert me when GloRilla drops below…").
  comparator            TEXT NOT NULL CHECK (comparator IN ('>', '>=', '<', '<=')),
  -- Optional artist scope. NULL = match any artist (the breakout-list
  -- alert we recommended in the brainstorm); set = single-artist watch.
  -- ON DELETE SET NULL: archiving an artist shouldn't nuke the user's
  -- saved search, just unscope it.
  artist_id             UUID REFERENCES artists(id) ON DELETE SET NULL,
  -- Soft on/off so users can pause an alert without destroying its
  -- last_alerted_at (which they'd need if they re-enable). Default
  -- enabled because that's why they made it.
  enabled               BOOLEAN NOT NULL DEFAULT true,
  -- Cron-side breadcrumbs. Written by scripts/snapshot-stats.js (3a.3)
  -- when an alert fires, and read by the evaluator to enforce
  -- "at most one email per saved search per day" regardless of tier.
  last_alerted_at       TIMESTAMPTZ,
  last_match_artist_id  UUID,
  last_match_value      DOUBLE PRECISION,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cap-counting query: SELECT count(*) FROM saved_searches WHERE user_id=$1.
-- A simple btree on user_id is exactly right; no need to make it WHERE
-- enabled because the cap counts disabled rows too (the user still owns
-- them and enabling is one click).
CREATE INDEX IF NOT EXISTS saved_searches_user_idx
  ON saved_searches (user_id);

-- Evaluator hot path: every refresh, scan only the enabled rows.
-- Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS saved_searches_enabled_idx
  ON saved_searches (enabled, user_id) WHERE enabled;

-- Lookup-by-id-and-owner (PATCH/DELETE check ownership).
CREATE INDEX IF NOT EXISTS saved_searches_owner_idx
  ON saved_searches (user_id, id);

-- updated_at autotouch — keeps the API's "last edited" surface honest
-- without bouncing the responsibility into JS.
CREATE OR REPLACE FUNCTION touch_saved_searches_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS saved_searches_touch ON saved_searches;
CREATE TRIGGER saved_searches_touch
  BEFORE UPDATE ON saved_searches
  FOR EACH ROW
  EXECUTE FUNCTION touch_saved_searches_updated_at();

COMMENT ON TABLE saved_searches IS
  'Per-user alert predicates against breakout_signals. Tier caps enforced in app code (services/savedsearches.js) against active_user_plan.';

COMMIT;
