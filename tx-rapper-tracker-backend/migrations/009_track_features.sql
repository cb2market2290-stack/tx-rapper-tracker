-- migrations/009_track_features.sql
-- Phase 2c: per-track audio features (tempo, key, energy, etc.) extracted
-- from YouTube audio rips by a Python worker (yt-dlp + librosa).
--
-- Two tables:
--   * track_features  — the durable result. One row per track we've
--                       successfully analyzed.
--   * track_extraction_jobs — the work queue. One row per track-to-be-
--                             analyzed, drained by the worker. Stays around
--                             after success so we can audit "why did/didn't
--                             this track get features?" without grepping
--                             logs.
--
-- Design notes:
--
--   * Both tables key on (artist_id, video_id). artist_id is a UUID
--     foreign key to artists(id) so deleting/archiving an artist drops
--     their features cleanly. video_id is the YouTube id (11 chars) —
--     the canonical, stable handle for a track.
--
--   * track_features stores the analysis output as plain numeric columns.
--     Why not JSONB? We want fast SUM/AVG/PERCENTILE for ranking
--     aggregation, and the schema is fixed by librosa's output. The few
--     librosa fields that don't fit (e.g. full chroma vector) live in
--     `extras JSONB` for forward compatibility.
--
--   * key + mode are stored as integers (0..11 chroma + 0|1 minor/major)
--     plus a derived camelot label. The camelot column is computed at
--     write-time so the read path doesn't have to redo the pitch math.
--
--   * extracted_at + analyzer_version make it possible to invalidate +
--     re-extract when the worker's algorithms change.
--
--   * source = 'youtube_audio' today; future sources (Spotify, manual
--     upload) get their own values without a schema change.
--
--   * track_extraction_jobs.status uses a TEXT CHECK rather than a
--     real enum so re-running the migration on a fresh DB doesn't fight
--     with Postgres's no-DROP-TYPE-without-cascade behavior.
--
--   * attempts + last_error let the worker back off and the admin panel
--     surface "this video keeps failing" without us having to wire a
--     dedicated dead-letter queue. attempts >= 5 = give up.
--
-- Idempotent.

-- --- features --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS track_features (
  id                BIGSERIAL    PRIMARY KEY,
  artist_id         UUID         NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  video_id          TEXT         NOT NULL,
  -- Cached display fields so we can render without re-hitting YouTube.
  title             TEXT,
  duration_sec      INT,
  -- Core librosa output.
  tempo_bpm         REAL,                           -- librosa.beat.tempo
  -- key 0..11 = C, C#, D, ..., B; mode 0 = minor, 1 = major.
  key_index         SMALLINT     CHECK (key_index IS NULL OR (key_index >= 0 AND key_index <= 11)),
  mode              SMALLINT     CHECK (mode IS NULL OR mode IN (0, 1)),
  -- Camelot wheel notation, e.g. '8B', '11A'. Pre-computed for the UI.
  camelot           TEXT,
  -- Energy / loudness signals.
  energy            REAL         CHECK (energy IS NULL OR (energy >= 0 AND energy <= 1)),
  rms_db            REAL,                            -- mean RMS in dBFS (negative)
  loudness_lufs     REAL,                            -- integrated loudness if measured
  -- Spectral signals (timbre).
  spectral_centroid REAL,                            -- Hz
  spectral_rolloff  REAL,                            -- Hz at 85th percentile
  zero_crossing_rate REAL,
  -- Forward-compat extras (chroma vector, MFCCs if we want them later).
  extras            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Provenance.
  source            TEXT         NOT NULL DEFAULT 'youtube_audio',
  analyzer_version  TEXT         NOT NULL,           -- e.g. 'librosa-0.10.2'
  extracted_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT track_features_artist_video_uniq UNIQUE (artist_id, video_id)
);

-- "All features for an artist" — the hot path for the detail page +
-- ranking aggregation.
CREATE INDEX IF NOT EXISTS track_features_artist_idx
  ON track_features (artist_id, extracted_at DESC);

-- "Look up by video_id" — used by the worker after a successful run to
-- decide insert vs update without trusting in-memory state.
CREATE INDEX IF NOT EXISTS track_features_video_idx
  ON track_features (video_id);

-- --- extraction jobs -------------------------------------------------------

CREATE TABLE IF NOT EXISTS track_extraction_jobs (
  id            BIGSERIAL    PRIMARY KEY,
  artist_id     UUID         NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  video_id      TEXT         NOT NULL,
  -- Cached metadata so the worker doesn't have to re-hit YouTube to know
  -- what it's analyzing. Updated when we re-discover a video on a later
  -- enqueue pass (idempotent ON CONFLICT below).
  title         TEXT,
  duration_sec  INT,
  status        TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts      INT          NOT NULL DEFAULT 0,
  last_error    TEXT,
  -- Times. claimed_at = when worker picked it up; finished_at = terminal
  -- state reached. Used by the admin panel + sweep heuristics.
  enqueued_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  claimed_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  CONSTRAINT track_extraction_jobs_artist_video_uniq UNIQUE (artist_id, video_id)
);

-- "Give me the next pending job" — the worker's claim-loop. Partial index
-- because once a job leaves 'pending' it never comes back via this path.
CREATE INDEX IF NOT EXISTS track_extraction_jobs_pending_idx
  ON track_extraction_jobs (enqueued_at ASC)
  WHERE status = 'pending';

-- "Show me failures for an artist" — admin panel surfacing.
CREATE INDEX IF NOT EXISTS track_extraction_jobs_failed_idx
  ON track_extraction_jobs (artist_id, finished_at DESC)
  WHERE status = 'failed';
