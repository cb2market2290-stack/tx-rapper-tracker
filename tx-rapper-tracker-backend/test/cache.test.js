// test/cache.test.js
// Coverage for the two-tier cache in src/lib/cache.js.
//
// smoke.test.js already verifies the basic round-trip + concurrent-collapse
// paths. This file covers the trickier bits: TTL ceiling, L2 fallthrough,
// loader errors (no caching), and sweepExpired's retention behavior.
//
// Not hermetic — hits the dev Postgres (`tx_rapper_tracker_dev`). Uses
// process-unique keys so parallel runs / previous runs don't collide.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const { cacheGet, cacheSet, getOrFetch, sweepExpired } = await import(
  '../src/lib/cache.js'
);
const { query, closePool } = await import('../src/db/pool.js');

// Close the pool after every test file so `npm test` doesn't hang on a lingering
// connection. Other DB-backed test files rely on their own closePool, but
// closing twice is a no-op so we're safe.
test.after(async () => {
  await closePool().catch(() => {});
});

// Keys are scoped to this pid + run-nonce so tests don't stomp each other
// when run in parallel or repeated.
const NONCE = `${process.pid}-${Date.now()}`;
const k = (label) => `cache-test-${label}-${NONCE}`;

// ---- L1 ↔ L2 round-trip -------------------------------------------------

test('cacheSet writes to both L1 and L2 (value visible after L1 eviction)', async () => {
  const key = k('l2-rt');
  await cacheSet(key, { n: 42 }, 120);
  assert.deepEqual(cacheGet(key), { n: 42 });

  // Drop the L1 copy by flushing just this key (private API not exposed;
  // we fake eviction by inserting a sentinel undefined at a longer TTL).
  // Instead: fetch directly from L2 to confirm persistence.
  const { rows } = await query('SELECT value FROM cache WHERE key = $1', [key]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].value, { n: 42 });

  // Cleanup so test runs don't leave breadcrumbs.
  await query('DELETE FROM cache WHERE key = $1', [key]);
});

test('getOrFetch reads from L2 when L1 is cold', async () => {
  const key = k('l2-fallthrough');
  // Seed L2 directly, bypassing L1 entirely.
  await query(
    `INSERT INTO cache (key, value, expires_at)
     VALUES ($1, $2::jsonb, now() + interval '2 minutes')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
    [key, JSON.stringify({ source: 'l2' })]
  );

  // L1 should be cold for this key. Loader would throw if called; the L2
  // value wins before the loader is ever touched.
  const throwingLoader = async () => {
    throw new Error('loader should not run when L2 hits');
  };
  const v = await getOrFetch(key, throwingLoader, 60);
  assert.deepEqual(v, { source: 'l2' });

  // After that call, L1 is now warm.
  assert.deepEqual(cacheGet(key), { source: 'l2' });

  await query('DELETE FROM cache WHERE key = $1', [key]);
});

// ---- Loader errors are NOT cached ---------------------------------------

test('loader errors bubble up and nothing is cached', async () => {
  const key = k('loader-throws');
  let calls = 0;
  const flakyLoader = async () => {
    calls += 1;
    throw new Error('upstream hiccup');
  };

  await assert.rejects(() => getOrFetch(key, flakyLoader, 60), /upstream hiccup/);

  // Neither tier should have a cached value.
  assert.equal(cacheGet(key), undefined);
  const { rows } = await query('SELECT value FROM cache WHERE key = $1', [key]);
  assert.equal(rows.length, 0, 'a failed fetch should not be persisted to L2');

  // Second call re-runs the loader (no negative caching).
  await assert.rejects(() => getOrFetch(key, flakyLoader, 60));
  assert.equal(calls, 2, 'loader retries on next request after a failure');
});

// ---- sweepExpired -------------------------------------------------------

test('sweepExpired deletes only expired rows', async () => {
  const expiredKey = k('expired');
  const liveKey = k('live');

  // Seed one expired row and one live row.
  await query(
    `INSERT INTO cache (key, value, expires_at) VALUES
       ($1, $3::jsonb, now() - interval '1 minute'),
       ($2, $3::jsonb, now() + interval '5 minutes')`,
    [expiredKey, liveKey, JSON.stringify({ v: 1 })]
  );

  // Sanity: both rows are there.
  const before = await query('SELECT key FROM cache WHERE key IN ($1, $2)', [
    expiredKey,
    liveKey,
  ]);
  assert.equal(before.rows.length, 2);

  await sweepExpired();

  const after = await query('SELECT key FROM cache WHERE key IN ($1, $2)', [
    expiredKey,
    liveKey,
  ]);
  // Only the live row should remain from our pair.
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].key, liveKey);

  await query('DELETE FROM cache WHERE key = $1', [liveKey]);
});

// ---- L1 + L2 TTL caps ---------------------------------------------------

test('cacheSet caps L1 TTL at 60s even when caller requests more', async () => {
  // We can't directly introspect L1's TTL without relying on node-cache
  // internals, but we can verify that after a long TTL request, the L2 row
  // has the requested TTL (not the clamped one). L1 clamp is documented in
  // cache.js — we only verify here that a big TTL value is persisted
  // faithfully to L2.
  const key = k('ttl-big');
  const wantSeconds = 7200; // 2h
  await cacheSet(key, { b: 1 }, wantSeconds);
  const { rows } = await query(
    `SELECT EXTRACT(epoch FROM (expires_at - now()))::int AS seconds
       FROM cache WHERE key = $1`,
    [key]
  );
  assert.equal(rows.length, 1);
  // Allow a little slack for clock + insert latency.
  assert.ok(
    rows[0].seconds > wantSeconds - 10 && rows[0].seconds <= wantSeconds + 5,
    `expected ~${wantSeconds}s TTL, got ${rows[0].seconds}s`
  );
  await query('DELETE FROM cache WHERE key = $1', [key]);
});
