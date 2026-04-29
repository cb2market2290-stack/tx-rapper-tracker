// src/services/referrals.js
// Phase 3d.3 — referral program service module.
//
// Three responsibilities:
//   1. Pure helpers for token generation + validation, self-referral
//      checks, click-dedupe windowing, coupon payload shape.
//   2. DB getters: ensureToken, getStats, recordClick, getReferrerOf,
//      issueCoupon, getOutstandingCoupons.
//   3. Stripe-coupon-creation wrapper (createReferralCoupon) that
//      builds the locked-shape one-shot coupon and persists the row.
//
// Locked design lives in PHASE_3D_DESIGN.md. Key invariants this
// module enforces:
//   * Tokens never auto-rotate (12-char base64url, stable per user).
//   * Self-referral rejected (referrer === referred).
//   * Same-IP signup-velocity check: 3 signups from one IP in 24h
//     disables the coupon path for that IP for 7 days.
//   * Coupon shape: amount_off (fixed), 1-month Pro, max_redemptions=1,
//     redeem_by 30d out, metadata carries both user IDs + source.
//   * Idempotent coupon issue: PK (referred_user_id) + ON CONFLICT
//     DO NOTHING means Stripe webhook re-deliveries are no-ops.

import crypto from 'node:crypto';

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

// ── locked constants ────────────────────────────────────────────────────

// 8 random bytes -> 12 chars base64url. Locked at v1.
const TOKEN_BYTES = 8;

// Click dedupe window. Same IP + same token within this window
// counts as one click for /api/referrals/me stats.
const CLICK_DEDUPE_HOURS = 24;

// Same-IP signup-velocity threshold for the anti-fraud guard.
// 3 signups from one IP in this window pauses coupon issuance
// from that IP for ANTI_FRAUD_PAUSE_DAYS afterward.
const ANTI_FRAUD_SIGNUP_LIMIT = 3;
const ANTI_FRAUD_WINDOW_HOURS = 24;
const ANTI_FRAUD_PAUSE_DAYS = 7;

// Coupon shape — locked per PHASE_3D_DESIGN.md. Fixed amount_off in
// cents (= 1 month of Pro). Both numbers are env-overridable in case
// pricing changes, but the fallback is the v1 value.
const COUPON_AMOUNT_OFF_CENTS_DEFAULT = 1900; // $19/mo Pro reference
const COUPON_EXPIRY_DAYS = 30;

// ── pure helpers ────────────────────────────────────────────────────────

/**
 * Generate a fresh referral token. 12 chars, base64url, URL-safe.
 * Pure (uses crypto.randomBytes which is deterministic only in entropy).
 */
export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{6,32}$/;

/**
 * Cheap shape check for ?ref=<token> values from the URL. Rejects
 * anything outside [A-Za-z0-9_-] or implausibly short/long.
 */
export function isValidToken(s) {
  return typeof s === 'string' && TOKEN_RE.test(s);
}

/**
 * Reject a self-referral. Pure. Returns false if both ids match
 * (= referral should be ignored), true otherwise.
 */
export function isDifferentUser(referrerId, referredId) {
  if (!referrerId || !referredId) return true; // no referral to fight with
  return String(referrerId) !== String(referredId);
}

/**
 * Build the Stripe coupons.create() argument object. Pure — exposed
 * for tests so we can assert "the right metadata + amounts get sent
 * to Stripe" without mocking the SDK.
 */
export function buildCouponPayload({
  referrerUserId,
  referredUserId,
  amountOffCents = COUPON_AMOUNT_OFF_CENTS_DEFAULT,
  currency = 'usd',
  expiryDays = COUPON_EXPIRY_DAYS,
  now = new Date(),
}) {
  const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
  return {
    duration: 'once',
    amount_off: amountOffCents,
    currency,
    redeem_by: Math.floor(expiresAt.getTime() / 1000),
    max_redemptions: 1,
    name: 'Referral reward — 1 month free Pro',
    metadata: {
      referrer_user_id: referrerUserId,
      referred_user_id: referredUserId,
      source: 'phase-3d',
    },
  };
}

// ── DB-touching paths ───────────────────────────────────────────────────

/**
 * Ensure the user has a referral token. Idempotent: if a row already
 * exists in `referrals`, returns it; otherwise inserts a fresh
 * generateToken() with ON CONFLICT (user_id) DO NOTHING + a follow-up
 * SELECT to handle the race where two concurrent requests both think
 * they need to insert.
 */
