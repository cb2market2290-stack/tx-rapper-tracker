// src/routes/webauthn.js
// WebAuthn (FIDO2 / passkeys) routes — second-factor by hardware key
// or platform passkey, alongside TOTP.
//
//   POST /api/auth/webauthn/register/options       — start enroll (full session)
//   POST /api/auth/webauthn/register/verify        — finish enroll (full session)
//   POST /api/auth/webauthn/authenticate/options   — start verify (pre_2fa session)
//   POST /api/auth/webauthn/authenticate/verify    — finish verify (pre_2fa → full)
//   GET  /api/auth/webauthn/credentials            — list saved keys (full session)
//   DELETE /api/auth/webauthn/credentials/:id      — remove a key (full session)
//
// Why register and authenticate are split between full vs pre_2fa session:
//   * Adding a key proves "this user, while signed in, owns this hardware".
//   * Authenticating a key happens BEFORE the second factor passes, so we
//     read the pre_2fa cookie via findPreSession() — the same trick TOTP
//     uses. The full session is created only after the assertion verifies.

import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import {
  bufToB64url,
  b64urlToBuf,
  buildRegistrationOptions,
  verifyAndStoreRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
  saveChallenge,
  consumeChallenge,
  listCredentials,
  findCredentialByExternalId,
  deleteCredentialForUser,
} from '../auth/webauthn.js';
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

// --- helpers --------------------------------------------------------------

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

// --- schemas --------------------------------------------------------------

// We don't validate the assertion/attestation shape ourselves — simplewebauthn
// does that authoritatively. But we do gate by "is it an object" so a
// non-JSON payload doesn't reach the verify path.
const RegisterOptionsBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

const RegisterVerifyBody = z.object({
  // RegistrationResponseJSON from the browser — pass through.
  response: z.record(z.unknown()),
  // Optional human-friendly label set at /options time, echoed back.
  name: z.string().trim().min(1).max(80).optional(),
});

const AuthenticateVerifyBody = z.object({
  response: z.record(z.unknown()),
});

// --- register -------------------------------------------------------------

/**
 * POST /api/auth/webauthn/register/options
 * Begin enrolling a new credential. Returns a PublicKeyCredentialCreationOptions
 * shape (already JSON-friendly — base64url for the byte fields). The optional
 * name is stashed in a short-lived cookie alongside the challenge so we can
 * apply it on /register/verify without trusting client-supplied fields.
 */
router.post('/register/options', requireUser(), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const body = parse(RegisterOptionsBody, req.body ?? {});

    // Pull existing credentials to feed excludeCredentials — prevents the
    // user from registering the same authenticator twice and dead-locking
    // their own sign-in flow.
    const existing = await listCredentials(userId);
    const excludedIds = existing
      .map((c) => b64urlToBuf(c.credentialId))
      .filter(Boolean);

    const opts = await buildRegistrationOptions({
      userId,
      userEmail: req.user.email,
      userDisplayName: req.user.displayName ?? req.user.email,
      excludedCredentialIds: excludedIds,
    });

    // simplewebauthn returns options with `challenge` already base64url-encoded.
    // saveChallenge stores the raw bytes.
    const challengeBytes = b64urlToBuf(opts.challenge);
    if (!challengeBytes) {
      throw new HttpError(500, 'webauthn_challenge_invalid', 'challenge generation failed');
    }
    await saveChallenge({ userId, challenge: challengeBytes, kind: 'register' });

    // Stash the user-supplied name in a short-lived signed cookie. We could
    // store it on the challenge row, but a cookie keeps the challenges
    // table free of UX state.
    if (body.name) {
      res.cookie('tx_webauthn_name', body.name, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.session.cookieSecure,
        maxAge: 2 * 60 * 1000,
        path: '/api/auth/webauthn',
      });
    }

    await audit({ req, userId, event: 'webauthn_register_started' });

    res.json({ kind: 'auth.webauthn.register.options', options: opts });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/webauthn/register/verify  { response, name? }
 * Verify the attestation and store the credential. The browser passed
 * back exactly what generateRegistrationOptions asked it to sign.
 */
