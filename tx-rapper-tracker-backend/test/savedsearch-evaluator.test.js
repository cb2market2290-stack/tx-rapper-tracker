// test/savedsearch-evaluator.test.js
// Phase 3a.3 — offline coverage for src/services/savedsearch-evaluator.js.
//
// The DB-touching paths (loadDueSavedSearches, findMatches, recordAlert,
// evaluateAllSavedSearches end-to-end) are exercised by a live smoke
// in scripts/test-saved-search-eval.sh. Here we protect:
//
//   1. metricColumn — metric → column. If someone renames a column in
//      breakout_signals without updating this map, the WHERE clause in
//      findMatches will reference a missing column and silently match
//      nothing.
//   2. applyComparator — the four operators on numbers, strings, and
//      null. The 24h cooling-off cap depends on this being correct;
//      a bug here means alerts that should fire don't, or vice versa.
//   3. shouldAlert — the 24h window math, including the
//      never-alerted-yet case and the boundary.
//   4. humanizeMetric / humanizeComparator — pure label helpers.
//   5. formatValueForMetric — pct vs raw vs null.
//   6. buildEmailPayload — subject lines for scoped/unscoped, body
//      contains rule + match list + dashboard link, html escaping.
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

const {
  applyComparator,
  metricColumn,
  shouldAlert,
  humanizeMetric,
  humanizeComparator,
  formatValueForMetric,
  buildEmailPayload,
} = await import('../src/services/savedsearch-evaluator.js');

// ---------------------------------------------------------------------------
// metricColumn
// ---------------------------------------------------------------------------

test('metricColumn maps each saved-search metric to a breakout_signals column', () => {
  assert.equal(metricColumn('view_growth_7d'), 'view_growth_7d');
  assert.equal(metricColumn('pct_growth_7d'), 'pct_growth_7d');
  assert.equal(metricColumn('acceleration_7d'), 'acceleration_7d');
  // lifetime_views aliases to views_now (the matview's lifetime passthrough).
  assert.equal(metricColumn('lifetime_views'), 'views_now');
});

test('metricColumn throws on unknown metric (defense against typos)', () => {
  assert.throws(() => metricColumn('velocity'), /unknown metric/);
});

// ---------------------------------------------------------------------------
// applyComparator
// ---------------------------------------------------------------------------

test('applyComparator: > strict greater-than', () => {
  assert.equal(applyComparator(1000001, '>', 1000000), true);
  assert.equal(applyComparator(1000000, '>', 1000000), false);
  assert.equal(applyComparator(999999, '>', 1000000), false);
});

test('applyComparator: >= greater-or-equal', () => {
  assert.equal(applyComparator(1000001, '>=', 1000000), true);
  assert.equal(applyComparator(1000000, '>=', 1000000), true);
  assert.equal(applyComparator(999999, '>=', 1000000), false);
});

test('applyComparator: < strict less-than', () => {
  assert.equal(applyComparator(50, '<', 100), true);
  assert.equal(applyComparator(100, '<', 100), false);
  assert.equal(applyComparator(150, '<', 100), false);
});

test('applyComparator: <= less-or-equal', () => {
  assert.equal(applyComparator(50, '<=', 100), true);
  assert.equal(applyComparator(100, '<=', 100), true);
  assert.equal(applyComparator(150, '<=', 100), false);
});

test('applyComparator coerces BIGINT-as-string from node-pg', () => {
  // The matview returns view_growth_7d as a stringified bigint — the
  // evaluator must treat that as a number, not do a lexicographic compare.
  assert.equal(applyComparator('1500000', '>', 1000000), true);
  // Lex compare would say '999' > '1000' (string sort); numeric must say no.
  assert.equal(applyComparator('999', '>', 1000), false);
});

test('applyComparator returns false on null / NaN / non-numeric', () => {
  assert.equal(applyComparator(null, '>', 0), false);
  assert.equal(applyComparator(undefined, '>', 0), false);
  assert.equal(applyComparator(NaN, '>', 0), false);
  assert.equal(applyComparator('oops', '>', 0), false);
});

