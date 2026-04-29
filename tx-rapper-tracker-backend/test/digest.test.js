// test/digest.test.js
// Phase 3d.2 — offline coverage for src/services/digest.js.
// DB-touching paths (getUsersDueForDigest, recordDigestSent) covered
// by manual verify; what we protect here is the pure surface that's
// most likely to regress.
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

const digest = await import('../src/services/digest.js');
const {
  isDigestHourFor,
  isDueForResend,
  pickTopMovers,
  pickEmerging,
  buildDigestPayload,
  signUnsubToken,
  verifyUnsubToken,
  DIGEST_HOUR_LOCAL,
  DEFAULT_TZ,
  _TOP_N,
  _EMERGING_BASE_CAP,
  _RESEND_AFTER_DAYS,
} = digest;

// ─── isDigestHourFor ───────────────────────────────────────────────────

test('isDigestHourFor returns true at exactly 09:00 user-local', () => {
  // 14:00 UTC = 09:00 in America/Chicago (CST, UTC-5 during DST is
  // 09:00 CST... CDT is UTC-5; CST is UTC-6. April is CDT; 14:00 UTC
  // = 09:00 CDT.)
  const t = new Date('2026-04-27T14:00:00Z');
  assert.equal(isDigestHourFor({ tz: 'America/Chicago' }, t), true);
});

test('isDigestHourFor returns false at 08:00 and 10:00 user-local', () => {
  const eight = new Date('2026-04-27T13:00:00Z'); // 08:00 CDT
  const ten   = new Date('2026-04-27T15:00:00Z'); // 10:00 CDT
  assert.equal(isDigestHourFor({ tz: 'America/Chicago' }, eight), false);
  assert.equal(isDigestHourFor({ tz: 'America/Chicago' }, ten),   false);
});

test('isDigestHourFor falls back to DEFAULT_TZ when user has no tz', () => {
  const t = new Date('2026-04-27T14:00:00Z'); // 09:00 CDT == default
  assert.equal(isDigestHourFor({ tz: null }, t), true);
});

test('isDigestHourFor tolerates a bad TZ string by defaulting', () => {
  const t = new Date('2026-04-27T14:00:00Z'); // 09:00 in default
  assert.equal(isDigestHourFor({ tz: 'Not/A_Zone' }, t), true);
});

test('DIGEST_HOUR_LOCAL + DEFAULT_TZ are exposed as constants', () => {
  assert.equal(DIGEST_HOUR_LOCAL, 9);
  assert.equal(DEFAULT_TZ, 'America/Chicago');
});

// ─── isDueForResend ────────────────────────────────────────────────────

test('isDueForResend returns true for never-sent users', () => {
  assert.equal(isDueForResend({ digestLastSentAt: null }, new Date()), true);
});

test('isDueForResend returns true after RESEND_AFTER_DAYS', () => {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  assert.equal(
    isDueForResend({ digestLastSentAt: eightDaysAgo.toISOString() }, new Date()),
    true
  );
});

test('isDueForResend returns false within RESEND_AFTER_DAYS window', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  assert.equal(
    isDueForResend({ digestLastSentAt: twoDaysAgo.toISOString() }, new Date()),
    false
  );
});

// ─── pickTopMovers ─────────────────────────────────────────────────────

const SIGNALS_FIXTURE = [
  { artistName: 'Artist A', viewGrowth7d: 1_000_000, pctGrowth7d: 0.05, viewsNow: 20_000_000 },
  { artistName: 'Artist B', viewGrowth7d:   200_000, pctGrowth7d: 0.10, viewsNow:  2_000_000 },
  { artistName: 'Artist C', viewGrowth7d: 1_500_000, pctGrowth7d: 0.03, viewsNow: 50_000_000 },
  { artistName: 'Artist D', viewGrowth7d:    50_000, pctGrowth7d: 0.02, viewsNow:  3_000_000 },
  { artistName: 'Artist E', viewGrowth7d:   600_000, pctGrowth7d: 0.04, viewsNow: 15_000_000 },
  { artistName: 'Artist F', viewGrowth7d:    10_000, pctGrowth7d: 0.01, viewsNow:  1_000_000 },
  { artistName: 'Artist G', viewGrowth7d:      null, pctGrowth7d: null, viewsNow:        null },
];

test('pickTopMovers returns up to _TOP_N entries sorted by view_growth_7d desc', () => {
  const movers = pickTopMovers(SIGNALS_FIXTURE);
  assert.equal(movers.length, _TOP_N);
  assert.deepEqual(
    movers.map((m) => m.artistName),
    ['Artist C', 'Artist A', 'Artist E', 'Artist B', 'Artist D']
  );
});

test('pickTopMovers drops rows with null view_growth_7d', () => {
  const movers = pickTopMovers(SIGNALS_FIXTURE);
  assert.ok(!movers.some((m) => m.artistName === 'Artist G'));
});

