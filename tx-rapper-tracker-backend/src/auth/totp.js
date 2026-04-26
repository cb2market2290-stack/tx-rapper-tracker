// src/auth/totp.js
// TOTP (RFC 6238) helpers for the second-factor flow.
//
// Responsibilities:
//   * Generate a fresh shared secret + the otpauth:// URL the
//     authenticator app scans.
//   * Verify a 6-digit code against a stored secret with ±1 step
//     (30s) drift tolerance — covers clock skew without opening a
//     replay window.
//   * Encrypt/decrypt the secret at rest with AES-256-GCM. We don't
//     want a DB dump to be sufficient to clone everyone's TOTP.
//
// Library notes:
//   * We use otplib v13's flat functional API (`generateSync`,
//     `verifySync`, `generateSecret`, `generateURI`). The older
//     `authenticator` namespace was dropped in v13.
//   * verifySync THROWS on non-digit input ("Token must contain only
//     digits") — we filter to /^\d{6}$/ first to keep timing uniform
//     and the error path silent.
//
// Key material:
//   * If TOTP_ENC_KEY is set, we use it directly (must be 64 hex
//     chars = 32 bytes).
//   * Otherwise we derive a 32-byte key from SESSION_SECRET via
//     HKDF-SHA256 with a fixed `totp-enc-v1` info string. This means
//     rotating SESSION_SECRET WILL invalidate every enrolled user's
//     2FA — surfaced as a one-line LOUD warning at boot.
//
// Wire format for stored secrets (BYTEA in user_totp.secret_encrypted):
//   [12 bytes IV][16 bytes auth tag][N bytes ciphertext]

import crypto from 'node:crypto';
import { generateSecret, generateSync, verifySync, generateURI } from 'otplib';
import qrcode from 'qrcode';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Locked-in TOTP parameters. Stored in the DB row (algorithm/digits/period)
// for forward-compat, but the runtime always uses these — Google
// Authenticator and most apps require SHA1+6+30.
const OTP_OPTS = Object.freeze({
  kind: 'totp',
  algorithm: 'sha1',
  digits: 6,
  step: 30,
  window: 1, // ±1 step (30s) drift tolerance
});

let _cachedKey = null;
function encKey() {
  if (_cachedKey) return _cachedKey;
  const explicit = config.totp.encKey;
  if (explicit) {
    if (!/^[0-9a-f]{64}$/i.test(explicit)) {
      throw new Error('TOTP_ENC_KEY must be 64 hex chars (32 bytes)');
    }
    _cachedKey = Buffer.from(explicit, 'hex');
    return _cachedKey;
  }
  // Dev fallback: HKDF from SESSION_SECRET. LOUD-warn in prod so an
  // operator notices before they rotate SESSION_SECRET and brick MFA.
  if (config.env === 'production') {
    logger.warn(
      { hint: 'set TOTP_ENC_KEY (64 hex chars) — see config.js' },
      'TOTP_ENC_KEY not set in prod, deriving from SESSION_SECRET'
    );
  }
  _cachedKey = crypto.hkdfSync(
    'sha256',
    Buffer.from(config.session.secret, 'utf8'),
    Buffer.alloc(0), // no salt
    Buffer.from('totp-enc-v1', 'utf8'),
    32
  );
  return Buffer.from(_cachedKey);
}

/**
 * Generate a new shared secret. Returns the Base32-encoded form that
 * authenticator apps expect — store it (encrypted) AS-IS so verification
 * can hand it straight back to otplib.
 */
export function generateTotpSecret() {
  return generateSecret();
}

/**
 * Build the otpauth:// URL an authenticator app scans. Label is
 * `${issuer}:${userEmail}` per the Google Authenticator key URI format.
 * (otplib v13 calls the account field `label`.)
 */
export function buildOtpAuthUrl(secret, userEmail) {
  return generateURI({
    secret,
    label: userEmail,
    issuer: config.totp.issuer,
    ...OTP_OPTS,
  });
}

/**
 * Render the otpauth URL as a base64 PNG data URL. Inline-able as an
 * <img src="..."> in the enrollment page. Size is small (~3 KB) so we
 * don't bother with a separate /qr endpoint.
 */
export async function renderQrDataUrl(otpAuthUrl) {
  return qrcode.toDataURL(otpAuthUrl, { errorCorrectionLevel: 'M', margin: 1, scale: 5 });
}

/**
 * Verify a 6-digit code against the stored secret. Returns true/false.
 * Empty/non-string/non-digit inputs return false (uniform timing path —
 * we don't leak "you have no 2FA" via a different code path).
 *
 * Note: otplib's verifySync throws on non-digit tokens, so we pre-filter
 * to /^\d{6}$/ and never let it throw on user input.
 */
export function verifyCode(secret, code) {
  if (typeof secret !== 'string' || typeof code !== 'string') return false;
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    const result = verifySync({ secret, token: cleaned, ...OTP_OPTS });
    return Boolean(result && result.valid);
  } catch {
    return false;
  }
}

/**
 * Generate the current 6-digit code for a secret. Used by the smoke test
 * (test-2fa.sh) to drive the verify endpoint without an authenticator app.
 */
export function generateCurrentCode(secret) {
  return generateSync({ secret, ...OTP_OPTS });
}

// --- AES-256-GCM at-rest encryption -----------------------------------------

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt a UTF-8 string. Returns a Buffer in our wire format. */
export function encryptSecret(plaintextBase32) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintextBase32, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Decrypt a Buffer from the DB back into the Base32 secret. */
export function decryptSecret(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('encrypted secret malformed');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