test('applyComparator throws on unknown operator', () => {
  assert.throws(() => applyComparator(1, '==', 1), /unknown comparator/);
});

// ---------------------------------------------------------------------------
// shouldAlert — the 24h cooling-off cap
// ---------------------------------------------------------------------------

test('shouldAlert returns true when never alerted', () => {
  assert.equal(shouldAlert({ last_alerted_at: null }, new Date()), true);
  assert.equal(shouldAlert({}, new Date()), true);
  assert.equal(shouldAlert(null, new Date()), true);
});

test('shouldAlert returns false within 24h of last alert', () => {
  const now = new Date('2026-04-27T12:00:00Z');
  // 23 hours ago — still cooling off.
  const recent = new Date(now.getTime() - 23 * 3600 * 1000);
  assert.equal(
    shouldAlert({ last_alerted_at: recent.toISOString() }, now),
    false
  );
});

test('shouldAlert returns true at-or-after 24h', () => {
  const now = new Date('2026-04-27T12:00:00Z');
  const exactly24h = new Date(now.getTime() - 24 * 3600 * 1000);
  assert.equal(
    shouldAlert({ last_alerted_at: exactly24h.toISOString() }, now),
    true
  );
  // 25 hours ago — definitely free.
  const earlier = new Date(now.getTime() - 25 * 3600 * 1000);
  assert.equal(
    shouldAlert({ last_alerted_at: earlier.toISOString() }, now),
    true
  );
});

// ---------------------------------------------------------------------------
// humanizeMetric / humanizeComparator
// ---------------------------------------------------------------------------

test('humanizeMetric labels each metric for emails', () => {
  assert.equal(humanizeMetric('view_growth_7d'), '7-day view growth');
  assert.equal(humanizeMetric('pct_growth_7d'), '7-day percentage growth');
  assert.equal(humanizeMetric('acceleration_7d'), '7-day acceleration');
  assert.equal(humanizeMetric('lifetime_views'), 'lifetime views');
});

test('humanizeComparator gives an English direction word per operator', () => {
  assert.equal(humanizeComparator('>'), 'above');
  assert.equal(humanizeComparator('>='), 'at or above');
  assert.equal(humanizeComparator('<'), 'below');
  assert.equal(humanizeComparator('<='), 'at or below');
});

// ---------------------------------------------------------------------------
// formatValueForMetric — pct vs raw count
// ---------------------------------------------------------------------------

test('formatValueForMetric formats pct_growth_7d with sign and one decimal', () => {
  assert.equal(formatValueForMetric('pct_growth_7d', 0.05), '+5.0%');
  assert.equal(formatValueForMetric('pct_growth_7d', -0.123), '-12.3%');
  assert.equal(formatValueForMetric('pct_growth_7d', 0), '0.0%');
});

test('formatValueForMetric uses compact-int for raw counts', () => {
  // Spot-check the boundaries of the K/M/B suffixes.
  assert.equal(formatValueForMetric('view_growth_7d', 999), '999');
  assert.equal(formatValueForMetric('view_growth_7d', 1500), '1.5K');
  assert.equal(formatValueForMetric('view_growth_7d', 1500000), '1.50M');
  assert.equal(formatValueForMetric('view_growth_7d', 12500000000), '12.50B');
  // Negative prefix
  assert.equal(formatValueForMetric('view_growth_7d', -350000), '-350.0K');
});

test('formatValueForMetric returns "n/a" on null / NaN', () => {
  assert.equal(formatValueForMetric('view_growth_7d', null), 'n/a');
  assert.equal(formatValueForMetric('view_growth_7d', undefined), 'n/a');
  assert.equal(formatValueForMetric('view_growth_7d', NaN), 'n/a');
});

// ---------------------------------------------------------------------------
// buildEmailPayload — pure email construction
// ---------------------------------------------------------------------------

const SAVED_SEARCH_BROAD = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Anyone over 1M weekly',
  metric: 'view_growth_7d',
  threshold: 1000000,
  comparator: '>',
  artist_id: null, // any-artist scope
  enabled: true,
  last_alerted_at: null,
};

const SAVED_SEARCH_SCOPED = {
  ...SAVED_SEARCH_BROAD,
  name: 'Megan over 500K',
  threshold: 500000,
  artist_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};

