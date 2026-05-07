ALTER TABLE artists ADD COLUMN IF NOT EXISTS tiktok_handle TEXT;
CREATE INDEX IF NOT EXISTS artists_tiktok_handle_idx ON artists(tiktok_handle);
CREATE TABLE IF NOT EXISTS tiktok_stats (
  id SERIAL PRIMARY KEY,
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  followers INTEGER,
  following INTEGER,
  total_likes INTEGER,
  video_count INTEGER,
  verified BOOLEAN
);
CREATE INDEX IF NOT EXISTS tiktok_stats_artist_id_idx ON tiktok_stats(artist_id);
CREATE INDEX IF NOT EXISTS tiktok_stats_collected_at_idx ON tiktok_stats(collected_at);
