-- migrations/003_cache.sql
-- Persistent cache for upstream API responses (YouTube + Trends).
--
-- Why a table instead of node-cache: node-cache lives in process memory, so
-- every server restart blows away the cache and the next page load hammers
-- YouTube (each /search costs 100 quota units; the free daily ceiling is
-- 10,000). This table keeps cached payloads across restarts and across
-- horizontally-scaled processes if we ever go that route.
--
-- Design:
--   * key:        opaque cache key (e.g. "yt:search:megan thee stallion:10:relevance:video")
--   * value:      JSONB payload exactly as returned by the upstream
--   * expires_at: when the entry becomes stale; reads filter on now() < expires_at
--
-- Eviction is lazy — readers ignore expired rows; a periodic sweep drops
-- them. We don't bother with LRU because the working set is tiny.

CREATE TABLE IF NOT EXISTS cache (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Used by the periodic sweep to find stale rows quickly.
CREATE INDEX IF NOT EXISTS cache_expires_idx
  ON cache (expires_at);
