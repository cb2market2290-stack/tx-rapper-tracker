// test/admin.test.js
// Hermetic coverage for the admin router's zod schemas.
//
// The handlers in src/routes/admin.js are thin: parse query → SQL → JSON.
// Protecting the input contract is what keeps the routes honest under
// refactors. These tests exercise the exported schemas directly — no DB,
// no HTTP, no fixtures.
//
// Covered:
//   - ListQuery       : coerce + bounds + optional event / userId
//   - UuidParam       : valid / invalid cases for /:id routes
//   - NewArtist       : trim + length + optional sortOrder coerce
//   - SnapshotStatusQuery : independent cap (50) from ListQuery's (500)
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Required env BEFORE importing admin.js (which transitively loads config.js
// + pool.js). Mirrors test/stats.test.js so `npm test` stays hermetic.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const { ListQuery, SnapshotStatusQuery, UuidParam, NewArtist, ExtractionJobsQuery } =
  await import('../src/routes/admin.js');

// ---- ListQuery -----------------------------------------------------------

test('ListQuery defaults limit=100, offset=0 when omitted', () => {
  const r = ListQuery.safeParse({});
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 100);
  assert.equal(r.data.offset, 0);
  assert.equal(r.data.event, undefined);
  assert.equal(r.data.userId, undefined);
});

test('ListQuery coerces limit + offset from strings (Express gives us strings)', () => {
  const r = ListQuery.safeParse({ limit: '50', offset: '10' });
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 50);
  assert.equal(r.data.offset, 10);
});

test('ListQuery caps limit at 500', () => {
  const r = ListQuery.safeParse({ limit: '501' });
  assert.equal(r.success, false);
});

test('ListQuery rejects limit below 1', () => {
  const r = ListQuery.safeParse({ limit: '0' });
  assert.equal(r.success, false);
});

test('ListQuery rejects negative offset', () => {
  const r = ListQuery.safeParse({ offset: '-1' });
  assert.equal(r.success, false);
});

test('ListQuery rejects non-numeric limit', () => {
  const r = ListQuery.safeParse({ limit: 'none' });
  assert.equal(r.success, false);
});

test('ListQuery accepts and trims event', () => {
  const r = ListQuery.safeParse({ event: '  login_failed  ' });
  assert.equal(r.success, true);
  assert.equal(r.data.event, 'login_failed');
});

test('ListQuery rejects empty event (after trim)', () => {
  const r = ListQuery.safeParse({ event: '   ' });
  assert.equal(r.success, false);
});

test('ListQuery rejects event longer than 64 chars', () => {
  const r = ListQuery.safeParse({ event: 'a'.repeat(65) });
  assert.equal(r.success, false);
});

