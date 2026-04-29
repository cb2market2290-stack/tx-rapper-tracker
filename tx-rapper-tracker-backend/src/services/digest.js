// src/services/digest.js
// Phase 3d.2 — weekly digest email service.
//
// Responsibilities:
//   1. Pure helpers for cadence (isDigestHourFor) + payload assembly
//      (buildDigestPayload, formatDigestText) + HMAC unsubscribe-token
//      round-trip (signUnsubToken / verifyUnsubToken).
//   2. DB-touching path: getUsersDueForDigest, recordDigestSent.
//   3. Send-side helper: sendDigestForUser (composes payload, calls
//      mailer, records the breadcrumb).
//
// The cadence + opt-in mechanics are LOCKED in PHASE_3D_DESIGN.md.
// Bumping the schedule (e.g. switching to twice-weekly) requires a
// design pass, not a silent code edit — users have an expectation
// that "weekly Monday morning" is what they signed up for.

import crypto from 'node:crypto';

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { mailer } from '../lib/mailer.js';
import { logger } from '../lib/logger.js';
import { getTopMovers } from './breakout.js';

// ── locked constants ────────────────────────────────────────────────────

// Send-time window in the user's local timezone. We only send between
// 09:00 and 09:59 local — sending at 04:00 UTC means a 23:00 the
// previous day delivery for half the West Coast, which lands in
// "promotional" folders.
export const DIGEST_HOUR_LOCAL = 9;

// Max age for "this Monday's send" — 6 days. If digest_last_sent_at
// is older than 6 days, we're due for the next Monday's send.
const RESEND_AFTER_DAYS = 6;

// Default timezone for users with no TZ set. Roster is Texas-based;
// most users are statistically on this clock too.
export const DEFAULT_TZ = 'America/Chicago';

// Move count for the "top movers" section. 5 is the magic number that
// fits in a glance + leaves room for the 1 emerging-artist line below.
const TOP_N = 5;

// Threshold for "emerging artist": highest pct growth from a base
// under this many lifetime views. Tuned so we surface real risers
// (Megan-class artists with 30M+ views aren't "emerging" even with
// fast growth).
const EMERGING_BASE_CAP = 5_000_000;

// ── pure helpers ────────────────────────────────────────────────────────

/**
 * True iff `now` is between DIGEST_HOUR_LOCAL:00 and :59 in the user's
 * local timezone. Pure — no clock reads, no I/O.
 *
 * @param {{tz?: string|null}} user
 * @param {Date} now
 */
export function isDigestHourFor(user, now) {
  const tz = (user && user.tz) || DEFAULT_TZ;
  // Intl.DateTimeFormat with hour cycle h23 gives us 0-23 across all
  // platforms; we only need the hour digit.
  let hour;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      }).format(now)
    );
  } catch (_) {
    // Bad TZ string from the DB — fall back to default rather than
    // failing the cron pass for one bad row.
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: DEFAULT_TZ,
        hour: 'numeric',
        hour12: false,
      }).format(now)
    );
  }
  return hour === DIGEST_HOUR_LOCAL;
}

/**
 * True iff this user is due for a fresh digest send (= more than
 * RESEND_AFTER_DAYS since the last one, or never sent).
 */
export function isDueForResend(user, now) {
  if (!user || !user.digestLastSentAt) return true;
  const last = new Date(user.digestLastSentAt);
  if (!Number.isFinite(last.getTime())) return true;
  const ageDays = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays >= RESEND_AFTER_DAYS;
}

/**
 * Convert a list of breakout_signals rows into the digest's "top
 * movers" section. Returns up to TOP_N entries sorted by view_growth_7d
 * desc. Pure.
 *
 * Input rows shape: { artistName, viewGrowth7d, pctGrowth7d, viewsNow, ... }
 */
export function pickTopMovers(rows, n = TOP_N) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return [...rows]
    .filter((r) => r && r.viewGrowth7d != null)
    .sort((a, b) => Number(b.viewGrowth7d) - Number(a.viewGrowth7d))
    .slice(0, n);
}

