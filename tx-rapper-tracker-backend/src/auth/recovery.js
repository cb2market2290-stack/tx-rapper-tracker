// src/auth/recovery.js
// Recovery codes for the TOTP 2FA flow. The user gets 10 plaintext
// codes once at enrollment time (or on regenerate); each is consumable
// exactly once when the authenticator app is unavailable.
//
// Format: 5 alphanumeric chunks of 4 chars separated by hyphens, e.g.
//   "XW3K-9PR2-VHQM-A4ZN-LE8T"
// = 20 chars × log2(32) = ~100 bits of entropy. Plenty for one-time use.
//
// Storage:
//   * Plaintext shown to user ONCE at generation. Never persisted.
//   * Argon2id hash stored in user_recovery_codes.code_hash. Same params
//     as password hashes — these unlock the account, treat them like one.
//   * consumed_at = now() on use. The check-and-mark is one transaction
//     so a code can't be redeemed twice in a race.

import crypto from 'node:crypto';
import argon2 from 'argon2';
import { query, withTransaction } from '../db/pool.js';

// Crockford-style alphabet: no I/L/O/0/1/U to avoid OCR/typing confusion.
const ALPHA = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CHUNKS = 5;
const CHUNK_LEN = 4;
const TOTAL_PER_USER = 10;

const HASH_OPTS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

/** One human-readable code — see header for format. */
function makeCode() {
  const buf = crypto.randomBytes(CHUNKS * CHUNK_LEN);
  const chars = Array.from(buf, (b) => ALPHA[b % ALPHA.length]);
  const out = [];
  for (let i = 0; i < CHUNKS; i++) {
    out.push(chars.slice(i * CHUNK_LEN, (i + 1) * CHUNK_LEN).join(''));
  }
  return out.join('-');
}

/**
 * Generate fresh codes for a user, replacing any previous batch. Returns
 * the plaintext codes (caller MUST surface these to the user once and
 * never log them). Use inside a transaction so an error doesn't leave
 * the user with a half-burned set.
 */
export async function regenerateCodes(userId) {
  const codes = Array.from({ length: TOTAL_PER_USER }, () => makeCode());
  const hashes = await Promise.all(codes.map((c) => argon2.hash(c, HASH_OPTS)));
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM user_recovery_codes WHERE user_id = $1`,
      [userId]
    );
    // Multi-row insert via UNNEST keeps it to one round-trip.
    await client.query(
      `INSERT INTO user_recovery_codes (user_id, code_hash)
         SELECT $1, hash FROM unnest($2::text[]) AS t(hash)`,
      [userId, hashes]
    );
  });
  return codes;
}

/** Count of unused codes — surfaced in /api/auth/me so UI can warn at 1-2 left. */
export async function remainingCount(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM user_recovery_codes
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId]
  );
  return rows[0]?.n || 0;
}

/**
 * Atomically consume a code: returns true and marks consumed_at if the
 * plaintext matches a stored unconsumed hash, false otherwise.
 *
 * We have to read every unconsumed hash for this user (Argon2 has no
 * deterministic output we could index on), but with TOTAL_PER_USER=10
 * that's at most 10 verifications worst-case — well under the auth
 * budget for a single login attempt.
 */
export async function consumeCode(userId, plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  const cleaned = plaintext.trim().toUpperCase();
  return withTransaction(async (client) => {
    // FOR UPDATE so a concurrent verify on the same code can't double-spend.
    const { rows } = await client.query(
      `SELECT id, code_hash
         FROM user_recovery_codes
        WHERE user_id = $1 AND consumed_at IS NULL
        FOR UPDATE`,
      [userId]
    );
    for (const row of rows) {
      let ok = false;
      try { ok = await argon2.verify(row.code_hash, cleaned); } catch { /* ignore */ }
      if (ok) {
        await client.query(
          `UPDATE user_recovery_codes SET consumed_at = now() WHERE id = $1`,
          [row.id]
        );
        return true;
      }
    }
    return false;
  });
}

/**
 * Forget every code for a user. Called when 2FA is disabled — leaving
 * old codes in place would mean re-enabling 2FA implicitly trusts the
 * previous batch.
 */
export async function clearAll(userId) {
  await query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
}