const MATCHES_BROAD = [
  { artist_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', artist_name: 'GloRilla', value: 2500000 },
  { artist_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', artist_name: 'Sexyy Red', value: 1750000 },
];

test('buildEmailPayload subject for any-artist scope mentions match count', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_BROAD,
    matches: MATCHES_BROAD,
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com',
  });
  assert.equal(p.to, 'paul@example.com');
  assert.match(p.subject, /2 artists/);
  assert.match(p.subject, /Anyone over 1M weekly/);
});

test('buildEmailPayload subject for scoped search names the artist', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_SCOPED,
    matches: [{ artist_id: 'x', artist_name: 'Megan Thee Stallion', value: 800000 }],
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com',
  });
  assert.match(p.subject, /Megan Thee Stallion/);
  assert.match(p.subject, /Megan over 500K/);
});

test('buildEmailPayload text body includes rule line and every match', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_BROAD,
    matches: MATCHES_BROAD,
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com',
  });
  // Rule line summarizes the predicate so the user remembers WHY they
  // got the email even months later.
  assert.match(p.text, /7-day view growth above 1\.00M/);
  // Every match is named.
  assert.match(p.text, /GloRilla/);
  assert.match(p.text, /Sexyy Red/);
  // Each match has its formatted value.
  assert.match(p.text, /2\.50M/);
  assert.match(p.text, /1\.75M/);
});

test('buildEmailPayload text body includes the dashboard link', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_BROAD,
    matches: MATCHES_BROAD,
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com',
  });
  assert.match(p.text, /https:\/\/example\.com\/app/);
});

test('buildEmailPayload strips trailing slash from baseUrl', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_BROAD,
    matches: MATCHES_BROAD,
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com/', // trailing slash on purpose
  });
  // No double slashes in the link.
  assert.match(p.text, /https:\/\/example\.com\/app/);
  assert.doesNotMatch(p.text, /com\/\/app/);
});

test('buildEmailPayload html body escapes user-supplied content', () => {
  // A search name with HTML meta-chars must end up escaped, not
  // interpreted, in the HTML body. Defense against an attacker
  // (or just a creative user) crafting "<script>" into the name.
  const naughty = {
    ...SAVED_SEARCH_BROAD,
    name: 'Hax <script>alert(1)</script>',
  };
  const p = buildEmailPayload({
    savedSearch: naughty,
    matches: [{ artist_id: 'x', artist_name: 'Tame & Co', value: 1500000 }],
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com',
  });
  // The literal angle brackets must be escaped in the HTML.
  assert.match(p.html, /&lt;script&gt;/);
  assert.doesNotMatch(p.html, /<script>alert/);
  // & in the artist name must be escaped to &amp;
  assert.match(p.html, /Tame &amp; Co/);
});

test('buildEmailPayload html body has the recipient block, link, and unsubscribe-style hint', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_BROAD,
    matches: MATCHES_BROAD,
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com',
  });
  // Subject leaks into recipient field, not html
  assert.equal(p.to, 'paul@example.com');
  // Has dashboard link as anchor
  assert.match(p.html, /<a [^>]*href="https:\/\/example\.com\/app"/);
  // Has the polite "you can disable" footer
  assert.match(p.html, /disable or delete/i);
});

test('buildEmailPayload handles empty baseUrl by falling back to relative /app', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_BROAD,
    matches: MATCHES_BROAD,
    recipient: 'paul@example.com',
    baseUrl: '',
  });
  // Bare /app is the only sane fallback when nobody set APP_BASE_URL.
  assert.match(p.text, /\/app/);
  assert.match(p.html, /href="\/app"/);
});

test('buildEmailPayload says "1 artist" not "1 artists" for a single broad match', () => {
  const p = buildEmailPayload({
    savedSearch: SAVED_SEARCH_BROAD,
    matches: [MATCHES_BROAD[0]],
    recipient: 'paul@example.com',
    baseUrl: 'https://example.com',
  });
  assert.match(p.subject, /1 artist /);
  assert.doesNotMatch(p.subject, /1 artists/);
});
