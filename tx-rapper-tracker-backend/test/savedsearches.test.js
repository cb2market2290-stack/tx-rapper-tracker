// test/savedsearches.test.js
// Phase 3a.2 — offline coverage for src/services/savedsearches.js.
//
// The DB-touching paths (listForUser / countForUser / create / update /
// remove SQL execution) are exercised end-to-end by
// scripts/test-saved-searches.sh against a real Postgres. What we
// protect here is the part most likely to regress on a careless refactor:
//
//   1. Tier-cap math — TIER_CAPS / capForPlanSlug / isOverCap. The
//      "free=1, pro=5, paid=5, premium=null" contract is deploy-config
//      and a wrong number means people pay for nothing.
//   2. normalizeCreatePayload — every required field, every range
//      check, every error path. The route depends on this throwing
//      ValidationError on bad input and shaping it through on good.
//   3. normalizeUpdatePayload — the patch shape (any-subset, at-least-
//      one-field), and that an empty/object/null patch all reject.
//   4. shapeRow — snake→camel + Number coercion + has-Bigint-as-string
//      tolerance, same way breakout.test.js does for its service.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Same env shim as test/breakout.test.js — config.js validates required
// env at import time even when the test never calls into the DB layer.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const {
  TIER_CAPS,
  VALID_METRICS,
  VALID_COMPARATORS,
  ValidationError,
  TierCapError,
  capForPlanSlug,
  isOverCap,
  normalizeCreatePayload,
  normalizeUpdatePayload,
  shapeRow,
} = await import('../src/services/savedsearches.js');

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

// ---------------------------------------------------------------------------
// Constants — keeps migration 014's CHECK in lock-step with JS.
// ---------------------------------------------------------------------------

test('VALID_METRICS exposes the documented four metrics', () => {
  assert.deepEqual([...VALID_METRICS].sort(), [
    'acceleration_7d',
    'lifetime_views',
    'pct_growth_7d',
    'view_growth_7d',
  ]);
});

test('VALID_COMPARATORS exposes >, >=, <, <=', () => {
  assert.deepEqual([...VALID_COMPARATORS].sort(), ['<', '<=', '>', '>=']);
});

// ---------------------------------------------------------------------------
// TIER_CAPS — Free 1, Pro 5, Premium ∞, with a paid back-compat slot.
// ---------------------------------------------------------------------------

test('TIER_CAPS gives Free 1 / Pro 5 / Premium ∞ / paid 5', () => {
  assert.equal(TIER_CAPS.free, 1);
  assert.equal(TIER_CAPS.pro, 5);
  assert.equal(TIER_CAPS.paid, 5);
  assert.equal(TIER_CAPS.premium, null);
});

test('capForPlanSlug returns the cap for known slugs', () => {
  assert.equal(capForPlanSlug('free'), 1);
  assert.equal(capForPlanSlug('pro'), 5);
  assert.equal(capForPlanSlug('paid'), 5);
  assert.equal(capForPlanSlug('premium'), null);
});

test('capForPlanSlug fails CLOSED on unknown slugs (returns free cap)', () => {
  // If pricing_tiers ever returns a slug we don't know, give the user
  // the free cap, not unlimited. Better to under-grant than to leak.
  assert.equal(capForPlanSlug('enterprise'), 1);
  assert.equal(capForPlanSlug(undefined), 1);
  assert.equal(capForPlanSlug(null), 1);
});

test('isOverCap returns true at-or-above cap, false below, false on unlimited', () => {
  assert.equal(isOverCap({ planSlug: 'free', count: 0 }), false);
  assert.equal(isOverCap({ planSlug: 'free', count: 1 }), true);
  assert.equal(isOverCap({ planSlug: 'free', count: 2 }), true);
  assert.equal(isOverCap({ planSlug: 'pro', count: 4 }), false);
  assert.equal(isOverCap({ planSlug: 'pro', count: 5 }), true);
  // Unlimited tier is never over cap, no matter the count.
  assert.equal(isOverCap({ planSlug: 'premium', count: 9999 }), false);
});

// ---------------------------------------------------------------------------
// normalizeCreatePayload — happy path + every rejection branch
// ---------------------------------------------------------------------------

test('normalizeCreatePayload accepts a minimal valid payload', () => {
  const r = normalizeCreatePayload({
    name: 'Megan over 1M weekly',
    metric: 'view_growth_7d',
    threshold: 1000000,
    comparator: '>',
  });
  assert.equal(r.name, 'Megan over 1M weekly');
  assert.equal(r.metric, 'view_growth_7d');
  assert.equal(r.threshold, 1000000);
  assert.equal(r.comparator, '>');
  assert.equal(r.artistId, null);
  assert.equal(r.enabled, true); // default
});

test('normalizeCreatePayload trims name and respects 1–80 char range', () => {
  const r = normalizeCreatePayload({
    name: '  spacey   ',
    metric: 'pct_growth_7d',
    threshold: 0.05,
    comparator: '>=',
  });
  assert.equal(r.name, 'spacey');

  // Empty after trim
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: '   ',
        metric: 'pct_growth_7d',
        threshold: 0.05,
        comparator: '>=',
      }),
    ValidationError
  );
  // Over 80 chars
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: 'x'.repeat(81),
        metric: 'pct_growth_7d',
        threshold: 0.05,
        comparator: '>=',
      }),
    ValidationError
  );
});