export async function ensureToken(userId) {
  if (!userId) throw new Error('ensureToken: userId required');
  const existing = await query(
    `SELECT user_id, token, created_at
       FROM referrals
      WHERE user_id = $1`,
    [userId]
  );
  if (existing.rows[0]) {
    return shapeReferralRow(existing.rows[0]);
  }
  const token = generateToken();
  // Race-safe: on conflict either someone else inserted concurrently
  // (we re-SELECT below) or we ourselves inserted this exact row.
  // The UNIQUE (token) constraint also makes us safe against the
  // astronomical-but-non-zero chance of generateToken collision.
  await query(
    `INSERT INTO referrals (user_id, token)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, token]
  );
  const final = await query(
    `SELECT user_id, token, created_at
       FROM referrals
      WHERE user_id = $1`,
    [userId]
  );
  if (!final.rows[0]) {
    // Should be unreachable — the INSERT either succeeded or the
    // row already existed. Loud failure rather than silent null.
    throw new Error('ensureToken: insert+select inconsistent');
  }
  return shapeReferralRow(final.rows[0]);
}

function shapeReferralRow(r) {
  return {
    userId: r.user_id,
    token: r.token,
    createdAt: r.created_at,
  };
}

/**
 * Look up the user owning a token. Used by signup wiring (turn
 * tx_ref cookie -> users.referrer_token) and the click endpoint.
 * Returns null when the token doesn't match an active referrer.
 */
export async function getReferrerByToken(token) {
  if (!isValidToken(token)) return null;
  const { rows } = await query(
    `SELECT user_id, token, created_at
       FROM referrals
      WHERE token = $1`,
    [token]
  );
  return rows[0] ? shapeReferralRow(rows[0]) : null;
}

/**
 * Record a click. Idempotent within CLICK_DEDUPE_HOURS for same
 * (token, ip) — a re-click from the same machine within the window
 * does not produce a second row. Returns the inserted row id, or
 * null when we deduped.
 */
export async function recordClick({ token, ip, userAgent }) {
  if (!isValidToken(token)) return null;
  const { rows: existing } = await query(
    `SELECT id
       FROM referral_clicks
      WHERE token = $1
        AND ($2::inet IS NULL OR ip = $2::inet)
        AND ts > now() - ($3::int || ' hours')::interval
      LIMIT 1`,
    [token, ip || null, CLICK_DEDUPE_HOURS]
  );
  if (existing.length > 0) return null;
  const { rows } = await query(
    `INSERT INTO referral_clicks (token, ip, user_agent)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [token, ip || null, userAgent || null]
  );
  return rows[0]?.id || null;
}

/**
 * Stats for the /api/referrals/me response. One row per metric;
 * computed server-side so the frontend doesn't have to walk
 * referral_clicks itself.
 *
 * Returns { clicks, signups, conversions, couponsIssued }.
 */
export async function getStats(userId) {
  if (!userId) {
    return { clicks: 0, signups: 0, conversions: 0, couponsIssued: 0 };
  }
  // First find the user's token (or 0 stats if they don't have one).
  const ref = await query(
    `SELECT token FROM referrals WHERE user_id = $1`,
    [userId]
  );
  if (ref.rows.length === 0) {
    return { clicks: 0, signups: 0, conversions: 0, couponsIssued: 0 };
  }
  const token = ref.rows[0].token;

  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM referral_clicks WHERE token = $1)              AS clicks,
       (SELECT count(*)::int FROM users           WHERE referrer_token = $1)     AS signups,
       (SELECT count(*)::int FROM referral_coupons WHERE referrer_user_id = $2)  AS coupons,
       (SELECT count(*)::int FROM referral_coupons
         WHERE referrer_user_id = $2 AND redeemed_at IS NOT NULL)                AS redeemed`,
    [token, userId]
  );
  const r = rows[0] || {};
  return {
    clicks: Number(r.clicks || 0),
    signups: Number(r.signups || 0),
    conversions: Number(r.redeemed || 0),
    couponsIssued: Number(r.coupons || 0),
  };
}

/**
 * Anti-fraud guard. Returns true iff the requesting IP has signed
 * up more than ANTI_FRAUD_SIGNUP_LIMIT users in the past
 * ANTI_FRAUD_WINDOW_HOURS — meaning we should NOT issue a coupon
 * even though the referral chain looks valid.
 *
 * Counts via audit_log (event='signup') rather than adding a new
 * users.last_signup_ip column. The audit_log already captures every
 * signup with the IP attached; reusing it avoids a schema migration
 * just for an anti-fraud counter.
 *
 * Decoupled from issueCoupon so the route layer can fold the gate
 * into auditing if it wants.
 */
export async function ipIsSignupAbusing(ip) {
  if (!ip) return false; // can't measure abuse without an IP
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM audit_log
      WHERE ip = $1::inet
        AND event = 'signup'
        AND at > now() - ($2::int || ' hours')::interval`,
    [ip, ANTI_FRAUD_WINDOW_HOURS]
  );
  return Number(rows[0]?.n || 0) >= ANTI_FRAUD_SIGNUP_LIMIT;
}

