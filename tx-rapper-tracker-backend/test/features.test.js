// test/features.test.js
// Offline coverage for src/services/features.js — the pure helpers that
// shape librosa-derived track_features rows into the API JSON used by the
// frontend's audio-features panel and the score bonus.
//
// Three helpers, all DB-free, all exported from features.js so we can test
// them without a live Postgres:
//   * cleanRow  — DB row → public JSON shape (numeric coercion, mode string,
//                 pitch-name lookup)
//   * dominantKey — duration-weighted (key, mode) bucket picker, with stable
//                   tie-break for deterministic output
//   * aggregate — per-artist summary (averages, range, dominantKey,
//                 featureBonus formula)
//
// We DON'T test the DB getters (getRowsForArtist, getArtistFeatures,
// getQueueStatus) here — those are thin SQL wrappers; integration via the
// HTTP smoke (scripts/test-features.sh) covers them.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Required env BEFORE importing features.js (which transitively loads
// config.js + db/pool.js). Pure helpers don't *use* the pool, but the
// import side-effect would still complain about missing env.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const { cleanRow, dominantKey, aggregate, getStaleVideoIds, requeueForReextraction } = await import(
  '../src/services/features.js'
);

// ---------------------------------------------------------------------------
// cleanRow
// ---------------------------------------------------------------------------

test('cleanRow returns null for null input', () => {
  assert.equal(cleanRow(null), null);
  assert.equal(cleanRow(undefined), null);
});

test('cleanRow shapes a fully populated row into the public JSON', () => {
  const row = {
    video_id: 'abc123',
    title: 'Test Track',
    duration_sec: 180,
    tempo_bpm: 140.5,
    key_index: 0,        // C
    mode: 1,             // major
    camelot: '8B',
    energy: 0.65,
    rms_db: -12.4,
    spectral_centroid: 2500.0,
    spectral_rolloff: 5000.0,
    zero_crossing_rate: 0.08,
    extracted_at: '2026-04-20T10:00:00Z',
    analyzer_version: 'librosa-0.10.1',
  };
  const out = cleanRow(row);
  assert.equal(out.videoId, 'abc123');
  assert.equal(out.title, 'Test Track');
  assert.equal(out.durationSec, 180);
  assert.equal(out.tempoBpm, 140.5);
  assert.equal(out.key, 'C');
  assert.equal(out.keyIndex, 0);
  assert.equal(out.mode, 'major');
  assert.equal(out.camelot, '8B');
  assert.equal(out.energy, 0.65);
  assert.equal(out.rmsDb, -12.4);
});

test('cleanRow decodes mode integer 0 as minor', () => {
  const out = cleanRow({ video_id: 'x', mode: 0, key_index: 9 });
  assert.equal(out.mode, 'minor');
  assert.equal(out.key, 'A');
});

test('cleanRow leaves missing fields as null instead of NaN/undefined', () => {
  const out = cleanRow({ video_id: 'x' });
  assert.equal(out.tempoBpm, null);
  assert.equal(out.key, null);
  assert.equal(out.mode, null);
  assert.equal(out.camelot, null);
  assert.equal(out.energy, null);
  assert.equal(out.title, null);
});

test('cleanRow coerces stringified numerics from Postgres NUMERIC columns', () => {
  // pg returns NUMERIC as strings — the cast to Number must happen here.
  const out = cleanRow({ video_id: 'x', tempo_bpm: '128.7', energy: '0.42', rms_db: '-8.1' });
  assert.equal(typeof out.tempoBpm, 'number');
  assert.equal(out.tempoBpm, 128.7);
  assert.equal(out.energy, 0.42);
  assert.equal(out.rmsDb, -8.1);
});

// ---------------------------------------------------------------------------
// dominantKey
// ---------------------------------------------------------------------------

test('dominantKey returns null for empty / missing input', () => {
  assert.equal(dominantKey([]), null);
  assert.equal(dominantKey(null), null);
  assert.equal(dominantKey(undefined), null);
});

