// src/routes/auth.js
// Authentication endpoints.
//
//   POST /api/auth/signup   { email, password, displayName? }
//   POST /api/auth/login    { email, password }
//   POST /api/auth/logout
//   GET  /api/auth/me
//
// Design rules:
//   * Signup + login both return { user, session } and set the session cookie.
//   * Never tell the client whether it was "unknown email" vs "wrong password" —
//     we always return a generic "invalid credentials" to avoid account enumeration.
//   * Every event goes to audit_log with ip + user_agent, for later security review.
//   * Email is normalized to lowercase; citext handles casing in Postgres but
//     we still want a canonical form in responses.

import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword, needsRehash } from '../auth/password.js';
import { checkPasswordPolicy } from '../auth/policy.js';
import {
  createSession,
  revokeSession,
  revokeAllForUser,
  signCookieValue,
  unsignCookieValue,
  cookieOptions,
} from '../auth/sessions.js';
import {
  createResetToken,
  peekResetToken,
  consumeResetToken,
} from '../auth/passwordReset.js';
import { mailer } from '../lib/mailer.js';
import { requireUser } from '../middleware/authenticate.js';
import { HttpError } from '../middleware/errorHandler.js';

const router = Router();

// ---- Schemas -------------------------------------------------------------
// Password policy: min 12 chars. Intentionally loose on character classes —
// length dominates strength, and forcing "1 symbol" nudges users to
// "Password1!" patterns that are worse than a passphrase.
const SignupBody = z.object({
  email: z.string().email().max(320).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(12, 'password must be at least 12 characters').max(256),
  displayName: z.string().trim().min(1).max(80).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(320).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1).max(256),
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

// ---- Audit helper --------------------------------------------------------
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

function clearSessionCookie(res) {
  res.clearCookie(config.session.cookieName, cookieOptions());
}

function userToPublic(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name ?? u.displayName ?? null,
    createdAt: u.created_at ?? null,
  };
}

// ---- Routes --------------------------------------------------------------

