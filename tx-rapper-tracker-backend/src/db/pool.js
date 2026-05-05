// src/db/pool.js
// Single shared Postgres connection pool for the app.
//
// Why a pool and not one client per request:
//   * Creating a TCP + TLS connection per query is expensive.
//   * Postgres has a hard max_connections limit; a pool bounds us under it.
//   * `pg` re-uses idle clients automatically.
//
// Never log `config.databaseUrl` directly — it can contain credentials.
// Use `redacted()` from config.js when you need to print startup info.

import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

// Pool sized for the realistic load on this stack: snapshot cron +
// digest cron + a few hundred concurrent dashboard / public-page
// users. 30 is comfortable headroom against Postgres' default
// max_connections=100; we keep ~70 for psql, the audio-extract
// worker, and other ad-hoc tools.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 30,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // ssl: undefined by default — local dev is plaintext. For managed Postgres
  // (Supabase / Neon / RDS) set ?sslmode=require in DATABASE_URL.
});

pool.on('error', (err) => {
  // An idle client threw. Log it but keep the process alive — pg will
  // evict the bad client on its own.
  logger.error({ err }, 'pg idle client error');
});

/**
 * Convenience wrapper: run a parameterised query and return rows.
 * Always use $1, $2 placeholders — NEVER string-interpolate user input.
 */
export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

/**
 * Run a function inside a transaction. Rolls back on throw.
 * Usage:
 *   await withTransaction(async (client) => {
 *     await client.query('INSERT ...');
 *     await client.query('UPDATE ...');
 *   });
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool — call from shutdown handlers. */
export async function closePool() {
  await pool.end();
}