router.post('/register/verify', requireUser(), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const body = parse(RegisterVerifyBody, req.body ?? {});

    const challenge = await consumeChallenge({ userId, kind: 'register' });
    if (!challenge) {
      throw new HttpError(400, 'webauthn_no_challenge', 'no register challenge in progress');
    }

    // Prefer the cookie-stashed name (set at /options time) but allow the
    // verify body to override it — useful when the client wants the user
    // to confirm before saving.
    const stashedName = req.cookies?.tx_webauthn_name;
    const name = body.name?.trim() || stashedName?.trim() || null;

    const result = await verifyAndStoreRegistration({
      userId,
      response: body.response,
      expectedChallenge: challenge,
      name,
    });
    if (!result.verified) {
      await audit({ req, userId, event: 'webauthn_register_failed' });
      throw new HttpError(400, 'webauthn_register_failed', 'attestation verification failed');
    }

    // Drop the name cookie now that it's persisted.
    res.clearCookie('tx_webauthn_name', { path: '/api/auth/webauthn' });

    // Mirror TOTP: populate users.mfa_enrolled_at if not already, so /me
    // reports any-2fa-on without a join. Existing TOTP users keep theirs.
    await query(
      `UPDATE users
          SET mfa_enrolled_at = COALESCE(mfa_enrolled_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [userId]
    );

    await audit({ req, userId, event: 'webauthn_registered', details: { credentialDbId: result.dbId } });

    res.json({
      kind: 'auth.webauthn.register.verify',
      ok: true,
      credential: {
        id: result.dbId,
        credentialId: bufToB64url(result.credentialId),
        name,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- authenticate (pre_2fa → full) ---------------------------------------

/**
 * POST /api/auth/webauthn/authenticate/options
 * Reads the pre_2fa cookie, returns options the browser hands to its
 * authenticator, and persists the challenge. Same cookie lives through to
 * /authenticate/verify.
 */
router.post('/authenticate/options', async (req, res, next) => {
  try {
    const cookieValue = req.cookies?.[config.session.cookieName];
    const raw = cookieValue ? unsignCookieValue(cookieValue) : null;
    const pre = raw ? await findPreSession(raw) : null;
    if (!pre) {
      throw new HttpError(401, '2fa_no_pending', 'no 2FA challenge in progress; sign in again');
    }
    const userId = pre.user.id;

    const creds = await listCredentials(userId);
    if (creds.length === 0) {
      throw new HttpError(400, 'webauthn_no_credentials', 'no security keys enrolled');
    }
    const allowIds = creds.map((c) => b64urlToBuf(c.credentialId)).filter(Boolean);

    const opts = await buildAuthenticationOptions({ allowCredentialIds: allowIds });
    const challengeBytes = b64urlToBuf(opts.challenge);
    if (!challengeBytes) {
      throw new HttpError(500, 'webauthn_challenge_invalid', 'challenge generation failed');
    }
    await saveChallenge({ userId, challenge: challengeBytes, kind: 'authenticate' });

    res.json({ kind: 'auth.webauthn.authenticate.options', options: opts });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/webauthn/authenticate/verify  { response }
 * Verify the assertion. Promotes the pre_2fa session in-place, mirroring
 * the TOTP path so audit/session counts stay clean.
 */
router.post('/authenticate/verify', async (req, res, next) => {
  try {
    const body = parse(AuthenticateVerifyBody, req.body ?? {});

    const cookieValue = req.cookies?.[config.session.cookieName];
    const raw = cookieValue ? unsignCookieValue(cookieValue) : null;
    const pre = raw ? await findPreSession(raw) : null;
    if (!pre) {
      throw new HttpError(401, '2fa_no_pending', 'no 2FA challenge in progress; sign in again');
    }
    const userId = pre.user.id;

    const challenge = await consumeChallenge({ userId, kind: 'authenticate' });
    if (!challenge) {
      throw new HttpError(400, 'webauthn_no_challenge', 'no authenticate challenge in progress');
    }

    // The browser sends `response.id` as the credential id (base64url).
    // Look up the row by that — verifyAuthentication needs the public key
    // and stored counter.
    const credIdB64 = body.response?.id;
    const credIdBuf = b64urlToBuf(credIdB64);
    if (!credIdBuf) {
      throw new HttpError(400, 'webauthn_bad_response', 'response.id missing or malformed');
    }
    const credRow = await findCredentialByExternalId(credIdBuf);
    if (!credRow || credRow.user_id !== userId) {
      await audit({ req, userId, event: 'webauthn_verify_failed', details: { reason: 'unknown_cred' } });
      throw new HttpError(401, 'webauthn_bad_credential', 'credential not registered for this user');
    }

    let result;
    try {
      result = await verifyAuthentication({
        response: body.response,
        expectedChallenge: challenge,
        credRow,
      });
    } catch (err) {
      req.log?.warn({ err, userId }, 'webauthn verify threw');
      result = { verified: false };
    }
    if (!result.verified) {
      await audit({ req, userId, event: 'webauthn_verify_failed', details: { reason: 'bad_assertion' } });
      throw new HttpError(401, 'webauthn_bad_assertion', 'assertion failed');
    }

    const newExpiresAt = await promoteSessionToFull(pre.sessionId);
    if (!newExpiresAt) {
      throw new HttpError(401, '2fa_session_lost', 'sign in again');
    }
    setSessionCookie(res, raw, newExpiresAt);
    query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]).catch(() => {});

    await audit({ req, userId, event: 'webauthn_verified', details: { credentialDbId: result.credentialDbId } });

    res.json({
      kind: 'auth.webauthn.authenticate.verify',
      user: userToPublic(pre.user),
      session: { expiresAt: newExpiresAt },
    });
  } catch (err) {
    next(err);
  }
});

// --- credentials list / delete -------------------------------------------

router.get('/credentials', requireUser(), async (req, res, next) => {
  try {
    const creds = await listCredentials(req.user.id);
    res.json({ kind: 'auth.webauthn.credentials', credentials: creds });
  } catch (err) {
    next(err);
  }
});

router.delete('/credentials/:id', requireUser(), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'bad_request', 'credential id must be a positive integer');
    }
    const ok = await deleteCredentialForUser(req.user.id, id);
    if (!ok) throw new HttpError(404, 'not_found', 'credential not found');
    await audit({ req, userId: req.user.id, event: 'webauthn_credential_deleted', details: { credentialDbId: id } });
    res.json({ kind: 'auth.webauthn.credentials.delete', ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
