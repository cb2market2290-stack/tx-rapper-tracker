// src/auth/passwordReset.js
// Password-reset token lifecycle.
//
// Threat model:
//   1. DB dump: we store sha256(token) only, never the raw token. A dump
//      gives you hashes, which you can't use to reset anyone's password.
//   2. Stolen email / forwarded link: single-use (used_at set on consume),
//      short TTL (30 min default), invalidated on password change elsewhere.
//   3. Enumeration: the route layer always returns 202 regardless of whether
//      the email exists. This module doesn't leak that information either —
//      createToken() returns null silently when the user doesn't exist.
//   4. Race conditions: consumeToken() uses a conditional UPDATE so that if
//      two requests hit at the same time only one wins. The loser sees the
//      token as already used.
//
// Not yet implemented (follow-ups): per-user rate limiting of new tokens
// (currently only per-IP via the route-layer rate limiter), and cleanup of
// expired rows via a scheduled job.

import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db/pool.js';

const TOKEN_BYTES = 32; // 256 bits of entropy

/** Cryptographically random token, base64url-encoded. */
export function generateResetToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** sha256 of the token, hex-encoded. Matches the column type (TEXT). */
export function hashResetToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a reset token for the user with this email. Returns:
 *   { raw, tokenId, userId, expiresAt }  on success
 *   null                                  when the email doesn't resolve to a user
 * Either way we audit at the route level; this function stays quiet so the
 * caller can't accidentally leak existence into a timing channel or log line.
 *
 * Note: we do NOT invalidate prior unused tokens here — if the user requested
 * two resets in the same window they can consume either. consumeToken() is
 * strict (single-use) so this doesn't expand the attack surface, and it lets
 * a user who lost the first email still complete the flow from the second.
 */
export async function createResetToken({ email, ttlSeconds, ip, userAgent }) {
  const u = await query(
    'SELECT id FROM users WHERE email = $1 AND is_disabled = FALSE',
    [email]
  );
  if (u.rows.length === 0) return null;
  const userId = u.rows[0].id;

  const raw = generateResetToken();
  const tokenHash = hashResetToken(raw);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const { rows } = await query(
    `INSERT INTO password_reset_tokens
       (user_id, token_hash, expires_at, requested_ip, requested_user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, expires_at`,
    [userId, tokenHash, expiresAt, ip ?? null, userAgent ?? null]
  );
  return {
    raw,
    tokenId: rows[0].id,
    userId,
    expiresAt: rows[0].expires_at,
  };
}

/**
 * Look up a token without consuming it. Used when the user clicks the link —
 * we want to check validity before asking them for a new password, so the
 * UI can show "this link has expired" up front instead of after form submit.
 * Returns { tokenId, userId, email } on a live token, null otherwise.
 */
export async function peekResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashResetToken(rawToken);
  const { rows } = await query(
    `SELECT t.id AS token_id, t.user_id, u.email
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.used_at IS NULL
        AND t.expires_at > now()
        AND u.is_disabled = FALSE`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  return {
    tokenId: rows[0].token_id,
    userId: rows[0].user_id,
    email: rows[0].email,
  };
}

/**
 * Atomically consume a reset token. Returns { userId, email } on success,
 * null if the token is unknown / expired / already used / user disabled.
 *
 * The UPDATE is conditional so two concurrent calls can't both succeed —
 * only the first flips used_at from NULL to now(); the second matches zero
 * rows and we fall through to null.
 */
export async function consumeResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashResetToken(rawToken);

  const { rows } = await query(
    `UPDATE password_reset_tokens
        SET used_at = now()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id`,
    [tokenHash]
  );
  if (rows.length === 0) return null;

  // Re-resolve the user to confirm they're still active and to get their
  // email for the audit log / response body.
  const u = await query(
    'SELECT id, email FROM users WHERE id = $1 AND is_disabled = FALSE',
    [rows[0].user_id]
  );
  if (u.rows.length === 0) return null;

  return { userId: u.rows[0].id, email: u.rows[0].email };
}
