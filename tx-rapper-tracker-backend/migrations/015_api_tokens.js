import { sql } from '../src/db/pool.js';

export async function up() {
  await sql`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      prefix       TEXT NOT NULL,
      label        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS api_tokens_token_hash_idx ON api_tokens(token_hash)`;
  console.log('015_api_tokens: up');
}

export async function down() {
  await sql`DROP TABLE IF EXISTS api_tokens`;
  console.log('015_api_tokens: down');
}