test('ListQuery accepts a valid userId (uuid)', () => {
  const r = ListQuery.safeParse({ userId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(r.success, true);
  assert.equal(r.data.userId, '11111111-1111-4111-8111-111111111111');
});

test('ListQuery rejects a non-uuid userId', () => {
  const r = ListQuery.safeParse({ userId: 'not-a-uuid' });
  assert.equal(r.success, false);
});

// ---- UuidParam -----------------------------------------------------------

test('UuidParam accepts a well-formed uuid', () => {
  const r = UuidParam.safeParse('11111111-1111-4111-8111-111111111111');
  assert.equal(r.success, true);
});

test('UuidParam rejects a malformed uuid', () => {
  const r = UuidParam.safeParse('not-a-uuid');
  assert.equal(r.success, false);
});

test('UuidParam rejects an empty string', () => {
  const r = UuidParam.safeParse('');
  assert.equal(r.success, false);
});

// ---- NewArtist -----------------------------------------------------------

test('NewArtist accepts a minimal valid body', () => {
  const r = NewArtist.safeParse({ name: 'Smoke Artist' });
  assert.equal(r.success, true);
  assert.equal(r.data.name, 'Smoke Artist');
  assert.equal(r.data.sortOrder, undefined);
});

test('NewArtist trims the name', () => {
  const r = NewArtist.safeParse({ name: '   GloRilla   ' });
  assert.equal(r.success, true);
  assert.equal(r.data.name, 'GloRilla');
});

test('NewArtist rejects empty name after trim', () => {
  const r = NewArtist.safeParse({ name: '   ' });
  assert.equal(r.success, false);
});

test('NewArtist rejects a missing name', () => {
  const r = NewArtist.safeParse({});
  assert.equal(r.success, false);
});

test('NewArtist rejects names longer than 200 chars', () => {
  const r = NewArtist.safeParse({ name: 'a'.repeat(201) });
  assert.equal(r.success, false);
});

test('NewArtist coerces sortOrder from string (admin UI sends from input tag)', () => {
  const r = NewArtist.safeParse({ name: 'X', sortOrder: '42' });
  assert.equal(r.success, true);
  assert.equal(r.data.sortOrder, 42);
  assert.equal(typeof r.data.sortOrder, 'number');
});

test('NewArtist rejects a negative sortOrder', () => {
  const r = NewArtist.safeParse({ name: 'X', sortOrder: '-1' });
  assert.equal(r.success, false);
});

test('NewArtist caps sortOrder at 10000', () => {
  const r = NewArtist.safeParse({ name: 'X', sortOrder: '10001' });
  assert.equal(r.success, false);
});

test('NewArtist rejects a non-integer sortOrder', () => {
  const r = NewArtist.safeParse({ name: 'X', sortOrder: '3.14' });
  assert.equal(r.success, false);
});

// ---- SnapshotStatusQuery -------------------------------------------------

test('SnapshotStatusQuery defaults limit=14 when omitted', () => {
  const r = SnapshotStatusQuery.safeParse({});
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 14);
});

test('SnapshotStatusQuery coerces limit from a string', () => {
  const r = SnapshotStatusQuery.safeParse({ limit: '30' });
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 30);
});

test('SnapshotStatusQuery caps limit at 50 (tighter than ListQuery\'s 500)', () => {
  const r = SnapshotStatusQuery.safeParse({ limit: '51' });
  assert.equal(r.success, false);
});

test('SnapshotStatusQuery rejects limit below 1', () => {
  const r = SnapshotStatusQuery.safeParse({ limit: '0' });
  assert.equal(r.success, false);
});

// ---- ExtractionJobsQuery (Phase 2e.B) -----------------------------------
// Same coercion + bounds posture as ListQuery (Express gives us strings),
// plus a status enum locked to migration 009's CHECK constraint and an
// optional artistId UUID. The point of these tests is to lock down the
// contract — if a future refactor drops "skipped" from the enum we want a
// red test, not a runtime 500 the next time the worker writes that status.

test('ExtractionJobsQuery defaults limit=100, offset=0 when omitted', () => {
  const r = ExtractionJobsQuery.safeParse({});
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 100);
  assert.equal(r.data.offset, 0);
  assert.equal(r.data.artistId, undefined);
  assert.equal(r.data.status, undefined);
});

test('ExtractionJobsQuery coerces limit + offset from strings', () => {
  const r = ExtractionJobsQuery.safeParse({ limit: '50', offset: '20' });
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 50);
  assert.equal(r.data.offset, 20);
});

test('ExtractionJobsQuery accepts every valid status', () => {
  for (const status of ['pending', 'running', 'done', 'failed', 'skipped']) {
    const r = ExtractionJobsQuery.safeParse({ status });
    assert.equal(r.success, true, `status='${status}' should parse`);
    assert.equal(r.data.status, status);
  }
});

test('ExtractionJobsQuery rejects unknown status', () => {
  const r = ExtractionJobsQuery.safeParse({ status: 'queued' });
  assert.equal(r.success, false);
});

test('ExtractionJobsQuery rejects non-uuid artistId', () => {
  const r = ExtractionJobsQuery.safeParse({ artistId: 'not-a-uuid' });
  assert.equal(r.success, false);
});

test('ExtractionJobsQuery accepts a real uuid', () => {
  const r = ExtractionJobsQuery.safeParse({
    artistId: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(r.success, true);
});

test('ExtractionJobsQuery caps limit at 500', () => {
  const r = ExtractionJobsQuery.safeParse({ limit: '501' });
  assert.equal(r.success, false);
});
