ALTER TABLE artists ADD COLUMN IF NOT EXISTS spotify_id TEXT;
CREATE INDEX IF NOT EXISTS artists_spotify_id_idx ON artists(spotify_id);
CREATE TABLE IF NOT EXISTS spotify_stats (
  id SERIAL PRIMARY KEY,
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  followers INTEGER,
  popularity SMALLINT,
  genres JSONB,
  monthly_listeners INTEGER
);
CREATE INDEX IF NOT EXISTS spotify_stats_artist_id_idx ON spotify_stats(artist_id);
CREATE INDEX IF NOT EXISTS spotify_stats_collected_at_idx ON spotify_stats(collected_at);
