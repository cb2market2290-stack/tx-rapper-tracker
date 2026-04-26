// test/stats.test.js
// Offline coverage for the /api/stats/history input contract.
//
// The route handler itself is a 6-line shim: zod validate → SQL query → JSON.
// The SQL is parametrized (no injection surface) and has been live-verified.
// The interesting thing to protect against regression is the zod schema:
//   - artist is required, trimmed, bounded
//   - days coerces strings to int, defaults to 365, clamps to [1, 730]
//
// These are the validation guarantees a future refactor could accidentally
// weaken (e.g. raising the days ceiling, forgetting to coerce). Keep this
// test hermetic — no DB, no HTTP.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Required env BEFORE importing stats.js (which transitively loads config.js).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const { HistoryQuery } = await import('../src/routes/stats.js');

// ---- Happy path ----------------------------------------------------------

test('HistoryQuery accepts a minimal valid input and defaults days=365', () => {
  const r = HistoryQuery.safeParse({ artist: 'Megan Thee Stallion' });
  assert.equal(r.success, true);
  assert.equal(r.data.artist, 'Megan Thee Stallion');
  assert.equal(r.data.days, 365);
});

test('HistoryQuery coerces days from string (Express gives us strings)', () => {
  const r = HistoryQuery.safeParse({ artist: 'x', days: '90' });
  assert.equal(r.success, true);
  assert.equal(r.data.days, 90);
  assert.equal(typeof r.data.days, 'number');
});

test('HistoryQuery trims whitespace around the artist name', () => {
  const r = HistoryQuery.safeParse({ artist: '   GloRilla   ' });
  assert.equal(r.success, true);
  assert.equal(r.data.artist, 'GloRilla');
});

// ---- Required / empty ----------------------------------------------------

test('HistoryQuery rejects a missing artist', () => {
  const r = HistoryQuery.safeParse({});
  assert.equal(r.success, false);
  const msg = r.error.issues.map((i) => i.path.join('.')).join(',');
  assert.match(msg, /artist/);
});

test('HistoryQuery rejects an empty artist (after trim)', () => {
  const r = HistoryQuery.safeParse({ artist: '   ' });
  assert.equal(r.success, false);
});

// ---- Bounds --------------------------------------------------------------

test('HistoryQuery rejects days below the floor', () => {
  const r = HistoryQuery.safeParse({ artist: 'x', days: '0' });
  assert.equal(r.success, false);
});

test('HistoryQuery rejects days above the 2-year cap', () => {
  const r = HistoryQuery.safeParse({ artist: 'x', days: '731' });
  assert.equal(r.success, false);
});

test('HistoryQuery rejects a non-numeric days value', () => {
  const r = HistoryQuery.safeParse({ artist: 'x', days: 'lots' });
  assert.equal(r.success, false);
});

test('HistoryQuery rejects an artist longer than 200 chars', () => {
  const long = 'a'.repeat(201);
  const r = HistoryQuery.safeParse({ artist: long });
  assert.equal(r.success, false);
});
