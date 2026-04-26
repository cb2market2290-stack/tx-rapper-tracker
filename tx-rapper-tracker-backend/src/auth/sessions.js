// src/auth/sessions.js
// Session token lifecycle.
//
// Threat model for sessions:
//   1. DB dump: we never store the raw token — only sha256(token). Dumping
//      the DB gives you hashes, not live sessions.
//   2. Cookie theft via XSS: mitigated upstream (Helmet CSP, httpOnly cookie).
//   3. Cookie theft via physical access / tab share: the cookie is signed
//      with SESSION_SECRET. Tampering breaks the signature.
//   4. Session fixation: we issue a fresh token on every login — never reuse.
//
// The raw token NEVER touches the DB or the logs. We log the session id
// (UUID) only, which is useless to an attacker on its own.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import cookieSignature from 'cookie-signature';
import { config } from '../config.js';
import { query } from '../db/pool.js';

const TOKEN_BYTES = 32; // 256 bits of entropy
const COOKIE_OPTS_BASE = Object.freeze({
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
});

// Pre-2FA sessions are short-lived intent tokens — they exist only to prove
// "you got past password" so the /2fa/verify call has something to bind to.
// 5 minutes is plenty for a user to fish out their phone; longer just widens
// the window where a stolen pre-cookie + leaked TOTP could be replayed.
export const PRE_2FA_TTL_SECONDS = 5 * 60;

/** Cryptographically random token, base64url-encoded. */
export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** sha256 of the token, hex-encoded. Stored in sessions.token_hash. */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new session row. Returns { raw, sessionId, expiresAt }.
 * `raw` is what goes in the signed cookie. Never log it.
 *
 * `stage`: omit/null for a normal full session, 'pre_2fa' for the
 * password-verified-but-second-factor-pending step. Pre-2FA sessions are
 * created with a much shorter TTL so a leaked pre-cookie can't outlive
 * the user's "get the code" flow.
 */
export async function createSession({ userId, ip, userAgent, stage = null }) {
  const raw = generateToken();
  const tokenHash = hashToken(raw);
  const ttlSeconds = stage === 'pre_2fa' ? PRE_2FA_TTL_SECONDS : config.session.ttlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const { rows } = await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, stage)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, expires_at`,
    [userId, tokenHash, expiresAt, ip ?? null, userAgent ?? null, stage]
  );
  return { raw, sessionId: rows[0].id, expiresAt: rows[0].expires_at, stage };
}

/**
 * Look up an active session by raw token. Returns the joined user row or null.
 * "Active" means: not expired, not revoked, user not disabled, AND fully
 * authenticated (stage IS NULL — a pre_2fa session is not an active session).
 * Also bumps last_seen_at on hit (best-effort, non-blocking semantics).
 */
export async function findActiveSession(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashToken(rawToken);
  const { rows } = await query(
    `SELECT s.id         AS session_id,
            s.expires_at AS session_expires_at,
            u.id         AS user_id,
            u.email,
            u.display_name,
            u.is_disabled
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND s.stage IS NULL`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.is_disabled) return null;

  // Bump last_seen_at in the background — don't make the caller wait.
  query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [
    row.session_id,
  ]).catch(() => {});

  return {
    sessionId: row.session_id,
    expiresAt: row.session_expires_at,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
    },
  };
}

/**
 * Look up a pre_2fa session by raw token. Returns the session+user or null.
 * Used by POST /api/auth/2fa/verify, which is the *only* legitimate caller
 * for a pre_2fa cookie — every other endpoint should treat it as no session.
 */
export async function findPreSession(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = hashToken(rawToken);
  const { rows } = await query(
    `SELECT s.id         AS session_id,
            s.expires_at AS session_expires_at,
            s.stage      AS stage,
            u.id         AS user_id,
            u.email,
            u.display_name,
            u.is_disabled
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.stage = 'pre_2fa'
       AND s.revoked_at IS NULL
       AND s.expires_at > now()`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.is_disabled) return null;
  return {
    sessionId: row.session_id,
    expiresAt: row.session_expires_at,
    stage: row.stage,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
    },
  };
}

/**
 * Promote a pre_2fa session to a full session: stage -> NULL, expiry bumped
 * to the full session TTL. Returns the new expiresAt or null if the session
 * row was already gone/revoked.
 */
export async function promoteSessionToFull(sessionId) {
  const newExpiry = new Date(Date.now() + config.session.ttlSeconds * 1000);
  const { rows } = await query(
    `UPDATE sessions
       SET stage = NULL,
           expires_at = $2,
           last_seen_at = now()
     WHERE id = $1
       AND stage = 'pre_2fa'
       AND revoked_at IS NULL
     RETURNING expires_at`,
    [sessionId, newExpiry]
  );
  return rows[0]?.expires_at ?? null;
}

/** Soft-delete a session (sets revoked_at). Safe to call on an unknown token. */
export async function revokeSession(rawToken) {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash]
  );
}

/** Revoke every session a user owns. Use after password change or admin lockout. */
export async function revokeAllForUser(userId) {
  await query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
}

// ---- Cookie helpers ------------------------------------------------------
//
// We use `cookie-signature` (Express's own dep) for HMAC-SHA256 signing.
// Format: `s:<raw>.<signature>`. If an attacker tampers with raw, the
// signature fails and we treat the cookie as absent.

/** Sign a raw token for storage in the cookie. */
export function signCookieValue(raw) {
  return 's:' + cookieSignature.sign(raw, config.session.secret);
}

/** Reverse of signCookieValue. Returns the raw token or null on tamper/format error. */
export function unsignCookieValue(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  if (!cookieValue.startsWith('s:')) return null;
  const unsigned = cookieSignature.unsign(cookieValue.slice(2), config.session.secret);
  return unsigned === false ? null : unsigned;
}

/** Full cookie options for res.cookie(). */
export function cookieOptions({ expires } = {}) {
  return {
    ...COOKIE_OPTS_BASE,
    secure: config.session.cookieSecure,
    domain: config.session.cookieDomain,
    expires,
  };
}

/** Constant-time equality — used by tests, kept exported for callers that need it. */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
