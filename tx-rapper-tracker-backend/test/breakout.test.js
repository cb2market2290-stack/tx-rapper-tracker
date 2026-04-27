// test/breakout.test.js
// Phase 3a.1 — offline coverage for src/services/breakout.js + the zod
// schema in src/routes/insights.js.
//
// The DB-touching paths (refreshBreakoutSignals, getTopMovers, getAllSignals
// SQL execution) are exercised end-to-end by scripts/test-insights.sh
// against a real Postgres. What we protect here is the part most likely to
// regress on a careless refactor:
//
//   1. Input validation in getTopMovers — limit bounds, sortBy enum.
//   2. shapeRow snake_case → camelCase, including the BIGINT-as-string
//      quirk from node-postgres (lifetime_views can come back as a
//      string when it exceeds Number.MAX_SAFE_INTEGER).
//   3. BreakoutQuery zod schema — defaults, coercion, enum, includePartial
//      string→bool, all of the validation surface the public route relies on.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Required env BEFORE importing the service (transitively loads config.js
// + db/pool.js). The pure helpers don't actually use the pool but the
// import-time validation fires regardless.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const { shapeRow, getTopMovers, VALID_SORTS } = await import(
  '../src/services/breakout.js'
);
const { BreakoutQuery } = await import('../src/routes/insights.js');

// ---------------------------------------------------------------------------
// VALID_SORTS — keeps the routes/insights.js zod enum and the SORT_CLAUSES
// keyed table in lock-step. If someone adds a 4th sort to the service but
// forgets to update VALID_SORTS, the route enum quietly desyncs.
// ---------------------------------------------------------------------------

test('VALID_SORTS exposes the documented three sort modes', () => {
  assert.deepEqual([...VALID_SORTS].sort(), [
    'acceleration',
    'growth',
    'percentage',
  ]);
});

// ---------------------------------------------------------------------------
// shapeRow — snake_case PG row → camelCase API JSON
// ---------------------------------------------------------------------------

test('shapeRow converts snake_case to camelCase and coerces numbers', () => {
  const row = {
    artist_id: '11111111-2222-3333-4444-555555555555',
    artist_name: 'GloRilla',
    as_of: '2026-04-27',
    views_now: '12500000',          // BIGINT-as-string from node-pg
    views_7d_ago: '12000000',
    views_14d_ago: '11500000',
    view_growth_7d: '500000',
    pct_growth_7d: 0.0416,            // already a JS number (DOUBLE PRECISION)
    acceleration_7d: '0',
    has_full_window: true,
    computed_at: '2026-04-27T04:05:00.000Z',
  };
  const r = shapeRow(row);
  assert.equal(r.artistId, '11111111-2222-3333-4444-555555555555');
  assert.equal(r.artistName, 'GloRilla');
  assert.equal(r.asOf, '2026-04-27');
  assert.equal(r.viewsNow, 12500000);
  assert.equal(typeof r.viewsNow, 'number');
  assert.equal(r.views7dAgo, 12000000);
  assert.equal(r.views14dAgo, 11500000);
  assert.equal(r.viewGrowth7d, 500000);
  assert.equal(r.pctGrowth7d, 0.0416);
  assert.equal(r.acceleration7d, 0);
  assert.equal(r.hasFullWindow, true);
  assert.equal(r.computedAt, '2026-04-27T04:05:00.000Z');
});

test('shapeRow leaves missing window fields as null instead of NaN', () => {
  // A newly-rostered artist: only views_now is populated, the lookback
  // subselects returned NULL. We must NOT turn those into 0 (would
  // misrepresent "no data" as "no growth") or NaN (would JSON-serialize
  // as null but break math).
  const row = {
    artist_id: 'xx',
    artist_name: 'New Artist',
    as_of: '2026-04-27',
    views_now: '100000',
    views_7d_ago: null,
    views_14d_ago: null,
    view_growth_7d: '0',
    pct_growth_7d: null,
    acceleration_7d: '0',
    has_full_window: false,
    computed_at: '2026-04-27T04:05:00.000Z',
  };
  const r = shapeRow(row);
  assert.equal(r.views7dAgo, null);
  assert.equal(r.views14dAgo, null);
  assert.equal(r.pctGrowth7d, null);
  assert.equal(r.hasFullWindow, false);
});