/** POST /api/auth/signup */
router.post('/signup', async (req, res, next) => {
  try {
    const body = parse(SignupBody, req.body ?? {});

    // Check existence first to return a clean 409. Racy — the UNIQUE
    // constraint below is the actual source of truth.
    const existing = await query('SELECT id FROM users WHERE email = $1', [body.email]);
    if (existing.rows.length > 0) {
      await audit({ req, event: 'signup_conflict', details: { email: body.email } });
      throw new HttpError(409, 'email_taken', 'an account with that email already exists');
    }

    // zxcvbn + HaveIBeenPwned checks. Runs BEFORE hashing so we never
    // spend CPU on a password we'll reject. Fails open on HIBP outage.
    const policy = await checkPasswordPolicy(body.password, {
      email: body.email,
      displayName: body.displayName,
    });
    if (!policy.ok) {
      await audit({
        req,
        event: 'signup_weak_password',
        details: { code: policy.code, email: body.email },
      });
      throw new HttpError(400, policy.code, policy.message);
    }

    const passwordHash = await hashPassword(body.password);
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, created_at`,
      [body.email, passwordHash, body.displayName ?? null]
    );
    const user = rows[0];

    const { raw, expiresAt } = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, raw, expiresAt);

    await audit({ req, userId: user.id, event: 'signup' });

    res.status(201).json({
      kind: 'auth.signup',
      user: userToPublic(user),
      session: { expiresAt },
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/login */
router.post('/login', async (req, res, next) => {
  try {
    const body = parse(LoginBody, req.body ?? {});

    const { rows } = await query(
      'SELECT id, email, display_name, created_at, password_hash, is_disabled FROM users WHERE email = $1',
      [body.email]
    );
    const user = rows[0];

    // Unified failure path — same error + same timing profile regardless
    // of whether the email exists. We still do a hash-verify on a dummy
    // value to keep timing uniform when the email is unknown.
    if (!user) {
      await verifyPassword(
        // Valid-looking encoded hash so verify does real work.
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$' +
          'c29tZWhhc2hzb21laGFzaHNvbWVoYXNoc29tZWhhc2hzb21laGFzaHNvbWVoYXNoc29tZWhhc2g',
        body.password
      );
      await audit({ req, event: 'login_failed', details: { reason: 'unknown_email' } });
      throw new HttpError(401, 'invalid_credentials', 'invalid email or password');
    }

    if (user.is_disabled) {
      await audit({ req, userId: user.id, event: 'login_disabled' });
      throw new HttpError(403, 'account_disabled', 'this account is disabled');
    }

    const ok = await verifyPassword(user.password_hash, body.password);
    if (!ok) {
      await audit({ req, userId: user.id, event: 'login_failed', details: { reason: 'bad_password' } });
      throw new HttpError(401, 'invalid_credentials', 'invalid email or password');
    }

    // Opportunistic rehash if params were bumped since signup.
    if (needsRehash(user.password_hash)) {
      try {
        const newHash = await hashPassword(body.password);
        await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
          newHash,
          user.id,
        ]);
      } catch (err) {
        req.log?.warn({ err, userId: user.id }, 'rehash failed — non-fatal');
      }
    }

    // Check 2FA enrollment BEFORE issuing a session. If the user has a
    // confirmed TOTP row OR at least one WebAuthn credential, we issue a
    // short-lived pre_2fa session instead of a full one — login is a
    // two-step ladder, password is just step 1. The frontend chooses
    // between TOTP and security-key paths based on what's available.
    const [totp, webauthn] = await Promise.all([
      query(
        `SELECT 1 FROM user_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
        [user.id]
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1`,
        [user.id]
      ),
    ]);
    const hasTotp = totp.rows.length > 0;
    const webauthnCount = webauthn.rows[0]?.n ?? 0;
    const needs2fa = hasTotp || webauthnCount > 0;

    if (needs2fa) {
      const { raw, expiresAt } = await createSession({
        userId: user.id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        stage: 'pre_2fa',
      });
      setSessionCookie(res, raw, expiresAt);

      await audit({ req, userId: user.id, event: 'login_2fa_required' });

      // We deliberately do NOT include `user` here — the password step is
      // half-trusted, so until /2fa/verify lands we don't echo profile data
      // back. Frontend uses `methods` to decide which UI to show: TOTP
      // input, "Use security key" button, or both.
      return res.json({
        kind: 'auth.login',
        needs2fa: true,
        methods: {
          totp: hasTotp,
          webauthn: webauthnCount > 0,
        },
        // Surface the short window so the UI can show a countdown.
        challengeExpiresAt: expiresAt,
      });
    }

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    const { raw, expiresAt } = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, raw, expiresAt);

    await audit({ req, userId: user.id, event: 'login' });

    res.json({
      kind: 'auth.login',
      user: userToPublic(user),
      session: { expiresAt },
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/logout — idempotent; safe to call with no cookie. */
router.post('/logout', async (req, res, next) => {
  try {
    const cookieValue = req.cookies?.[config.session.cookieName];
    const raw = cookieValue ? unsignCookieValue(cookieValue) : null;
    if (raw) {
      await revokeSession(raw);
      await audit({ req, userId: req.user?.id, event: 'logout' });
    }
    clearSessionCookie(res);
    res.json({ kind: 'auth.logout', ok: true });
  } catch (err) {
    next(err);
  }
});

/** GET /api/auth/me — requires a valid session. */
router.get('/me', requireUser(), async (req, res, next) => {
  try {
    // Surface 2FA status so the frontend Security panel can render correct
    // state ("Enable 2FA" vs "Disable 2FA + N recovery codes left") without
    // a second round-trip. Cheap — three PK/index-backed lookups on user_id.
    const [totp, recovery, webauthn] = await Promise.all([
      query(
        `SELECT confirmed_at, last_used_at FROM user_totp WHERE user_id = $1`,
        [req.user.id]
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM user_recovery_codes
          WHERE user_id = $1 AND consumed_at IS NULL`,
        [req.user.id]
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1`,
        [req.user.id]
      ),
    ]);
    const totpRow = totp.rows[0];
    const totpEnrolled = Boolean(totpRow?.confirmed_at);
    const webauthnCount = webauthn.rows[0]?.n ?? 0;
    const mfa = {
      // `enrolled` keeps its v1 meaning (TOTP) for back-compat with code that
      // already checks it. `anyEnabled` is the new aggregate.
      enrolled: totpEnrolled,
      enrolledAt: totpRow?.confirmed_at ?? null,
      lastUsedAt: totpRow?.last_used_at ?? null,
      recoveryCodesRemaining: recovery.rows[0]?.n ?? 0,
      totp: totpEnrolled,
      webauthnCount,
      anyEnabled: totpEnrolled || webauthnCount > 0,
    };
    res.json({
      kind: 'auth.me',
      user: req.user,
      session: req.session,
      mfa,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Change password -----------------------------------------------------
// POST /api/auth/change-password  { currentPassword, newPassword }
// Requires a valid session. Behavior:
//   * Verifies the current password against the stored hash.
//   * Runs zxcvbn + HIBP checks on the new password.
//   * Writes the new Argon2id hash, bumps updated_at.
//   * Revokes every OTHER session for this user (keeps the current one).
//   * Audits 'password_changed'.
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12, 'newPassword must be at least 12 characters').max(256),
});

router.post('/change-password', requireUser(), async (req, res, next) => {
  try {
    const body = parse(ChangePasswordBody, req.body ?? {});
    if (body.currentPassword === body.newPassword) {
      throw new HttpError(400, 'same_password', 'new password must differ from current');
    }

    const { rows } = await query(
      'SELECT id, email, display_name, password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) {
      // Shouldn't happen — requireUser() already loaded them — but be safe.
      throw new HttpError(401, 'unauthenticated', 'sign in required');
    }

    const ok = await verifyPassword(user.password_hash, body.currentPassword);
    if (!ok) {
      await audit({ req, userId: user.id, event: 'change_password_failed', details: { reason: 'bad_current' } });
      throw new HttpError(401, 'invalid_credentials', 'current password is incorrect');
    }

    const policy = await checkPasswordPolicy(body.newPassword, {
      email: user.email,
      displayName: user.display_name,
    });
    if (!policy.ok) {
      await audit({
        req,
        userId: user.id,
        event: 'change_password_weak',
        details: { code: policy.code },
      });
      throw new HttpError(400, policy.code, policy.message);
    }

    const newHash = await hashPassword(body.newPassword);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [newHash, user.id]
    );

    // Revoke all OTHER sessions — a password change is a security event, so
    // any device that was logged in before should be forced to re-auth. We
    // keep the current session so the user isn't logged out mid-request.
    await query(
      `UPDATE sessions
         SET revoked_at = now()
         WHERE user_id = $1
           AND id <> $2
           AND revoked_at IS NULL`,
      [user.id, req.session.id]
    );

    await audit({ req, userId: user.id, event: 'password_changed' });

    res.json({
      kind: 'auth.change_password',
      ok: true,
      // Client can reload its session-list view off of this.
      otherSessionsRevoked: true,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Password reset ------------------------------------------------------
// POST /api/auth/forgot  { email }
//   Start a reset. Enumeration-safe: ALWAYS returns 202, even when the
//   email doesn't resolve to a user. We build + send the email in the
//   background so a timing side-channel can't tell us apart either.
//
// GET  /api/auth/reset/check?token=...
//   Peek at a token without consuming it, so the UI can show
//   "this link has expired" up front. Returns { ok: boolean, email?: string }.
//
// POST /api/auth/reset  { token, newPassword }
//   Consume the token, replace the password, revoke ALL sessions for the
//   user (a password reset is a security event — assume the old sessions
//   are compromised until proven otherwise).

const ForgotBody = z.object({
  email: z.string().email().max(320).transform((s) => s.trim().toLowerCase()),
});

const ResetBody = z.object({
  token: z.string().min(10).max(256),
  newPassword: z.string().min(12, 'newPassword must be at least 12 characters').max(256),
});

function buildResetUrl(rawToken) {
  // APP_BASE_URL is validated as a URL in config; no trailing slash.
  const u = new URL(config.appBaseUrl + '/reset');
  u.searchParams.set('token', rawToken);
  return u.toString();
}

function renderResetEmail({ email, resetUrl, ttlMinutes }) {
  const text = [
    `Hi,`,
    ``,
    `Someone (hopefully you) asked to reset the password for your TX Rapper`,
    `Tracker account (${email}).`,
    ``,
    `Click the link below to pick a new password. It expires in ${ttlMinutes} minutes`,
    `and can only be used once.`,
    ``,
    resetUrl,
    ``,
    `If you didn't request this, you can ignore this email — your password`,
    `won't change.`,
    ``,
    `— TX Rapper Tracker`,
  ].join('\n');
  // Keep HTML tiny and defensive — no images, no remote CSS.
  const html =
    `<p>Hi,</p>` +
    `<p>Someone (hopefully you) asked to reset the password for your TX Rapper Tracker account (<code>${email}</code>).</p>` +
    `<p>Click the link below to pick a new password. It expires in ${ttlMinutes} minutes and can only be used once.</p>` +
    `<p><a href="${resetUrl}">${resetUrl}</a></p>` +
    `<p>If you didn't request this, you can ignore this email — your password won't change.</p>` +
    `<p>— TX Rapper Tracker</p>`;
  return { text, html };
}

/** POST /api/auth/forgot */
router.post('/forgot', async (req, res, next) => {
  try {
    const body = parse(ForgotBody, req.body ?? {});

    // ALWAYS respond 202 — do not leak whether the email matched a user.
    // We kick off the (possibly-null) token + send in the background so
    // response timing is identical for hits and misses.
    res.status(202).json({
      kind: 'auth.forgot',
      ok: true,
      message: 'if an account with that email exists, a reset link is on its way',
    });

    // Async tail — any failure is logged, not surfaced.
    (async () => {
      try {
        const token = await createResetToken({
          email: body.email,
          ttlSeconds: config.passwordResetTtlSeconds,
          ip: req.ip,
          userAgent: req.get('user-agent'),
        });
        if (!token) {
          await audit({ req, event: 'password_reset_requested_unknown_email', details: { email: body.email } });
          return;
        }
        const resetUrl = buildResetUrl(token.raw);
        const ttlMinutes = Math.round(config.passwordResetTtlSeconds / 60);
        const rendered = renderResetEmail({ email: body.email, resetUrl, ttlMinutes });
        await mailer.send({
          to: body.email,
          subject: 'Reset your TX Rapper Tracker password',
          text: rendered.text,
          html: rendered.html,
        });
        await audit({
          req,
          userId: token.userId,
          event: 'password_reset_requested',
          details: { tokenId: token.tokenId, mailer: mailer.kind },
        });
      } catch (err) {
        req.log?.warn({ err }, 'password_reset: background send failed');
        await audit({ req, event: 'password_reset_send_failed', details: { email: body.email } });
      }
    })();
  } catch (err) {
    next(err);
  }
});

/** GET /api/auth/reset/check?token=... */
router.get('/reset/check', async (req, res, next) => {
  try {
    const token = typeof req.query?.token === 'string' ? req.query.token : '';
    const row = await peekResetToken(token);
    if (!row) {
      return res.status(404).json({
        kind: 'auth.reset.check',
        ok: false,
        message: 'this reset link is invalid or has expired',
      });
    }
    // Return the email so the UI can show "resetting password for …".
    res.json({ kind: 'auth.reset.check', ok: true, email: row.email });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/reset */
router.post('/reset', async (req, res, next) => {
  try {
    const body = parse(ResetBody, req.body ?? {});

    // Peek first so we can audit + reject with a clean error. The actual
    // atomic "consume" happens below, so this is just a fail-fast on bad
    // tokens — the race-safe consume is what really protects us.
    const preview = await peekResetToken(body.token);
    if (!preview) {
      await audit({ req, event: 'password_reset_invalid_token' });
      throw new HttpError(400, 'invalid_token', 'this reset link is invalid or has expired');
    }

    // Re-resolve the user for policy context (email/displayName) — these
    // feed into zxcvbn as "user inputs" to reject passwords like "paul123".
    const u = await query(
      'SELECT id, email, display_name, is_disabled FROM users WHERE id = $1',
      [preview.userId]
    );
    const user = u.rows[0];
    if (!user || user.is_disabled) {
      await audit({ req, userId: preview.userId, event: 'password_reset_invalid_token', details: { reason: 'user_gone_or_disabled' } });
      throw new HttpError(400, 'invalid_token', 'this reset link is invalid or has expired');
    }

    const policy = await checkPasswordPolicy(body.newPassword, {
      email: user.email,
      displayName: user.display_name,
    });
    if (!policy.ok) {
      await audit({
        req,
        userId: user.id,
        event: 'password_reset_weak_password',
        details: { code: policy.code },
      });
      throw new HttpError(400, policy.code, policy.message);
    }

    // Atomic single-use consumption. If this returns null the token was
    // already burned between our peek and now — tell the user cleanly.
    const consumed = await consumeResetToken(body.token);
    if (!consumed) {
      await audit({ req, userId: user.id, event: 'password_reset_race_lost' });
      throw new HttpError(400, 'invalid_token', 'this reset link is invalid or has expired');
    }

    const newHash = await hashPassword(body.newPassword);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [newHash, user.id]
    );

    // A reset is a stronger security event than a change-password (we can't
    // verify "it's really them" via current password — only "they have the
    // email"), so we nuke EVERY session including any browser they're
    // currently in. They must log in fresh.
    await revokeAllForUser(user.id);

    // Also burn any other outstanding reset tokens for this user so a
    // stolen second link can't be redeemed after we've already reset.
    await query(
      `UPDATE password_reset_tokens
          SET used_at = now()
        WHERE user_id = $1
          AND used_at IS NULL`,
      [user.id]
    );

    await audit({ req, userId: user.id, event: 'password_reset_completed' });

    // Log them out just like logout does — clear the cookie too, defensively.
    clearSessionCookie(res);

    res.json({
      kind: 'auth.reset',
      ok: true,
      message: 'password reset — please sign in with your new password',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