test('dominantKey returns null when no row has both key + mode', () => {
  const rows = [
    { key_index: null, mode: 1, duration_sec: 200 },
    { key_index: 4, mode: null, duration_sec: 200 },
  ];
  assert.equal(dominantKey(rows), null);
});

test('dominantKey picks the key with the most total play-time', () => {
  // C major: 100 + 100 = 200s; A minor: 150s. C major wins.
  const rows = [
    { key_index: 0, mode: 1, duration_sec: 100, camelot: '8B' },
    { key_index: 0, mode: 1, duration_sec: 100, camelot: '8B' },
    { key_index: 9, mode: 0, duration_sec: 150, camelot: '8A' },
  ];
  const out = dominantKey(rows);
  assert.equal(out.key, 'C');
  assert.equal(out.mode, 'major');
  assert.equal(out.camelot, '8B');
  assert.equal(out.totalSec, 200);
});

test('dominantKey floors zero/missing duration at 1s so each row still votes', () => {
  // Without the floor, all three buckets would tie at 0 and the result
  // would be unpredictable. With the 1s floor, A major wins 2-to-1.
  const rows = [
    { key_index: 9, mode: 1, duration_sec: 0, camelot: '11B' },
    { key_index: 9, mode: 1, duration_sec: null, camelot: '11B' },
    { key_index: 0, mode: 1, duration_sec: 0, camelot: '8B' },
  ];
  const out = dominantKey(rows);
  assert.equal(out.key, 'A');
  assert.equal(out.totalSec, 2);
});