test('normalizeCreatePayload accepts a string-numeric threshold', () => {
  // curl smokes can land here — JSON bodies don't auto-coerce.
  const r = normalizeCreatePayload({
    name: 'x',
    metric: 'view_growth_7d',
    threshold: '500000',
    comparator: '>',
  });
  assert.equal(r.threshold, 500000);
  assert.equal(typeof r.threshold, 'number');
});

test('normalizeCreatePayload rejects non-finite thresholds', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'oops', null, undefined, {}]) {
    assert.throws(
      () =>
        normalizeCreatePayload({
          name: 'x',
          metric: 'view_growth_7d',
          threshold: bad,
          comparator: '>',
        }),
      ValidationError,
      `expected ${String(bad)} to throw`
    );
  }
});

test('normalizeCreatePayload range-checks pct_growth_7d (-1..100)', () => {
  // 0.05 = +5%, valid
  assert.equal(
    normalizeCreatePayload({
      name: 'x',
      metric: 'pct_growth_7d',
      threshold: 0.05,
      comparator: '>',
    }).threshold,
    0.05
  );
  // -1 = -100% loss, valid edge
  assert.doesNotThrow(() =>
    normalizeCreatePayload({
      name: 'x',
      metric: 'pct_growth_7d',
      threshold: -1,
      comparator: '>',
    })
  );
  // -1.5 = below -100%, nonsensical
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: 'x',
        metric: 'pct_growth_7d',
        threshold: -1.5,
        comparator: '>',
      }),
    ValidationError
  );
  // 101 = unit confusion (101% as 101.0 instead of 1.01) → reject
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: 'x',
        metric: 'pct_growth_7d',
        threshold: 101,
        comparator: '>',
      }),
    ValidationError
  );
});

test('normalizeCreatePayload rejects negative lifetime_views', () => {
  // No artist has fewer than 0 views.
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: 'x',
        metric: 'lifetime_views',
        threshold: -1,
        comparator: '>',
      }),
    ValidationError
  );
  // 0 is fine — "any artist with at least one view" is a real query.
  assert.doesNotThrow(() =>
    normalizeCreatePayload({
      name: 'x',
      metric: 'lifetime_views',
      threshold: 0,
      comparator: '>',
    })
  );
});

test('normalizeCreatePayload rejects unknown metrics', () => {
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: 'x',
        metric: 'velocity',
        threshold: 0,
        comparator: '>',
      }),
    /metric must be one of/
  );
});

test('normalizeCreatePayload rejects unknown comparators', () => {
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: 'x',
        metric: 'view_growth_7d',
        threshold: 1000,
        comparator: '==',
      }),
    /comparator must be one of/
  );
});

test('normalizeCreatePayload accepts artistId UUID and rejects non-UUID', () => {
  const r = normalizeCreatePayload({
    name: 'x',
    metric: 'view_growth_7d',
    threshold: 1000,
    comparator: '>',
    artistId: VALID_UUID,
  });
  assert.equal(r.artistId, VALID_UUID);

  // Empty string and null both → null artistId (= "any artist")
  assert.equal(
    normalizeCreatePayload({
      name: 'x',
      metric: 'view_growth_7d',
      threshold: 1000,
      comparator: '>',
      artistId: '',
    }).artistId,
    null
  );
  assert.equal(
    normalizeCreatePayload({
      name: 'x',
      metric: 'view_growth_7d',
      threshold: 1000,
      comparator: '>',
      artistId: null,
    }).artistId,
    null
  );

  // Non-UUID strings throw
  assert.throws(
    () =>
      normalizeCreatePayload({
        name: 'x',
        metric: 'view_growth_7d',
        threshold: 1000,
        comparator: '>',
        artistId: 'not-a-uuid',
      }),
    ValidationError
  );
});

test('normalizeCreatePayload coerces enabled to a boolean', () => {
  // Default true
  assert.equal(
    normalizeCreatePayload({
      name: 'x',
      metric: 'view_growth_7d',
      threshold: 1000,
      comparator: '>',
    }).enabled,
    true
  );
  // Explicit false
  assert.equal(
    normalizeCreatePayload({
      name: 'x',
      metric: 'view_growth_7d',
      threshold: 1000,
      comparator: '>',
      enabled: false,
    }).enabled,
    false
  );
  // Truthy string → true
  assert.equal(
    normalizeCreatePayload({
      name: 'x',
      metric: 'view_growth_7d',
      threshold: 1000,
      comparator: '>',
      enabled: 'yes',
    }).enabled,
    true
  );
});

test('normalizeCreatePayload rejects null/non-object payloads', () => {
  for (const bad of [null, undefined, 'string', 42, true]) {
    assert.throws(() => normalizeCreatePayload(bad), ValidationError);
  }
});

// ---------------------------------------------------------------------------
// normalizeUpdatePayload — patch surface
// ---------------------------------------------------------------------------

