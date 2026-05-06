import crypto from 'node:crypto';
import { sql } from '../db/pool.js';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateToken() {
  const raw = 'txrt_' + crypto.randomBytes(32).toString('hex');
  return raw;
}

export async function createToken(userId, label = null) {
  // Revoke any existing active token for this user
  await sql`
    UPDATE api_tokens SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
  const raw = generateToken();
  const hash = hashToken(raw);
  const prefix = raw.slice(0, 12);
  const [row] = await sql`
    INSERT INTO api_tokens (user_id, token_hash, prefix, label)
    VALUES (${userId}, ${hash}, ${prefix}, ${label})
    RETURNING id, prefix, created_at
  `;
  return { token: raw, prefix: row.prefix, id: row.id, created_at: row.created_at };
}

export async function listTokens(userId) {
  return sql`
    SELECT id, prefix, label, created_at, last_used_at, revoked_at
    FROM api_tokens
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
}

export async function revokeToken(userId, tokenId) {
  const [row] = await sql`
    UPDATE api_tokens SET revoked_at = now()
    WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `;
  return row ?? null;
}

export async function verifyToken(raw) {
  if (!raw || !raw.startsWith('txrt_')) return null;
  const hash = hashToken(raw);
  const [row] = await sql`
    SELECT id, user_id FROM api_tokens
    WHERE token_hash = ${hash} AND revoked_at IS NULL
  `;
  if (!row) return null;
  // Update last_used_at async — don't await
  sql`UPDATE api_tokens SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {});
  return row;
}