/**
 * Pick the "emerging artist" — highest pct_growth_7d from a base
 * under EMERGING_BASE_CAP. Pure. Returns null when no one qualifies.
 */
export function pickEmerging(rows, baseCapViews = EMERGING_BASE_CAP) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const candidates = rows.filter(
    (r) =>
      r &&
      r.pctGrowth7d != null &&
      Number(r.pctGrowth7d) > 0 &&
      r.viewsNow != null &&
      Number(r.viewsNow) < baseCapViews &&
      Number(r.viewsNow) > 0 // skip 0-base junk
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) =>
    Number(r.pctGrowth7d) > Number(best.pctGrowth7d) ? r : best
  );
}

// ── format helpers ──────────────────────────────────────────────────────

function fmtCompactInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const x = Math.abs(Number(n));
  const sign = Number(n) < 0 ? '-' : '';
  if (x >= 1_000_000) return sign + (x / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (x >= 1_000)     return sign + (x / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return sign + Math.round(x).toString();
}

function fmtPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  return (Number(p) * 100).toFixed(1) + '%';
}

function fmtSignedDelta(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return (Number(n) >= 0 ? '+' : '-') + fmtCompactInt(Math.abs(Number(n))).replace(/^-/, '');
}

// ── HMAC unsubscribe tokens ─────────────────────────────────────────────

/**
 * Build a stable unsubscribe token for a user. HMAC-SHA256 of
 * userId with config.session.secret, base64url-encoded. Stable so
 * the same user always produces the same token (we lazy-set
 * digest_unsub_token on first send and reuse forever).
 *
 * @param {string} userId
 */
export function signUnsubToken(userId) {
  if (!userId) throw new Error('signUnsubToken: userId required');
  const h = crypto.createHmac('sha256', config.session.secret);
  h.update(`digest:${userId}`);
  // 16 bytes is plenty; full 32-byte HMAC would be overkill in URL.
  return h.digest().slice(0, 16).toString('base64url');
}

/**
 * Constant-time verify: does this token match what we'd sign for
 * userId? Returns boolean. Constant-time so a timing attack can't
 * leak which user IDs are real.
 */
export function verifyUnsubToken(userId, candidate) {
  if (!userId || !candidate) return false;
  try {
    const expected = signUnsubToken(userId);
    if (expected.length !== candidate.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(candidate, 'utf8')
    );
  } catch (_) {
    return false;
  }
}

// ── payload assembly ────────────────────────────────────────────────────

/**
 * Build the digest payload object. Pure — takes already-fetched
 * breakout signals + user context, returns { subject, text, meta }.
 *
 * Returns null when there's nothing meaningful to send (zero
 * movers + no emerging artist) — caller should skip the send rather
 * than ship a near-empty email.
 *
 * @param {Object} args
 * @param {string} args.appBaseUrl     — e.g. "https://tx-rapper-tracker.com"
 * @param {Array}  args.signals        — breakout_signals rows
 * @param {Object} args.user           — { id, email }
 * @param {string} args.unsubToken     — pre-signed token for this user
 * @param {Object} [args.dateRange]    — { start, end } as Date or string;
 *                                        defaults to last 7 days from today
 */
export function buildDigestPayload({
  appBaseUrl,
  signals,
  user,
  unsubToken,
  dateRange,
}) {
  const movers = pickTopMovers(signals);
  const emerging = pickEmerging(signals);
  if (movers.length === 0 && !emerging) {
    return null;
  }

  const start =
    dateRange?.start ||
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end =
    dateRange?.end || new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push('Hey,');
  lines.push('');
  lines.push(
    `Here is what moved most among the artists you are tracking this past week (${start} - ${end}):`
  );
  lines.push('');
  movers.forEach((r, i) => {
    const rank = (i + 1).toString();
    const growth = fmtSignedDelta(r.viewGrowth7d) + ' views';
    const pct = fmtPct(r.pctGrowth7d) + ' growth';
    lines.push(`  ${rank}. ${r.artistName.padEnd(20)} ${growth.padEnd(14)} ${pct}`);
  });

  if (emerging) {
    lines.push('');
    lines.push(
      `One emerging artist we noticed: ${emerging.artistName}, ${fmtSignedDelta(
        emerging.viewGrowth7d
      )} views in 7 days from a smaller base — worth a watch.`
    );
  }

  lines.push('');
  lines.push(`See the full dashboard:   ${appBaseUrl}/`);
  lines.push(`Manage alerts:            ${appBaseUrl}/?alerts=1`);
  lines.push('');
  lines.push('— TX Rapper Tracker');
  lines.push('');
  lines.push(
    `You opted into this digest. Stop receiving these:`
  );
  lines.push(
    `  ${appBaseUrl}/api/digest/unsubscribe?u=${encodeURIComponent(
      user.id
    )}&t=${encodeURIComponent(unsubToken)}`
  );

  return {
    subject: `Top movers this week — ${movers.length} artist${movers.length === 1 ? '' : 's'} tracked`,
    text: lines.join('\n'),
    meta: {
      moverCount: movers.length,
      hasEmerging: !!emerging,
      dateRange: { start, end },
    },
  };
}

