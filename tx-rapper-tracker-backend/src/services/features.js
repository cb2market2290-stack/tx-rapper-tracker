// src/services/features.js
// Read-only access to track_features (Phase 2c). The Python worker writes
// the rows; this module shapes them for the API.
//
// Layered like a clean read service:
//   * Pure helpers (no DB) — `aggregate`, `dominantKey`, `cleanRow` —
//     exported individually so test/features.test.js can exercise them
//     without a live Postgres.
//   * Async DB getters — `getArtistFeatures(artistId)` etc — shown last.
//
// Camelot key reduction: when we summarize an artist's recent catalog
// into "dominant key", we count weighted by track length (so a 30-second
// intro doesn't get equal say with a full song). Tied keys break by the
// shorter Camelot label for stable output.

import { query } from '../db/pool.js';

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

/**
 * Render a track_features DB row as the public JSON shape returned by the
 * API. Strips internals (id, extras blob — only the chroma summary makes
 * it through, behind a flag).
 */
export function cleanRow(row) {
  if (!row) return null;
  return {
    videoId: row.video_id,
    title: row.title ?? null,
    durationSec: row.duration_sec ?? null,
    tempoBpm: row.tempo_bpm == null ? null : Number(row.tempo_bpm),
    key: row.key_index == null ? null : PITCH_NAMES[row.key_index],
    keyIndex: row.key_index,
    mode: row.mode == null ? null : (row.mode === 1 ? 'major' : 'minor'),
    camelot: row.camelot ?? null,
    energy: row.energy == null ? null : Number(row.energy),
    rmsDb: row.rms_db == null ? null : Number(row.rms_db),
    spectralCentroid: row.spectral_centroid == null ? null : Number(row.spectral_centroid),
    spectralRolloff: row.spectral_rolloff == null ? null : Number(row.spectral_rolloff),
    zeroCrossingRate: row.zero_crossing_rate == null ? null : Number(row.zero_crossing_rate),
    extractedAt: row.extracted_at ?? null,
    analyzerVersion: row.analyzer_version ?? null,
  };
}

/**
 * Pick the key+mode combo that occupies the most total play-time across a
 * set of tracks. Each track contributes its `durationSec` (or 0 if absent)
 * to its (key_index, mode) bucket. Returns `null` when no row has a key.
 *
 * Output: { keyIndex, mode, key, modeName, camelot, totalSec }.
 */
export function dominantKey(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const buckets = new Map();
  for (const r of rows) {
    if (r.key_index == null || r.mode == null) continue;
    const k = `${r.key_index}:${r.mode}`;
    const dur = Number(r.duration_sec) || 0;
    buckets.set(k, (buckets.get(k) || 0) + Math.max(dur, 1)); // floor at 1s so a missing duration still votes
  }
  if (buckets.size === 0) return null;
  let bestKey = null;
  let bestVal = -1;
  let bestCamelot = '';
  for (const [k, v] of buckets) {
    if (
      v > bestVal ||
      // Ties: prefer the lower Camelot string for stable output across runs.
      (v === bestVal && (bestCamelot === '' || k < bestKey))
    ) {
      bestKey = k;
      bestVal = v;
      // Find a Camelot exemplar for tie-break ordering — pick the first row.
      const sample = rows.find((r) => `${r.key_index}:${r.mode}` === k);
      bestCamelot = sample?.camelot ?? '';
    }
  }
  const [keyIndexStr, modeStr] = bestKey.split(':');
  const keyIndex = Number(keyIndexStr);
  const modeInt = Number(modeStr);
  return {
    keyIndex,
    mode: modeInt === 1 ? 'major' : 'minor',
    modeInt,
    key: PITCH_NAMES[keyIndex],
    camelot: bestCamelot || null,
    totalSec: bestVal,
  };
}

/**
 * Compute artist-level summary signals from per-track rows. Used by the
 * detail page and also by the score-bonus formula on the frontend.
 *
 * All numeric outputs are rounded to two decimals (or null when there's
 * not enough data to compute them).
 */
