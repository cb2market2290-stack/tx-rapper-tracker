// test/referrals.test.js
// Phase 3d.3 — offline coverage for src/services/referrals.js pure
// surface. DB-touching paths (ensureToken, getReferrerByToken,
// recordClick, getStats, ipIsSignupAbusing, recordCoupon,
// createReferralCoupon) covered by manual verify; what we protect
// here is what's most likely to regress on a refactor.
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

const referrals = await import('../src/services/referrals.js');
const {
  generateToken,
  isValidToken,
  isDifferentUser,
  buildCouponPayload,
  _TOKEN_BYTES,
  _COUPON_AMOUNT_OFF_CENTS_DEFAULT,
  _COUPON_EXPIRY_DAYS,
} = referrals;

// ── generateToken ──────────────────────────────────────────────────────

test('generateToken returns a base64url string of expected length', () => {
  const t = generateToken();
  // 8 bytes -> base64url is 11-12 chars (no padding).
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.ok(t.length >= 10 && t.length <= 14);
});

test('generateToken is unique across N=1000 generations', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(generateToken());
  // At 64 bits of entropy, a 1000-trial collision is astronomically
  // unlikely. Any collision => the function is broken.
  assert.equal(seen.size, 1000);
});

// ── isValidToken ───────────────────────────────────────────────────────

test('isValidToken accepts well-formed tokens', () => {
  assert.equal(isValidToken('A1bC2dEfG_h-'),  true);
  assert.equal(isValidToken('aaaaaaaaaaaa'),   true);
  assert.equal(isValidToken('a'.repeat(32)),   true);
});

test('isValidToken rejects malformed input', () => {
  assert.equal(isValidToken(''),                  false);
  assert.equal(isValidToken(null),                false);
  assert.equal(isValidToken(undefined),           false);
  assert.equal(isValidToken('aa'),                false);  // too short
  assert.equal(isValidToken('a'.repeat(33)),      false);  // too long
  assert.equal(isValidToken('has space'),         false);
  assert.equal(isValidToken('drop;table'),        false);
  assert.equal(isValidToken('has=padding'),       false);  // = not in alphabet
});

// ── isDifferentUser ────────────────────────────────────────────────────

test('isDifferentUser rejects self-referral', () => {
  assert.equal(
    isDifferentUser(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001'
    ),
    false
  );
});

test('isDifferentUser allows real referrals', () => {
  assert.equal(
    isDifferentUser(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002'
    ),
    true
  );
});

test('isDifferentUser returns true (= no referral to fight with) when either id is missing', () => {
  assert.equal(isDifferentUser(null, '00000000-0000-0000-0000-000000000002'), true);
  assert.equal(isDifferentUser('00000000-0000-0000-0000-000000000001', null), true);
  assert.equal(isDifferentUser(null, null), true);
});

// ── buildCouponPayload ─────────────────────────────────────────────────

test('buildCouponPayload produces the locked Stripe coupon shape', () => {
  const now = new Date('2026-04-28T12:00:00Z');
  const p = buildCouponPayload({
    referrerUserId: '00000000-0000-0000-0000-000000000001',
    referredUserId: '00000000-0000-0000-0000-000000000002',
    now,
  });
  assert.equal(p.duration, 'once');
  assert.equal(p.amount_off, _COUPON_AMOUNT_OFF_CENTS_DEFAULT);
  assert.equal(p.currency, 'usd');
  assert.equal(p.max_redemptions, 1);
  assert.match(p.name, /Referral reward/i);
  // Metadata carries both user IDs + source for downstream reconciliation.
  assert.equal(
    p.metadata.referrer_user_id,
    '00000000-0000-0000-0000-000000000001'
  );
  assert.equal(
    p.metadata.referred_user_id,
    '00000000-0000-0000-0000-000000000002'
  );
  assert.equal(p.metadata.source, 'phase-3d');
});

test('buildCouponPayload sets redeem_by COUPON_EXPIRY_DAYS in the future (unix seconds)', () => {
  const now = new Date('2026-04-28T12:00:00Z');
  const p = buildCouponPayload({
    referrerUserId: 'a',
    referredUserId: 'b',
    now,
  });
  const expectedExpiryMs =
    now.getTime() + _COUPON_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const actualExpiryMs = p.redeem_by * 1000;
  // Allow a 2s slop in case of integer rounding.
  assert.ok(Math.abs(expectedExpiryMs - actualExpiryMs) <= 2000);
});

test('buildCouponPayload accepts amountOffCents + currency overrides', () => {
  const p = buildCouponPayload({
    referrerUserId: 'a',
    referredUserId: 'b',
    amountOffCents: 4900,
    currency: 'eur',
  });
  assert.equal(p.amount_off, 4900);
  assert.equal(p.currency, 'eur');
});

test('TOKEN_BYTES is locked at 8 (= 12-char base64url tokens)', () => {
  assert.equal(_TOKEN_BYTES, 8);
});