// ── DB-touching paths ───────────────────────────────────────────────────

/**
 * Pull users who are eligible for a digest send right now. Filters
 * on opted-in; the timezone gate is JS-side because Postgres doesn't
 * carry user TZ in v1 (collecting tz at signup is a follow-up).
 * Until then every user falls back to DEFAULT_TZ.
 *
 * Returns rows with: { id, email, tz, digestLastSentAt, digestUnsubToken }.
 * `tz` is included in the shape (always null for now) so the rest of
 * the pipeline doesn't have to special-case the future where we
 * collect it.
 */
export async function getUsersDueForDigest() {
  const { rows } = await query(
    `SELECT id,
            email,
            digest_last_sent_at,
            digest_unsub_token
       FROM users
      WHERE digest_opted_in = TRUE
        AND email IS NOT NULL
      ORDER BY digest_last_sent_at NULLS FIRST`
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    tz: null, // populated when users.tz column lands; default applied in isDigestHourFor
    digestLastSentAt: r.digest_last_sent_at,
    digestUnsubToken: r.digest_unsub_token,
  }));
}

/**
 * Persist the unsub token (lazy-set) + advance digest_last_sent_at.
 * Called inside the per-user transaction the cron uses to prevent
 * double-sending if it runs twice in the same hour.
 */
export async function recordDigestSent({ userId, unsubToken }) {
  await query(
    `UPDATE users
        SET digest_last_sent_at = now(),
            digest_unsub_token = COALESCE(digest_unsub_token, $2)
      WHERE id = $1`,
    [userId, unsubToken]
  );
}

// ── per-user send entry point ───────────────────────────────────────────

/**
 * Send a digest to a single user. Caller is responsible for the
 * cadence + opt-in gating; this just composes + sends.
 *
 * Returns { sent, reason } where reason is one of:
 *   'sent'        — happy path
 *   'no_content'  — buildDigestPayload returned null; nothing to send
 *   'mailer_err'  — mailer threw; logged but caller decides whether
 *                   to retry on the next cron pass
 */
export async function sendDigestForUser({ user, signals, appBaseUrl }) {
  const unsubToken = user.digestUnsubToken || signUnsubToken(user.id);
  const payload = buildDigestPayload({
    appBaseUrl,
    signals,
    user,
    unsubToken,
  });
  if (!payload) {
    return { sent: false, reason: 'no_content' };
  }
  try {
    await mailer.send({
      to: user.email,
      subject: payload.subject,
      text: payload.text,
    });
    await recordDigestSent({ userId: user.id, unsubToken });
    logger.info(
      { userId: user.id, ...payload.meta },
      'digest sent'
    );
    return { sent: true, reason: 'sent', payload };
  } catch (err) {
    logger.warn(
      { userId: user.id, err: err.message },
      'digest send failed'
    );
    return { sent: false, reason: 'mailer_err', error: err.message };
  }
}

// ── public re-exports for tests ─────────────────────────────────────────

export {
  TOP_N as _TOP_N,
  EMERGING_BASE_CAP as _EMERGING_BASE_CAP,
  RESEND_AFTER_DAYS as _RESEND_AFTER_DAYS,
};