export function aggregate(rows) {
  const trackCount = Array.isArray(rows) ? rows.length : 0;
  if (trackCount === 0) {
    return {
      trackCount: 0,
      tempoBpmAvg: null,
      tempoBpmMin: null,
      tempoBpmMax: null,
      energyAvg: null,
      rmsDbAvg: null,
      dominantKey: null,
      // Convenience score-bonus factor (0..1) the frontend can scale into
      // its ranking weight. Null when we don't have enough data.
      featureBonus: null,
    };
  }

  // Drop null/undefined BEFORE coercion — Number(null) === 0 (which is
  // finite), so a missing measurement would otherwise pollute averages
  // with a phantom zero. We only want real, recorded values.
  const notNull = (v) => v !== null && v !== undefined;
  const tempos = rows
    .map((r) => r.tempo_bpm)
    .filter(notNull)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const energies = rows
    .map((r) => r.energy)
    .filter(notNull)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const rms = rows
    .map((r) => r.rms_db)
    .filter(notNull)
    .map(Number)
    .filter((n) => Number.isFinite(n));

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

  const tempoAvg = avg(tempos);
  const energyAvg = avg(energies);
  const rmsAvg = avg(rms);

  // featureBonus: a small per-artist multiplier the frontend mixes into
  // its ranking score. Energy contributes most (rap with high energy +
  // tight RMS reads as more "active" releases); tempo contributes a tiny
  // boost for tracks in the typical hip-hop range. Cap at 1.0.
  let bonus = null;
  if (energyAvg != null) {
    bonus = energyAvg * 0.7;                                 // 0..0.7
    if (tempoAvg != null && tempoAvg >= 70 && tempoAvg <= 180) {
      bonus += 0.2;                                          // +0.2 if it's in range
    }
    bonus = Math.max(0, Math.min(1, bonus));
  }

  return {
    trackCount,
    tempoBpmAvg: round(tempoAvg),
    tempoBpmMin: tempos.length ? Math.min(...tempos) : null,
    tempoBpmMax: tempos.length ? Math.max(...tempos) : null,
    energyAvg: round(energyAvg, 4),
    rmsDbAvg: round(rmsAvg),
    dominantKey: dominantKey(rows),
    featureBonus: round(bonus, 4),
  };
}

// ---------------------------------------------------------------------------
// DB getters
// ---------------------------------------------------------------------------

/**
 * Fetch all features rows for an artist. Returns the raw DB rows — caller
 * runs them through cleanRow / aggregate.
 *
 * Ordered by extracted_at DESC so "most recent first" is the natural
 * client-side default.
 */
export async function getRowsForArtist(artistId) {
  const { rows } = await query(
    `SELECT video_id, title, duration_sec,
            tempo_bpm, key_index, mode, camelot,
            energy, rms_db, loudness_lufs,
            spectral_centroid, spectral_rolloff, zero_crossing_rate,
            extracted_at, analyzer_version
       FROM track_features
      WHERE artist_id = $1
      ORDER BY extracted_at DESC`,
    [artistId]
  );
  return rows;
}

/**
 * Public-shaped artist features payload.
 *   { artistId, summary: aggregate(rows), tracks: [cleanRow, …] }
 */
export async function getArtistFeatures(artistId) {
  const rows = await getRowsForArtist(artistId);
  return {
    artistId,
    summary: aggregate(rows),
    tracks: rows.map(cleanRow),
  };
}

/**
 * Lightweight queue snapshot for the admin panel — counts by status so we
 * can tell at a glance whether the worker is keeping up.
 */