test('dominantKey is deterministic on ties (stable Camelot ordering)', () => {
  // Both keys at 100s — tie-break should be reproducible across runs.
  const rows = [
    { key_index: 0, mode: 1, duration_sec: 100, camelot: '8B' },
    { key_index: 7, mode: 1, duration_sec: 100, camelot: '9B' },
  ];
  const out1 = dominantKey(rows);
  const out2 = dominantKey(rows);
  assert.equal(out1.key, out2.key);
  assert.equal(out1.mode, out2.mode);
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

test('aggregate returns the empty shape for no rows', () => {
  const out = aggregate([]);
  assert.equal(out.trackCount, 0);
  assert.equal(out.tempoBpmAvg, null);
  assert.equal(out.energyAvg, null);
  assert.equal(out.dominantKey, null);
  assert.equal(out.featureBonus, null);
});

test('aggregate handles undefined / non-array input', () => {
  const out = aggregate(undefined);
  assert.equal(out.trackCount, 0);
  assert.equal(out.featureBonus, null);
});

test('aggregate computes averages, mins/maxes, and dominant key', () => {
  const rows = [
    { tempo_bpm: 100, energy: 0.4, rms_db: -10, key_index: 0, mode: 1, duration_sec: 200 },
    { tempo_bpm: 140, energy: 0.6, rms_db: -8,  key_index: 0, mode: 1, duration_sec: 200 },
    { tempo_bpm: 120, energy: 0.5, rms_db: -9,  key_index: 9, mode: 0, duration_sec: 100 },
  ];
  const out = aggregate(rows);
  assert.equal(out.trackCount, 3);
  assert.equal(out.tempoBpmAvg, 120);
  assert.equal(out.tempoBpmMin, 100);
  assert.equal(out.tempoBpmMax, 140);
  assert.equal(out.energyAvg, 0.5);
  assert.equal(out.rmsDbAvg, -9);
  assert.equal(out.dominantKey.key, 'C');
  assert.equal(out.dominantKey.mode, 'major');
});

test('aggregate ignores non-finite tempos / energies in averages', () => {
  const rows = [
    { tempo_bpm: 120, energy: 0.5, rms_db: -10 },
    { tempo_bpm: NaN, energy: null, rms_db: undefined },
    { tempo_bpm: 0,   energy: 0.7, rms_db: -8 },  // tempo=0 dropped (must be > 0)
  ];
  const out = aggregate(rows);
  assert.equal(out.trackCount, 3);
  assert.equal(out.tempoBpmAvg, 120);
  assert.equal(out.energyAvg, 0.6);
});

test('aggregate featureBonus formula: in-range tempo + healthy energy', () => {
  // energy=0.8 → bonus = 0.56; tempo 130 in [70..180] → +0.2 → 0.76
  const rows = [{ tempo_bpm: 130, energy: 0.8, rms_db: -6 }];
  const out = aggregate(rows);
  assert.ok(out.featureBonus > 0.7 && out.featureBonus <= 0.8,
    'expected ~0.76, got ' + out.featureBonus);
});

test('aggregate featureBonus omits the tempo bonus when out of range', () => {
  // tempo 60 below 70 floor → no +0.2; energy 0.5 → bonus = 0.35
  const rows = [{ tempo_bpm: 60, energy: 0.5, rms_db: -10 }];
  const out = aggregate(rows);
  assert.ok(Math.abs(out.featureBonus - 0.35) < 0.01,
    'expected ~0.35, got ' + out.featureBonus);
});

test('aggregate featureBonus is null when no energy data exists', () => {
  const rows = [{ tempo_bpm: 120, energy: null, rms_db: -10 }];
  const out = aggregate(rows);
  assert.equal(out.featureBonus, null);
});

test('aggregate featureBonus is capped at 1.0 even with extreme inputs', () => {
  // energy=2.0 (clipped) + tempo bonus = 1.4 + 0.2 = 1.6 → capped to 1.0
  const rows = [{ tempo_bpm: 120, energy: 2.0, rms_db: 0 }];
  const out = aggregate(rows);
  assert.ok(out.featureBonus <= 1.0,
    'expected cap at 1.0, got ' + out.featureBonus);
});

// ---------------------------------------------------------------------------
// Re-extraction policy (Phase 2d.B2)
//
// We can't drive the actual SQL without a live Postgres, but we can lock in
// the input-validation + early-exit branches that don't touch the DB. Live
// verification happens via the smoke (test-features.sh extended in 2d.C1)
// and a future `--reextract` dry-run flag.
// ---------------------------------------------------------------------------

test('getStaleVideoIds throws when currentAnalyzerVersion is missing', async () => {
  await assert.rejects(
    () => getStaleVideoIds({}),
    /currentAnalyzerVersion required/,
    'expected an explicit error mentioning the missing parameter'
  );
  await assert.rejects(
    () => getStaleVideoIds({ currentAnalyzerVersion: '' }),
    /currentAnalyzerVersion required/,
    'empty-string version should also be rejected'
  );
  await assert.rejects(
    () => getStaleVideoIds({ currentAnalyzerVersion: null }),
    /currentAnalyzerVersion required/,
    'null should also be rejected'
  );
});

test('requeueForReextraction returns {requeued:0} for an empty list', async () => {
  // Empty / non-array inputs short-circuit before touching the DB.
  const a = await requeueForReextraction([]);
  assert.deepEqual(a, { requeued: 0 });
  const b = await requeueForReextraction(null);
  assert.deepEqual(b, { requeued: 0 });
  const c = await requeueForReextraction(undefined);
  assert.deepEqual(c, { requeued: 0 });
});

test('requeueForReextraction filters malformed pairs without hitting the DB', async () => {
  // Every row missing artist_id or video_id should be filtered out. If
  // ALL rows are malformed, the function must NOT issue a SQL call (the
  // DB isn't reachable in this test env, so a real query would throw).
  const out = await requeueForReextraction([
    { video_id: 'abc' },                 // missing artist_id
    { artist_id: 'uuid-1' },             // missing video_id
    { artist_id: '', video_id: '' },     // both empty
    null,                                // null entry
  ]);
  assert.deepEqual(out, { requeued: 0 });
});