test('pickTopMovers handles empty input gracefully', () => {
  assert.deepEqual(pickTopMovers([]), []);
  assert.deepEqual(pickTopMovers(null), []);
  assert.deepEqual(pickTopMovers(undefined), []);
});

// ─── pickEmerging ──────────────────────────────────────────────────────

test('pickEmerging returns highest pct_growth_7d under base-cap', () => {
  // Artist B: 10% growth from 2M views (under 5M cap) — should win.
  // Artist F: 1% growth from 1M — also under cap, but lower growth.
  const e = pickEmerging(SIGNALS_FIXTURE);
  assert.equal(e.artistName, 'Artist B');
});

test('pickEmerging skips artists over the base cap', () => {
  // Artist A has 5% growth from 20M views; over the 5M cap, should not
  // be picked even though pct is higher than candidates under the cap.
  const noOverCap = pickEmerging(SIGNALS_FIXTURE);
  assert.notEqual(noOverCap.artistName, 'Artist A');
  assert.notEqual(noOverCap.artistName, 'Artist C');
  assert.notEqual(noOverCap.artistName, 'Artist E');
});

test('pickEmerging returns null when no one qualifies', () => {
  const allOverCap = SIGNALS_FIXTURE.filter(
    (r) => r.viewsNow != null && r.viewsNow > _EMERGING_BASE_CAP
  );
  assert.equal(pickEmerging(allOverCap), null);
  assert.equal(pickEmerging([]), null);
});

test('pickEmerging skips zero-base junk', () => {
  const junk = [
    { artistName: 'Zero', viewGrowth7d: 100, pctGrowth7d: 999, viewsNow: 0 },
    ...SIGNALS_FIXTURE,
  ];
  const e = pickEmerging(junk);
  assert.notEqual(e.artistName, 'Zero');
});

// ─── HMAC unsubscribe-token round-trip ─────────────────────────────────

test('signUnsubToken is deterministic for the same userId', () => {
  const a = signUnsubToken('00000000-0000-0000-0000-000000000001');
  const b = signUnsubToken('00000000-0000-0000-0000-000000000001');
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url
  assert.ok(a.length >= 16);
});

test('signUnsubToken differs per userId', () => {
  const a = signUnsubToken('00000000-0000-0000-0000-000000000001');
  const b = signUnsubToken('00000000-0000-0000-0000-000000000002');
  assert.notEqual(a, b);
});

test('verifyUnsubToken accepts the signed token and rejects others', () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const goodToken = signUnsubToken(userId);
  const badToken = signUnsubToken('00000000-0000-0000-0000-000000000002');
  assert.equal(verifyUnsubToken(userId, goodToken), true);
  assert.equal(verifyUnsubToken(userId, badToken), false);
  assert.equal(verifyUnsubToken(userId, ''), false);
  assert.equal(verifyUnsubToken('', goodToken), false);
  assert.equal(verifyUnsubToken(userId, 'not-a-real-token-at-all'), false);
});

test('signUnsubToken throws on missing userId', () => {
  assert.throws(() => signUnsubToken(''));
  assert.throws(() => signUnsubToken(null));
  assert.throws(() => signUnsubToken(undefined));
});

// ─── buildDigestPayload ────────────────────────────────────────────────

test('buildDigestPayload returns null when no movers and no emerging', () => {
  const p = buildDigestPayload({
    appBaseUrl: 'http://localhost:8787',
    signals: [],
    user: { id: 'u', email: 'e@x.com' },
    unsubToken: 'tk',
  });
  assert.equal(p, null);
});

test('buildDigestPayload includes top-N + emerging + unsub link', () => {
  const p = buildDigestPayload({
    appBaseUrl: 'http://localhost:8787',
    signals: SIGNALS_FIXTURE,
    user: { id: '00000000-0000-0000-0000-000000000001', email: 'e@x.com' },
    unsubToken: 'TKN',
  });
  assert.ok(p);
  assert.ok(p.subject.includes('Top movers'));
  assert.match(p.text, /Artist C/); // top mover
  assert.match(p.text, /Artist B/); // emerging
  assert.match(p.text, /emerging artist we noticed/);
  assert.match(p.text, /\/api\/digest\/unsubscribe\?u=/);
  assert.match(p.text, /TKN/);
  assert.equal(p.meta.moverCount, 5);
  assert.equal(p.meta.hasEmerging, true);
});

test('buildDigestPayload omits emerging line when nothing qualifies', () => {
  const onlyBigArtists = SIGNALS_FIXTURE.filter(
    (r) => r.viewsNow != null && r.viewsNow >= _EMERGING_BASE_CAP
  );
  const p = buildDigestPayload({
    appBaseUrl: 'http://localhost:8787',
    signals: onlyBigArtists,
    user: { id: 'u', email: 'e@x.com' },
    unsubToken: 'tk',
  });
  assert.ok(p);
  assert.equal(p.meta.hasEmerging, false);
  assert.doesNotMatch(p.text, /emerging artist we noticed/);
});