export async function getQueueStatus() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS n
       FROM track_extraction_jobs
      GROUP BY status`
  );
  const counts = {};
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

// ---------------------------------------------------------------------------
// Re-extraction policy (Phase 2d.B2)
// ---------------------------------------------------------------------------
//
// When the Python worker bumps its `analyzer_version` (e.g. librosa upgrade,
// new key-detection model, change to the energy formula) we need a way to
// invalidate already-extracted tracks WITHOUT touching the rows we just
// computed in the current version. The shape:
//
//   1. Operator passes the new "good" analyzer_version to the enqueue
//      script: `node scripts/enqueue-features.js --reextract librosa-0.11`.
//   2. The script asks features.js: "which (artist, video) pairs were
//      analyzed with anything other than librosa-0.11?".
//   3. For each stale row the script flips the existing track_extraction_jobs
//      row back to status='pending' (or inserts one if missing) so the
//      worker picks it up again. The track_features row stays untouched
//      until the worker upserts a fresh one.
//
// We keep the SQL here (not in the enqueue script) so the rule for "stale"
// has one home — both the script and any future admin panel use the same
// definition.

/**
 * Find tracks whose track_features row is older than the requested
 * analyzer_version. Returns lightweight rows with the fields the enqueue
 * script needs to upsert into track_extraction_jobs.
 *
 * Stale = current row's analyzer_version differs from `currentAnalyzerVersion`,
 * OR the row's analyzer_version is NULL/empty.
 *
 * @param {object}  opts
 * @param {string}  opts.currentAnalyzerVersion  e.g. 'librosa-0.11.0'
 * @param {string=} opts.artistId                optional UUID filter
 * @param {number=} opts.limit                   safety cap (default 1000)
 * @returns {Promise<Array<{artist_id:string, video_id:string, title:string|null, duration_sec:number|null, analyzer_version:string|null}>>}
 */
export async function getStaleVideoIds({
  currentAnalyzerVersion,
  artistId = null,
  limit = 1000,
} = {}) {
  if (!currentAnalyzerVersion || typeof currentAnalyzerVersion !== 'string') {
    throw new Error('getStaleVideoIds: currentAnalyzerVersion required');
  }
  // Two predicates ORed together: analyzer_version IS DISTINCT FROM the
  // current one (NULL-safe), AND we cap output. The IS DISTINCT FROM
  // operator treats NULL as just-another-value, so a row with a NULL
  // analyzer_version is correctly flagged stale.
  const params = [currentAnalyzerVersion];
  let where = `analyzer_version IS DISTINCT FROM $1`;
  if (artistId) {
    params.push(artistId);
    where += ` AND artist_id = $${params.length}`;
  }
  params.push(Math.max(1, Math.min(10000, Number(limit) || 1000)));
  const { rows } = await query(
    `SELECT artist_id, video_id, title, duration_sec, analyzer_version
       FROM track_features
      WHERE ${where}
      ORDER BY extracted_at ASC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Re-enqueue a list of (artist_id, video_id) pairs for re-extraction.
 *
 * Different from the regular daily enqueue (which uses DO NOTHING) because
 * here we WANT to flip an existing job row back to pending. We bulk
 * upsert with status='pending', attempts=0, last_error=NULL,
 * claimed_at=NULL, finished_at=NULL. enqueued_at is bumped to now() so the
 * worker's FIFO claim picks these up after any actually-new work that
 * preceded them.
 *
 * Note: the track_features row is left in place. The worker upserts a
 * fresh one when it succeeds, which atomically replaces the stale data.
 * If the worker fails, the old features are still readable — degraded but
 * not deleted.
 *
 * @param {Array<{artist_id:string, video_id:string, title?:string|null, duration_sec?:number|null}>} pairs
 * @returns {Promise<{requeued:number}>}
 */
export async function requeueForReextraction(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return { requeued: 0 };
  // Build the VALUES tuple list — 4 params per row.
  const values = [];
  const params = [];
  let i = 1;
  for (const p of pairs) {
    if (!p?.artist_id || !p?.video_id) continue;
    values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(p.artist_id, p.video_id, p.title ?? null, p.duration_sec ?? null);
  }
  if (values.length === 0) return { requeued: 0 };
  const result = await query(
    `INSERT INTO track_extraction_jobs (artist_id, video_id, title, duration_sec)
     VALUES ${values.join(', ')}
     ON CONFLICT (artist_id, video_id) DO UPDATE SET
       status      = 'pending',
       attempts    = 0,
       last_error  = NULL,
       claimed_at  = NULL,
       finished_at = NULL,
       enqueued_at = now(),
       title       = COALESCE(EXCLUDED.title, track_extraction_jobs.title),
       duration_sec = COALESCE(EXCLUDED.duration_sec, track_extraction_jobs.duration_sec)`,
    params
  );
  return { requeued: result.rowCount ?? 0 };
}