test('normalizeUpdatePayload accepts a single-field patch', () => {
  const r = normalizeUpdatePayload({ enabled: false });
  assert.deepEqual(r, { enabled: false });
});

test('normalizeUpdatePayload trims name', () => {
  assert.equal(normalizeUpdatePayload({ name: '  hi  ' }).name, 'hi');
});

test('normalizeUpdatePayload rejects empty patches', () => {
  assert.throws(() => normalizeUpdatePayload({}), /at least one/);
});

test('normalizeUpdatePayload rejects bad metric on patch', () => {
  assert.throws(
    () => normalizeUpdatePayload({ metric: 'velocity' }),
    /metric must be one of/
  );
});

test('normalizeUpdatePayload rejects bad comparator on patch', () => {
  assert.throws(
    () => normalizeUpdatePayload({ comparator: '==' }),
    /comparator must be one of/
  );
});

test('normalizeUpdatePayload rejects non-finite threshold', () => {
  assert.throws(
    () => normalizeUpdatePayload({ threshold: NaN }),
    ValidationError
  );
  assert.throws(
    () => normalizeUpdatePayload({ threshold: 'oops' }),
    ValidationError
  );
});

test('normalizeUpdatePayload accepts artistId=null to clear scope', () => {
  assert.equal(normalizeUpdatePayload({ artistId: null }).artistId, null);
  assert.equal(normalizeUpdatePayload({ artistId: '' }).artistId, null);
});

test('normalizeUpdatePayload rejects non-UUID artistId', () => {
  assert.throws(
    () => normalizeUpdatePayload({ artistId: 'oops' }),
    ValidationError
  );
});

test('normalizeUpdatePayload rejects non-object inputs', () => {
  for (const bad of [null, undefined, 'string', 42]) {
    assert.throws(() => normalizeUpdatePayload(bad), ValidationError);
  }
});

// ---------------------------------------------------------------------------
// shapeRow — snake_case → camelCase, BIGINT-as-string handling
// ---------------------------------------------------------------------------

test('shapeRow converts a saved-searches row to camelCase', () => {
  const row = {
    id: VALID_UUID,
    user_id: '99999999-8888-7777-6666-555555555555',
    name: 'Megan over 1M weekly',
    metric: 'view_growth_7d',
    threshold: '1000000',           // node-pg can return BIGINT-ish as string
    comparator: '>',
    artist_id: null,
    enabled: 't',                    // node-pg can return 't'/'f' depending on version
    last_alerted_at: null,
    last_match_artist_id: null,
    last_match_value: null,
    created_at: '2026-04-27T04:00:00.000Z',
    updated_at: '2026-04-27T04:00:00.000Z',
  };
  const r = shapeRow(row);
  assert.equal(r.id, VALID_UUID);
  assert.equal(r.userId, '99999999-8888-7777-6666-555555555555');
  assert.equal(r.name, 'Megan over 1M weekly');
  assert.equal(r.metric, 'view_growth_7d');
  assert.equal(r.threshold, 1000000);
  assert.equal(typeof r.threshold, 'number');
  assert.equal(r.comparator, '>');
  assert.equal(r.artistId, null);
  assert.equal(r.enabled, true);
  assert.equal(r.lastAlertedAt, null);
  assert.equal(r.lastMatchArtistId, null);
  assert.equal(r.lastMatchValue, null);
  assert.equal(r.createdAt, '2026-04-27T04:00:00.000Z');
  assert.equal(r.updatedAt, '2026-04-27T04:00:00.000Z');
});

test('shapeRow returns null on a null row', () => {
  assert.equal(shapeRow(null), null);
  assert.equal(shapeRow(undefined), null);
});

test('shapeRow coerces last_match_value as Number when present', () => {
  const r = shapeRow({
    id: VALID_UUID,
    user_id: VALID_UUID,
    name: 'x',
    metric: 'pct_growth_7d',
    threshold: 0.05,
    comparator: '>',
    artist_id: null,
    enabled: false,
    last_alerted_at: '2026-04-26T04:00:00.000Z',
    last_match_artist_id: VALID_UUID,
    last_match_value: '0.123',
    created_at: '2026-04-27T04:00:00.000Z',
    updated_at: '2026-04-27T04:00:00.000Z',
  });
  assert.equal(r.lastMatchValue, 0.123);
  assert.equal(r.enabled, false);
});

// ---------------------------------------------------------------------------
// TierCapError — shape sanity
// ---------------------------------------------------------------------------

test('TierCapError carries planSlug, cap, count, and the kind tag', () => {
  const err = new TierCapError({ planSlug: 'free', cap: 1, count: 1 });
  assert.equal(err.name, 'TierCapError');
  assert.equal(err.kind, 'savedsearches.tier_cap');
  assert.equal(err.planSlug, 'free');
  assert.equal(err.cap, 1);
  assert.equal(err.count, 1);
  // Message is human-readable enough for a smoke test failure to be useful.
  assert.match(err.message, /tier cap/);
  assert.match(err.message, /free/);
  assert.match(err.message, /1/);
});
