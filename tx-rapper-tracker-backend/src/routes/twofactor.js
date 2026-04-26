// src/routes/twofactor.js
// Two-factor (TOTP) authentication endpoints.
//
//   POST /api/auth/2fa/enroll          — begin enrollment, returns secret + QR
//   POST /api/auth/2fa/enroll/verify   — confirm code, return recovery codes (once)
//   POST /api/auth/2fa/disable         — turn off 2FA (password + code required)
//   POST /api/auth/2fa/verify          — second step of login (pre_2fa → full)
//
// Auth requirements per route:
//   * /enroll, /enroll/verify, /disable  → requireUser() (full session)
//   * /verify                            → pre_2fa session cookie (no full session)
//
// Why /verify is its own auth path: a pre_2fa session is the ONLY thing
// that proves "this caller already passed the password step". We deliberately
// keep findActiveSession blind to it (so /api/auth/me can't be hit halfway
// through login), and call findPreSession here instead.

import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { verifyPassword } from '../auth/password.js';
import {
  generateTotpSecret,
  buildOtpAuthUrl,
  renderQrDataUrl,
  verifyCode,
  encryptSecret,
  decryptSecret,
} from '../auth/totp.js';
import {
  regenerateCodes,
  consumeCode,
  remainingCount,
  clearAll as clearAllRecoveryCodes,
} from '../auth/recovery.js';
import {
  findPreSession,
  promoteSessionToFull,
  signCookieValue,
  unsignCookieValue,
  cookieOptions,
} from '../auth/sessions.js';
import { requireUser } from '../middleware/authenticate.js';
import { HttpError } from '../middleware/errorHandler.js';

const router = Router();

// ---- Schemas + helpers ---------------------------------------------------

const VerifyBody = z
  .object({
    code: z.string().trim().min(1).max(16).optional(),
    recoveryCode: z.string().trim().min(1).max(64).optional(),
  })
  .refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), {
    message: 'provide exactly one of `code` or `recoveryCode`',
  });

const EnrollVerifyBody = z.object({
  code: z.string().trim().min(6).max(8),
});

const DisableBody = z.object({
  currentPassword: z.string().min(1).max(256),
  code: z.string().trim().min(6).max(8),
});

function parse(schema, input) {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(
      400,
      'bad_request',
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
  }
  return r.data;
}

async function audit({ req, userId, event, details }) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, event, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId ?? null,
        event,
        req.ip ?? null,
        req.get('user-agent') ?? null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    req.log?.warn({ err, event }, 'audit write failed');
  }
}

function setSessionCookie(res, rawToken, expiresAt) {
  res.cookie(
    config.session.cookieName,
    signCookieValue(rawToken),
    cookieOptions({ expires: expiresAt })
  );
}

function userToPublic(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name ?? u.displayName ?? null,
  };
}

// ---- Routes --------------------------------------------------------------

/**
 * POST /api/auth/2fa/enroll
 * Begin enrollment. Generates a fresh secret, stores it (encrypted) as an
 * unconfirmed row, returns the otpauth URL + QR code so the authenticator
 * app can scan it. The user MUST then call /enroll/verify with a code from
 * the app to complete enrollment.
 *
 * Idempotency: if there's an existing unconfirmed row, we replace it. If
 * there's a CONFIRMED row, we 409 — disable first, then re-enroll.
 */
