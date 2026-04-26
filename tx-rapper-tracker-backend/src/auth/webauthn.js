// src/auth/webauthn.js
// WebAuthn (FIDO2 / passkeys) helpers for the second-factor flow.
//
// What this module does:
//   * Wraps @simplewebauthn/server's four ceremony entry points
//     (generate/verify × register/authenticate) with our config and
//     DB plumbing.
//   * Persists challenges in webauthn_challenges so single-use is
//     enforced server-side (cookie-based challenges are replayable
//     within the cookie's life; DB rows can be atomically consumed).
//   * Loads/stores credentials in webauthn_credentials. Counter is
//     bumped on every successful authenticate.
//
// Wire format notes:
//   * credential_id is stored as raw BYTEA — no base64 round-trip on
//     read. simplewebauthn returns/accepts Uint8Array for the same
//     field, so the hop is identity.
//   * The browser sends/receives base64url. We convert at the edge in
//     routes/webauthn.js, never inside this module — keeps the helper
//     pure and easier to unit test.
//
// Library notes:
//   * @simplewebauthn/server v11 returns/accepts Uint8Array everywhere
//     (Node Buffer is a Uint8Array subclass, so we pass them straight
//     through). The shape of `credential` for verifyAuthentication-
//     Response changed in v10+: it's now `{ id, publicKey, counter }`
//     (the field used to be `authenticator`). We use the v11 shape.
//   * Importing the module unconditionally — installation is required
//     to run the server. Tests for this file should import only the
//     pure helpers below (base64url + row mapping); whole-module
//     ceremonies belong in the smoke script.

import crypto from 'node:crypto';

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';

const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes — enough for slow taps

// --- base64url helpers -----------------------------------------------------
// Browser sends base64url; Postgres BYTEA wants Buffer. We hand-roll the
// conversions because Node's Buffer.from(s, 'base64url') is fine for input
// but Buffer.toString('base64url') strips padding the way browsers expect.

/** base64url-encode any BufferSource into a string with no padding. */
export function bufToB64url(buf) {
  if (buf == null) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64url');
}

/** Decode base64url (or base64) to a Buffer. Returns null on bad input. */
export function b64urlToBuf(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  try {
    return Buffer.from(str, 'base64url');
  } catch {
    return null;
  }
}

// --- credential row mapping ------------------------------------------------

/**
 * Render a stored credential row as the public, base64url-encoded shape
 * the frontend lists. Surfaced by GET /api/auth/webauthn/credentials.
 *
 * `last_used_at` may be null for never-used credentials — keep it that way
 * so the UI can show "never used" rather than the created_at.
 */