test('shapeRow coerces has_full_window truthy values to true booleans', () => {
  // node-pg can return 't'/'f' or true/false depending on driver version.
  const r = shapeRow({
    artist_id: 'x',
    artist_name: 'x',
    as_of: '2026-04-27',
    views_now: '0',
    views_7d_ago: '0',
    views_14d_ago: '0',
    view_growth_7d: '0',
    pct_growth_7d: 0,
    acceleration_7d: '0',
    has_full_window: 't',
    computed_at: '2026-04-27T04:05:00.000Z',
  });
  assert.equal(r.hasFullWindow, true);
});

test('shapeRow turns garbage views_now into null instead of NaN', () => {
  // Defense-in-depth: if a future migration drops in a non-numeric column,
  // the JSON should stay valid rather than emitting "viewsNow":null
  // alongside a 200, or worse — emitting NaN which isn't JSON-serializable.
  const r = shapeRow({
    artist_id: 'x',
    artist_name: 'x',
    as_of: '2026-04-27',
    views_now: 'oops',
    views_7d_ago: '0',
    views_14d_ago: '0',
    view_growth_7d: '0',
    pct_growth_7d: 0,
    acceleration_7d: '0',
    has_full_window: false,
    computed_at: '2026-04-27T04:05:00.000Z',
  });
  assert.equal(r.viewsNow, null);
});

// ---------------------------------------------------------------------------
// getTopMovers — input validation, no DB hit
// ---------------------------------------------------------------------------
//
// The validation throws BEFORE the SQL call, so we can exercise it without
// a live pool. Rejection means the await never reaches `query()`.

test('getTopMovers rejects a non-integer limit', async () => {
  await assert.rejects(() => getTopMovers({ limit: 5.5 }), /limit/);
});

test('getTopMovers rejects a limit below 1', async () => {
  await assert.rejects(() => getTopMovers({ limit: 0 }), /limit/);
});

test('getTopMovers rejects a limit above 50', async () => {
  await assert.rejects(() => getTopMovers({ limit: 51 }), /limit/);
});

test('getTopMovers rejects an unknown sortBy', async () => {
  await assert.rejects(
    () => getTopMovers({ sortBy: 'nope' }),
    /sortBy must be one of/
  );
});

test('getTopMovers error mentions all valid sort modes (so the API surface is discoverable)', async () => {
  try {
    await getTopMovers({ sortBy: 'nope' });
    assert.fail('expected rejection');
  } catch (err) {
    for (const sort of VALID_SORTS) {
      assert.match(err.message, new RegExp(sort), `error should mention "${sort}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// BreakoutQuery — zod schema in routes/insights.js
// ---------------------------------------------------------------------------

test('BreakoutQuery accepts an empty input and applies defaults', () => {
  const r = BreakoutQuery.safeParse({});
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 5);
  assert.equal(r.data.sortBy, 'growth');
  assert.equal(r.data.includePartial, false);
});

test('BreakoutQuery coerces limit from string (Express gives us strings)', () => {
  const r = BreakoutQuery.safeParse({ limit: '10' });
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 10);
  assert.equal(typeof r.data.limit, 'number');
});

test('BreakoutQuery rejects limit out of bounds', () => {
  assert.equal(BreakoutQuery.safeParse({ limit: '0' }).success, false);
  assert.equal(BreakoutQuery.safeParse({ limit: '51' }).success, false);
  assert.equal(BreakoutQuery.safeParse({ limit: 'lots' }).success, false);
});

test('BreakoutQuery accepts each valid sortBy', () => {
  for (const sort of VALID_SORTS) {
    const r = BreakoutQuery.safeParse({ sortBy: sort });
    assert.equal(r.success, true, `sortBy=${sort} should validate`);
    assert.equal(r.data.sortBy, sort);
  }
});

test('BreakoutQuery rejects an unknown sortBy', () => {
  const r = BreakoutQuery.safeParse({ sortBy: 'velocity' });
  assert.equal(r.success, false);
});

test('BreakoutQuery coerces includePartial=true (string) to boolean', () => {
  const r = BreakoutQuery.safeParse({ includePartial: 'true' });
  assert.equal(r.success, true);
  assert.equal(r.data.includePartial, true);
});

test('BreakoutQuery coerces includePartial=false (string) to boolean', () => {
  const r = BreakoutQuery.safeParse({ includePartial: 'false' });
  assert.equal(r.success, true);
  assert.equal(r.data.includePartial, false);
});

test('BreakoutQuery accepts native boolean includePartial', () => {
  assert.equal(
    BreakoutQuery.safeParse({ includePartial: true }).data.includePartial,
    true
  );
  assert.equal(
    BreakoutQuery.safeParse({ includePartial: false }).data.includePartial,
    false
  );
});