router.post('/enroll', requireUser(), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const existing = await query(
      `SELECT confirmed_at FROM user_totp WHERE user_id = $1`,
      [userId]
    );
    if (existing.rows[0]?.confirmed_at) {
      throw new HttpError(
        409,
        '2fa_already_enrolled',
        '2FA is already enabled — disable it first to re-enroll'
      );
    }

    const secret = generateTotpSecret();
    const ciphertext = encryptSecret(secret);

    // ON CONFLICT keeps idempotency: re-hitting /enroll just replaces the
    // unconfirmed secret. confirmed_at and last_used_at are explicitly
    // reset to NULL so we never carry stale state across enrollment attempts.
    await query(
      `INSERT INTO user_totp (user_id, secret_encrypted, algorithm, digits, period_seconds, confirmed_at, last_used_at)
         VALUES ($1, $2, 'SHA1', 6, 30, NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
         secret_encrypted = EXCLUDED.secret_encrypted,
         algorithm = EXCLUDED.algorithm,
         digits = EXCLUDED.digits,
         period_seconds = EXCLUDED.period_seconds,
         confirmed_at = NULL,
         last_used_at = NULL,
         created_at = now()`,
      [userId, ciphertext]
    );

    const otpauthUrl = buildOtpAuthUrl(secret, req.user.email);
    const qrDataUrl = await renderQrDataUrl(otpauthUrl);

    await audit({ req, userId, event: '2fa_enroll_started' });

    res.json({
      kind: 'auth.2fa.enroll',
      // Plaintext secret returned ONCE so power users can paste it into a
      // password manager that auto-generates codes. Treat as sensitive —
      // the response is short-lived and over TLS.
      secret,
      otpauthUrl,
      qrDataUrl,
      issuer: config.totp.issuer,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/2fa/enroll/verify  { code }
 * Confirm enrollment by submitting a code from the authenticator app.
 * On success we mark confirmed_at, populate users.mfa_enrolled_at, and
 * return the freshly generated 10 recovery codes. The plaintext codes
 * are shown ONCE — there is no way to retrieve them later.
 */
router.post('/enroll/verify', requireUser(), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const body = parse(EnrollVerifyBody, req.body ?? {});

    const { rows } = await query(
      `SELECT secret_encrypted, confirmed_at FROM user_totp WHERE user_id = $1`,
      [userId]
    );
    const row = rows[0];
    if (!row) {
      throw new HttpError(400, '2fa_not_enrolling', 'no enrollment in progress; call /2fa/enroll first');
    }
    if (row.confirmed_at) {
      throw new HttpError(409, '2fa_already_enrolled', '2FA is already enabled');
    }

    let secret;
    try {
      secret = decryptSecret(row.secret_encrypted);
    } catch (err) {
      // If decrypt fails we likely lost the key — wipe so the user can re-enroll.
      req.log?.error({ err, userId }, '2fa decrypt failed during enroll/verify');
      await query(`DELETE FROM user_totp WHERE user_id = $1`, [userId]);
      throw new HttpError(500, '2fa_decrypt_failed', 'enrollment lost — please start over');
    }

    if (!verifyCode(secret, body.code)) {
      await audit({ req, userId, event: '2fa_enroll_verify_failed' });
      throw new HttpError(400, '2fa_bad_code', 'that code is incorrect or expired — try again');
    }

    // Confirm the row + populate mfa_enrolled_at + generate fresh recovery
    // codes. We do these as separate statements (not a single transaction)
    // because regenerateCodes wraps its own; the brief window where confirm
    // has happened but codes haven't is harmless — the codes path is purely
    // additive (without codes you just lose the recovery option).
    await query(
      `UPDATE user_totp
          SET confirmed_at = now(), last_used_at = now()
        WHERE user_id = $1`,
      [userId]
    );
    await query(
      `UPDATE users SET mfa_enrolled_at = now(), updated_at = now() WHERE id = $1`,
      [userId]
    );

    const recoveryCodes = await regenerateCodes(userId);

    await audit({ req, userId, event: '2fa_enrolled' });

    res.json({
      kind: 'auth.2fa.enroll.verify',
      ok: true,
      // Surfaced ONCE — UI must instruct the user to save them. Lost = lost.
      recoveryCodes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/2fa/disable  { currentPassword, code }
 * Turn off 2FA. Both password and a current TOTP code are required so a
 * stolen full-session cookie alone can't disable the second factor.
 */
router.post('/disable', requireUser(), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const body = parse(DisableBody, req.body ?? {});

    const { rows } = await query(
      `SELECT u.password_hash, t.secret_encrypted, t.confirmed_at
         FROM users u
         LEFT JOIN user_totp t ON t.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    );
    const row = rows[0];
    if (!row) throw new HttpError(401, 'unauthenticated', 'sign in required');

    if (!row.confirmed_at) {
      throw new HttpError(400, '2fa_not_enrolled', '2FA is not enabled on this account');
    }

    const passwordOk = await verifyPassword(row.password_hash, body.currentPassword);
    if (!passwordOk) {
      await audit({ req, userId, event: '2fa_disable_failed', details: { reason: 'bad_password' } });
      throw new HttpError(401, 'invalid_credentials', 'current password is incorrect');
    }

    let secret;
    try {
      secret = decryptSecret(row.secret_encrypted);
    } catch (err) {
      req.log?.error({ err, userId }, '2fa decrypt failed during disable');
      throw new HttpError(500, '2fa_decrypt_failed', 'cannot read stored secret — contact support');
    }

    if (!verifyCode(secret, body.code)) {
      await audit({ req, userId, event: '2fa_disable_failed', details: { reason: 'bad_code' } });
      throw new HttpError(400, '2fa_bad_code', 'that code is incorrect or expired — try again');
    }

    await query(`DELETE FROM user_totp WHERE user_id = $1`, [userId]);
    await clearAllRecoveryCodes(userId);
    await query(
      `UPDATE users SET mfa_enrolled_at = NULL, updated_at = now() WHERE id = $1`,
      [userId]
    );

    await audit({ req, userId, event: '2fa_disabled' });

    res.json({ kind: 'auth.2fa.disable', ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/2fa/verify  { code? recoveryCode? }
 * Second step of the login ladder. Reads the pre_2fa cookie that
 * /api/auth/login set, validates a TOTP code OR a recovery code, then
 * promotes the session to a full one (stage NULL, full TTL).
 *
 * On failure the pre_2fa cookie stays alive — the user can try again until
 * the 5-minute window closes. Rate limiting (STRICT_AUTH_PATHS in
 * middleware/rateLimit.js) caps brute-force attempts.
 */
router.post('/verify', async (req, res, next) => {
  try {
    const body = parse(VerifyBody, req.body ?? {});

    const cookieValue = req.cookies?.[config.session.cookieName];
    const raw = cookieValue ? unsignCookieValue(cookieValue) : null;
    const pre = raw ? await findPreSession(raw) : null;
    if (!pre) {
      // No pre-session at all — the user needs to start over from /login.
      throw new HttpError(401, '2fa_no_pending', 'no 2FA challenge in progress; sign in again');
    }

    const userId = pre.user.id;
    let success = false;
    let usedRecovery = false;

    if (body.code) {
      const { rows } = await query(
        `SELECT secret_encrypted FROM user_totp
           WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
        [userId]
      );
      const row = rows[0];
      if (!row) {
        // User has a pre_2fa session but no enrollment? Shouldn't happen,
        // but treat as a failed verify rather than crash.
        await audit({ req, userId, event: '2fa_verify_failed', details: { reason: 'no_enrollment' } });
        throw new HttpError(400, '2fa_not_enrolled', '2FA is not enabled on this account');
      }
      let secret;
      try {
        secret = decryptSecret(row.secret_encrypted);
      } catch (err) {
        req.log?.error({ err, userId }, '2fa decrypt failed during verify');
        throw new HttpError(500, '2fa_decrypt_failed', 'cannot read stored secret — contact support');
      }
      success = verifyCode(secret, body.code);
      if (success) {
        // Track last_used_at for the user's "active second factor" UI.
        query(`UPDATE user_totp SET last_used_at = now() WHERE user_id = $1`, [userId]).catch(
          () => {}
        );
      }
    } else if (body.recoveryCode) {
      success = await consumeCode(userId, body.recoveryCode);
      usedRecovery = success;
    }

    if (!success) {
      await audit({
        req,
        userId,
        event: '2fa_verify_failed',
        details: { mode: body.code ? 'totp' : 'recovery' },
      });
      throw new HttpError(401, '2fa_bad_code', 'incorrect 2FA code');
    }

    // Promote the pre-session — same row, same id, just stage NULL + new TTL.
    // Doing it in-place (vs. creating a fresh session) keeps audit trails
    // and downstream "active sessions" lists from getting double-counted.
    const newExpiresAt = await promoteSessionToFull(pre.sessionId);
    if (!newExpiresAt) {
      // Lost the race against revoke / expire — caller has to re-login.
      throw new HttpError(401, '2fa_session_lost', 'sign in again');
    }
    setSessionCookie(res, raw, newExpiresAt);

    // Now that login is fully complete, bump last_login_at — the equivalent
    // moment for a 2FA user. (For non-2FA users this happens in /login.)
    query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]).catch(() => {});

    let recoveryCodesRemaining;
    if (usedRecovery) {
      recoveryCodesRemaining = await remainingCount(userId);
    }

    await audit({
      req,
      userId,
      event: usedRecovery ? '2fa_verified_recovery' : '2fa_verified',
      details: usedRecovery ? { remaining: recoveryCodesRemaining } : undefined,
    });

    res.json({
      kind: 'auth.2fa.verify',
      user: userToPublic(pre.user),
      session: { expiresAt: newExpiresAt },
      ...(usedRecovery ? { usedRecovery: true, recoveryCodesRemaining } : {}),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