export function credentialRowToPublic(row) {
  return {
    id: row.id,
    credentialId: bufToB64url(row.credential_id),
    name: row.name ?? null,
    transports: row.transports ?? null,
    aaguid: row.aaguid ?? null,
    backupEligible: !!row.backup_eligible,
    backupState: !!row.backup_state,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

// --- challenge persistence -------------------------------------------------

/**
 * Save a challenge row. `kind` is 'register' or 'authenticate'. Returns
 * the inserted row id — kept in the response cookie path on the route so
 * verify can target the exact challenge without trusting client-supplied
 * IDs. (We index by user_id + kind today; if usernameless flows come
 * along, switch to id-based lookup.)
 */
export async function saveChallenge({ userId, challenge, kind }) {
  if (kind !== 'register' && kind !== 'authenticate') {
    throw new Error(`saveChallenge: unknown kind ${kind}`);
  }
  // Drop any prior unconsumed challenge of the same kind for this user.
  // Holding two open challenges would let a stolen one race the live one.
  await query(
    `DELETE FROM webauthn_challenges
      WHERE user_id IS NOT DISTINCT FROM $1 AND kind = $2 AND consumed_at IS NULL`,
    [userId ?? null, kind]
  );
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
  const { rows } = await query(
    `INSERT INTO webauthn_challenges (user_id, challenge, kind, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId ?? null, Buffer.from(challenge), kind, expires]
  );
  return rows[0].id;
}

/**
 * Atomically read AND consume the active challenge for a (user, kind).
 * Returns the raw challenge bytes if one exists and is not expired,
 * else null. Single-use: a second call returns null even with the same
 * row.
 */
export async function consumeChallenge({ userId, kind }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, challenge, expires_at
         FROM webauthn_challenges
        WHERE user_id IS NOT DISTINCT FROM $1
          AND kind = $2
          AND consumed_at IS NULL
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      [userId ?? null, kind]
    );
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      // Mark consumed so the sweep doesn't have to. Return null — the
      // caller will issue a fresh challenge.
      await client.query(
        `UPDATE webauthn_challenges SET consumed_at = now() WHERE id = $1`,
        [row.id]
      );
      return null;
    }
    await client.query(
      `UPDATE webauthn_challenges SET consumed_at = now() WHERE id = $1`,
      [row.id]
    );
    // simplewebauthn's verify functions accept the challenge as a base64url
    // string OR a Uint8Array. Buffer is a Uint8Array — return it raw.
    return Buffer.from(row.challenge);
  });
}

// --- credential CRUD -------------------------------------------------------

export async function listCredentials(userId) {
  const { rows } = await query(
    `SELECT id, credential_id, name, transports, aaguid,
            backup_eligible, backup_state, created_at, last_used_at
       FROM webauthn_credentials
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId]
  );
  return rows.map(credentialRowToPublic);
}

export async function countCredentials(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1`,
    [userId]
  );
  return rows[0]?.n || 0;
}

export async function findCredentialByExternalId(credentialIdBuf) {
  const { rows } = await query(
    `SELECT id, user_id, credential_id, public_key, counter,
            transports, aaguid, name, backup_eligible, backup_state
       FROM webauthn_credentials
      WHERE credential_id = $1
      LIMIT 1`,
    [credentialIdBuf]
  );
  return rows[0] ?? null;
}

/**
 * Insert a fresh credential row. Returns the new id. The caller passes
 * Buffers for the bytea columns; we don't re-encode here.
 */
export async function insertCredential({
  userId,
  credentialId,
  publicKey,
  counter,
  transports,
  aaguid,
  name,
  backupEligible,
  backupState,
}) {
  const { rows } = await query(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, transports,
        aaguid, name, backup_eligible, backup_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      userId,
      credentialId,
      publicKey,
      counter ?? 0,
      transports ?? null,
      aaguid ?? null,
      name ?? null,
      !!backupEligible,
      !!backupState,
    ]
  );
  return rows[0].id;
}

export async function deleteCredentialForUser(userId, dbId) {
  const { rowCount } = await query(
    `DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2`,
    [dbId, userId]
  );
  return rowCount > 0;
}

export async function bumpCredentialCounter(dbId, newCounter) {
  await query(
    `UPDATE webauthn_credentials
        SET counter = $2, last_used_at = now()
      WHERE id = $1`,
    [dbId, newCounter]
  );
}

// --- ceremony entry points -------------------------------------------------

/**
 * Generate registration options for an authenticated user. Caller must
 * persist the returned `challenge` via saveChallenge() and forward
 * `options` to the client.
 *
 * `userIdBytes` MUST be a stable per-user identifier — we derive a
 * 16-byte digest of the UUID so it's RP-private and not the user's
 * actual id. (WebAuthn level 3 makes this a Buffer.)
 *
 * `excludedCredentialIds` is an array of Buffers — the user's existing
 * credentials, so the browser refuses to re-enroll the same authenticator.
 */
export async function buildRegistrationOptions({
  userId,
  userEmail,
  userDisplayName,
  excludedCredentialIds = [],
}) {
  // 16-byte stable handle derived from the UUID. Doesn't reveal the UUID
  // and is consistent across registrations so platform passkeys merge
  // entries correctly.
  const userHandle = Buffer.from(
    crypto.createHash('sha256').update(userId).digest().subarray(0, 16)
  );
  const opts = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userID: userHandle,
    userName: userEmail,
    userDisplayName: userDisplayName || userEmail,
    timeout: 60_000,
    attestationType: 'none',
    authenticatorSelection: {
      // Default = let the browser show its full picker (platform OR roaming).
      // residentKey 'preferred' so passkeys (discoverable creds) work but
      // hardware-only keys still register.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: excludedCredentialIds.map((id) => ({
      id, // v11 wants the raw Uint8Array
      type: 'public-key',
    })),
    supportedAlgorithmIDs: [-7, -257], // ES256, RS256
  });
  return opts;
}

/** Verify a registration attestation and persist the new credential. */
export async function verifyAndStoreRegistration({
  userId,
  response,
  expectedChallenge,
  name,
}) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: expectedChallenge.toString('base64url'),
    expectedOrigin: config.webauthn.origins,
    expectedRPID: config.webauthn.rpId,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false };
  }
  // v11: registrationInfo.credential = { id, publicKey, counter, transports }
  const info = verification.registrationInfo;
  const credential = info.credential;
  const credentialId = Buffer.from(credential.id);
  const publicKey = Buffer.from(credential.publicKey);

  const dbId = await insertCredential({
    userId,
    credentialId,
    publicKey,
    counter: credential.counter ?? 0,
    transports: credential.transports ?? null,
    aaguid: info.aaguid ?? null,
    name: name?.trim() || null,
    backupEligible: !!info.credentialBackedUp || !!info.credentialDeviceType,
    backupState: !!info.credentialBackedUp,
  });
  return {
    verified: true,
    dbId,
    credentialId,
  };
}

/**
 * Generate authentication options. `allowCredentials` is the set of
 * credential ids we expect — pulled from webauthn_credentials for the
 * pre_2fa user. If you support usernameless login later, pass an empty
 * list and the browser will offer all discoverable creds.
 */
export async function buildAuthenticationOptions({ allowCredentialIds = [] }) {
  return generateAuthenticationOptions({
    rpID: config.webauthn.rpId,
    timeout: 60_000,
    allowCredentials: allowCredentialIds.map((id) => ({
      id, // raw Uint8Array
      type: 'public-key',
    })),
    userVerification: 'preferred',
  });
}

/**
 * Verify an authentication assertion. On success, bumps the counter and
 * returns the credential row id. Returns { verified:false } on any
 * failure — does NOT throw on a bad signature, since callers want to
 * audit those without a try/catch.
 */
export async function verifyAuthentication({ response, expectedChallenge, credRow }) {
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: expectedChallenge.toString('base64url'),
    expectedOrigin: config.webauthn.origins,
    expectedRPID: config.webauthn.rpId,
    // v11 shape — was `authenticator` in earlier majors.
    credential: {
      id: credRow.credential_id, // Buffer is a Uint8Array
      publicKey: credRow.public_key,
      counter: Number(credRow.counter ?? 0),
      transports: credRow.transports ?? undefined,
    },
    requireUserVerification: false,
  });
  if (!verification.verified) return { verified: false };
  const newCounter = verification.authenticationInfo?.newCounter ?? credRow.counter;
  await bumpCredentialCounter(credRow.id, newCounter);
  return {
    verified: true,
    credentialDbId: credRow.id,
    newCounter,
  };
}