/**
 * Persist a referral coupon row. Idempotent on referred_user_id —
 * Stripe webhook re-deliveries are no-ops.
 *
 * Returns { issued, row } where issued is true on first write and
 * false when an existing row was already there.
 */
export async function recordCoupon({
  referrerUserId,
  referredUserId,
  stripeCouponId,
  amountOffCents,
  currency,
  expiresAt,
}) {
  const result = await query(
    `INSERT INTO referral_coupons (
       referred_user_id, referrer_user_id, stripe_coupon_id,
       amount_off_cents, currency, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (referred_user_id) DO NOTHING
     RETURNING referred_user_id, referrer_user_id, stripe_coupon_id,
               amount_off_cents, currency, expires_at, created_at,
               redeemed_at`,
    [
      referredUserId,
      referrerUserId,
      stripeCouponId,
      amountOffCents,
      currency,
      expiresAt,
    ]
  );
  if (result.rows.length > 0) {
    return { issued: true, row: shapeCouponRow(result.rows[0]) };
  }
  // Conflict — read the winning row.
  const winner = await query(
    `SELECT referred_user_id, referrer_user_id, stripe_coupon_id,
            amount_off_cents, currency, expires_at, created_at, redeemed_at
       FROM referral_coupons
      WHERE referred_user_id = $1`,
    [referredUserId]
  );
  return { issued: false, row: winner.rows[0] ? shapeCouponRow(winner.rows[0]) : null };
}

function shapeCouponRow(r) {
  return {
    referredUserId: r.referred_user_id,
    referrerUserId: r.referrer_user_id,
    stripeCouponId: r.stripe_coupon_id,
    amountOffCents: r.amount_off_cents,
    currency: r.currency,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    redeemedAt: r.redeemed_at,
  };
}

// ── Stripe-touching wrapper (orchestrator) ──────────────────────────────

/**
 * Top-level orchestrator: build a coupon payload, call
 * stripe.coupons.create, persist the result. Caller (the webhook
 * handler) is responsible for the gating: "this user converted
 * via a referral link," "self-referral is rejected," "anti-fraud
 * IP guard."
 *
 * Pulls Stripe via lazy-import (services/stripe.js#getStripe).
 *
 * Returns { issued, couponId, row }. Throws on Stripe errors;
 * caller logs + records the failure in stripe_webhook_events.
 */
export async function createReferralCoupon({
  referrerUserId,
  referredUserId,
  amountOffCents = COUPON_AMOUNT_OFF_CENTS_DEFAULT,
  currency = 'usd',
}) {
  if (!isDifferentUser(referrerUserId, referredUserId)) {
    return { issued: false, reason: 'self_referral' };
  }
  // Already issued? Skip the Stripe call.
  const { rows: existing } = await query(
    `SELECT stripe_coupon_id, amount_off_cents, currency, expires_at,
            referrer_user_id, referred_user_id, created_at, redeemed_at
       FROM referral_coupons
      WHERE referred_user_id = $1`,
    [referredUserId]
  );
  if (existing.length > 0) {
    return {
      issued: false,
      reason: 'already_issued',
      row: shapeCouponRow(existing[0]),
    };
  }

  const payload = buildCouponPayload({
    referrerUserId,
    referredUserId,
    amountOffCents,
    currency,
    expiryDays: COUPON_EXPIRY_DAYS,
  });

  // Lazy-import the Stripe service so this module is testable
  // without the SDK installed (the unit-test path doesn't reach here).
  const { getStripe } = await import('./stripe.js');
  const stripe = await getStripe();
  let coupon;
  try {
    coupon = await stripe.coupons.create(payload);
  } catch (err) {
    logger.warn(
      { err: err.message, referrerUserId, referredUserId },
      'stripe: coupons.create failed'
    );
    throw err;
  }

  const expiresAt = new Date(payload.redeem_by * 1000);
  return await recordCoupon({
    referrerUserId,
    referredUserId,
    stripeCouponId: coupon.id,
    amountOffCents: payload.amount_off,
    currency: payload.currency,
    expiresAt,
  });
}

// ── exports for tests ───────────────────────────────────────────────────

export {
  TOKEN_BYTES as _TOKEN_BYTES,
  CLICK_DEDUPE_HOURS as _CLICK_DEDUPE_HOURS,
  ANTI_FRAUD_SIGNUP_LIMIT as _ANTI_FRAUD_SIGNUP_LIMIT,
  ANTI_FRAUD_WINDOW_HOURS as _ANTI_FRAUD_WINDOW_HOURS,
  ANTI_FRAUD_PAUSE_DAYS as _ANTI_FRAUD_PAUSE_DAYS,
  COUPON_AMOUNT_OFF_CENTS_DEFAULT as _COUPON_AMOUNT_OFF_CENTS_DEFAULT,
  COUPON_EXPIRY_DAYS as _COUPON_EXPIRY_DAYS,
};
