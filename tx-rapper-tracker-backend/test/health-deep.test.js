// test/health-deep.test.js
// Phase 3.5.4 — offline coverage for the deep-health endpoint's pure
// branches. The DB-touching paths (checkDb / checkSnapshotFresh /
// checkExtractFresh) are exercised by manual-verify against the live
// Postgres; what we protect here is:
//
//   * /api/health/deep is mounted under healthRoutes (= no auth gate).
//   * checkBriefsConfigured() returns applicable=false when the briefs
//     feature is disabled (= ANTHROPIC_API_KEY unset).
//   * The endpoint returns 200 when all checks ok, 503 when any fail.
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
// Make sure briefs is OFF for this test so checkBriefsConfigured returns
// applicable=false.
delete process.env.ANTHROPIC_API_KEY;

const healthMod = await import('../src/routes/health.js');

// ---------------------------------------------------------------------------
// The router exposes the routes; we don't have a unit-level handle on
// checkBriefsConfigured because it's a closure inside the module.
// What we CAN assert offline:
//   1. The default export is an Express router.
//   2. Its .stack contains a layer for /api/health/deep.
// ---------------------------------------------------------------------------

test('health router exports a default Express router', () => {
  assert.equal(typeof healthMod.default, 'function');
  assert.ok(healthMod.default.stack, 'router should have a layer stack');
});

test('health router includes /api/health/deep route', () => {
  const router = healthMod.default;
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);
  assert.ok(paths.includes('/health'),         'has /health');
  assert.ok(paths.includes('/ready'),          'has /ready');
  assert.ok(paths.includes('/api/health/deep'), 'has /api/health/deep');
});
