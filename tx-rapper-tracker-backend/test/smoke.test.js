// test/smoke.test.js
// Minimal smoke tests that run without hitting the real YouTube / Trends APIs.
// Run with `npm test`. No network calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock env before importing config. SESSION_SECRET + DATABASE_URL were
// added by phase 2b (auth + DB); keep them here so this file stays in
// lockstep with config.js's required env.
process.env.YOUTUBE_API_KEY = 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const { config, redacted } = await import('../src/config.js');
const { cacheGet, cacheSet, getOrFetch } = await import('../src/lib/cache.js');

test('config loads with defaults', () => {
  assert.equal(config.env, 'test');
  assert.equal(config.port, 8787);
  assert.ok(Array.isArray(config.corsOrigins));
});

test('redacted() masks the YouTube key', () => {
  const r = redacted();
  assert.match(r.youtubeApiKey, /redacted/);
  assert.ok(!r.youtubeApiKey.includes('TEST_KEY_FOR_SMOKE_ONLY'));
});

test('cache set/get round-trip', () => {
  cacheSet('k', { v: 1 });
  assert.deepEqual(cacheGet('k'), { v: 1 });
});

test('getOrFetch collapses concurrent loads', async () => {
  // L2 cache is Postgres-backed and persists across test runs, so use a
  // unique key so a previous invocation's stored value doesn't short-circuit
  // the loader before we can observe the collapse behavior.
  const key = `collapse-key-${process.pid}-${Date.now()}`;
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return 'done';
  };
  const [a, b, c] = await Promise.all([
    getOrFetch(key, loader),
    getOrFetch(key, loader),
    getOrFetch(key, loader),
  ]);
  assert.equal(a, 'done');
  assert.equal(b, 'done');
  assert.equal(c, 'done');
  assert.equal(calls, 1, 'loader should only run once for three concurrent callers');
});
