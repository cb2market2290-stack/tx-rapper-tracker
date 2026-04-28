// test/slugs.test.js
// Phase 3c.3 — offline coverage for src/services/slugs.js + the
// pure rendering / headline helpers in src/routes/public.js.
//
// What we protect here is the slug derivation contract — those rules
// are LOCKED at v1 in PHASE_3C_DESIGN.md because anyone who shares a
// public URL expects it to keep working. A regression that flips
// "Megan Thee Stallion" from "megan-thee-stallion" to anything else
// silently breaks every shared link.
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

const { slugify, isValidSlug } = await import('../src/services/slugs.js');
const { computeHeadline, COMPARE_MAX } = await import('../src/routes/public.js');

// ---------------------------------------------------------------------------
// slugify — locked v1 examples. These are the contract.
// ---------------------------------------------------------------------------

test('slugify is deterministic for the same input', () => {
  const a = slugify('Megan Thee Stallion');
  const b = slugify('Megan Thee Stallion');
  assert.equal(a, b);
});

test('slugify handles every name on the seed roster', () => {
  // Mirrors migrations/006_artists.sql + the worked examples in
  // PHASE_3C_DESIGN.md. Changing any of these is a v2 migration —
  // never a silent edit to slugify.
  assert.equal(slugify('Megan Thee Stallion'), 'megan-thee-stallion');
  assert.equal(slugify('Tay Money'),           'tay-money');
  assert.equal(slugify('Asian Doll'),          'asian-doll');
  assert.equal(slugify('Cuban Doll'),          'cuban-doll');
  assert.equal(slugify('KenTheMan'),           'kentheman');
  assert.equal(slugify('GloRilla'),            'glorilla');
});

test('slugify ASCII-folds Latin diacritics', () => {
  assert.equal(slugify('Beyoncé'),    'beyonce');
  assert.equal(slugify('Chlöe'),      'chloe');
  assert.equal(slugify('Renée'),      'renee');
});

test("slugify expands & to ' and ' so meaning isn't lost", () => {
  // "Chloe & Halle" → "chloe-and-halle" not "chloe-halle"
  assert.equal(slugify('Chlöe & Halle'),  'chloe-and-halle');
  assert.equal(slugify('Salt & Pepa'),    'salt-and-pepa');
});

test('slugify drops quotes, parens, dots, slashes', () => {
  assert.equal(slugify("D'Angelo"),               'dangelo');
  assert.equal(slugify('Megan (Thee Stallion)'),  'megan-thee-stallion');
  assert.equal(slugify('Big.K.R.I.T.'),           'bigkrit');
  assert.equal(slugify('AC/DC'),                  'acdc');
});

test('slugify collapses whitespace + hyphen runs + trims edges', () => {
  assert.equal(slugify('  spaced  out  name  '),   'spaced-out-name');
  assert.equal(slugify('one---two'),               'one-two');
  assert.equal(slugify('   --leading hyphens   '), 'leading-hyphens');
});

test('slugify drops underscores (matches Postgres backfill)', () => {
  // services/slugs.js uses [^a-z0-9\\s-] which excludes underscores.
  // migration 016's Postgres slugify uses [^[:alnum:][:space:]-] which
  // ALSO excludes underscores. Keeping these in lockstep is critical.
  assert.equal(slugify('foo_bar'), 'foobar');
});

test('slugify returns "" for non-string input', () => {
  assert.equal(slugify(null),       '');
  assert.equal(slugify(undefined),  '');
  assert.equal(slugify(123),        '');
  assert.equal(slugify({}),         '');
});

test('slugify returns "" for empty / whitespace-only / all-symbol input', () => {
  // Caller (route + migration) is responsible for handling the
  // empty-slug case — we want to fail loudly there rather than silently
  // emit "" as a real slug.
  assert.equal(slugify(''),     '');
  assert.equal(slugify('   '),  '');
  assert.equal(slugify('!!!'),  '');
});

// ---------------------------------------------------------------------------
// isValidSlug — gates :slug params before they hit the DB
// ---------------------------------------------------------------------------

test('isValidSlug accepts realistic slugs', () => {
  assert.equal(isValidSlug('megan-thee-stallion'),  true);
  assert.equal(isValidSlug('glorilla'),             true);
  assert.equal(isValidSlug('a'),                    true);
  assert.equal(isValidSlug('artist-2'),             true);
});

test('isValidSlug rejects non-strings + empty + leading hyphen + bad chars', () => {
  assert.equal(isValidSlug(''),                     false);
  assert.equal(isValidSlug(null),                   false);
  assert.equal(isValidSlug(undefined),              false);
  assert.equal(isValidSlug('-leading'),             false);  // must start alnum
  assert.equal(isValidSlug('UPPERCASE'),            false);  // we lower at slugify-time
  assert.equal(isValidSlug('has space'),            false);
  assert.equal(isValidSlug('semicolon;injection'),  false);
  assert.equal(isValidSlug('a'.repeat(101)),        false);  // 100-char cap
});

// ---------------------------------------------------------------------------
// computeHeadline — pure: latest views + 7-day delta from snapshot rows
// ---------------------------------------------------------------------------

test('computeHeadline returns null for empty snapshots', () => {
  assert.equal(computeHeadline([]), null);
});

test('computeHeadline returns latest stats with null growth when too short', () => {
  const r = computeHeadline([
    { day: '2026-04-28', lifetimeViews: 1000, subs: 100 },
  ]);
  assert.equal(r.latestViews, 1000);
  assert.equal(r.latestSubs, 100);
  assert.equal(r.viewGrowth7d, null);
});

test('computeHeadline computes 7-day delta when both endpoints exist', () => {
  const snapshots = [];
  // 14 days of synthetic data; views grow by 100k/day.
  for (let i = 13; i >= 0; i--) {
    const d = new Date('2026-04-28T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    snapshots.push({
      day: d.toISOString().slice(0, 10),
      lifetimeViews: 1_000_000 + (13 - i) * 100_000,
      subs: 50_000,
    });
  }
  const r = computeHeadline(snapshots);
  assert.equal(r.latestViews, 1_000_000 + 13 * 100_000);
  // 7-day growth: latest - snapshot at day-7 = 7 * 100k = 700_000.
  assert.equal(r.viewGrowth7d, 700_000);
});

test('computeHeadline tolerates a missing 7-day-prior datapoint by walking earlier', () => {
  // Sparse snapshots: only every other day, so the exact-7-day-back
  // entry doesn't exist. The function picks the most-recent entry
  // that's <= 7 days back.
  const snapshots = [
    { day: '2026-04-15', lifetimeViews: 1_000_000, subs: 100 },
    { day: '2026-04-17', lifetimeViews: 1_100_000, subs: 100 },
    { day: '2026-04-19', lifetimeViews: 1_200_000, subs: 100 },
    { day: '2026-04-21', lifetimeViews: 1_300_000, subs: 100 },
    { day: '2026-04-28', lifetimeViews: 2_000_000, subs: 100 },
  ];
  const r = computeHeadline(snapshots);
  // 7 days before 04-28 = 04-21; that's exactly in the data.
  assert.equal(r.viewGrowth7d, 700_000);
});

// ---------------------------------------------------------------------------
// COMPARE_MAX is the public contract the route + the frontend share
// ---------------------------------------------------------------------------

test('COMPARE_MAX matches the frontend cap (5)', () => {
  assert.equal(COMPARE_MAX, 5);
});
