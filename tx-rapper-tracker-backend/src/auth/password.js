// src/auth/password.js
// Argon2id password hashing. Only touch this file if you know what you're
// doing — the params below are tuned for a server, not a laptop script.
//
// Why Argon2id (not bcrypt / PBKDF2 / scrypt):
//   * Winner of the 2015 Password Hashing Competition.
//   * Hybrid "id" variant resists both side-channel and GPU attacks.
//   * OWASP's top recommendation as of 2026.
//
// Parameter notes (OWASP baseline — tune up, never down):
//   * memoryCost: 19 MiB per hash   (19456 KiB)
//   * timeCost:   2 iterations
//   * parallelism: 1
// These yield ~50ms per hash on a mid-range CPU. That's slow enough to
// hurt attackers, fast enough that legitimate logins feel instant.

import argon2 from 'argon2';

const HASH_OPTS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

/** Hash a plaintext password. Returns the full encoded string — store AS-IS. */
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('password required');
  }
  return argon2.hash(plain, HASH_OPTS);
}

/**
 * Verify a password against a stored hash.
 * Returns true on match, false otherwise.
 * If `hash` is malformed, we swallow the error and return false so timing
 * stays uniform — we don't want to leak "valid user, wrong password" via
 * a different code path than "unknown user".
 */
export async function verifyPassword(hash, plain) {
  if (typeof hash !== 'string' || typeof plain !== 'string') return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * True if the stored hash was made with weaker params than HASH_OPTS.
 * Call after a successful verify() to decide whether to re-hash on login.
 */
export function needsRehash(hash) {
  if (typeof hash !== 'string') return true;
  try {
    return argon2.needsRehash(hash, HASH_OPTS);
  } catch {
    return true;
  }
}
