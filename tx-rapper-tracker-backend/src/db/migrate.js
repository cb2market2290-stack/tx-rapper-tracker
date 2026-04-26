// src/db/migrate.js
// Tiny forward-only migration runner.
//
// How it works:
//   * Every .sql file under ./migrations/ is a step, sorted lexicographically.
//   * We track applied filenames in a `schema_migrations` table.
//   * Each migration runs inside its own transaction. A failing migration
//     rolls back cleanly and the process exits non-zero.
//
// Run with:
//   node src/db/migrate.js
//
// This is intentionally minimal — no "down" migrations, no checksums.
// If a migration is wrong, write a NEW migration that fixes it.
// That keeps production and dev databases in lockstep.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, withTransaction, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function listPending() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 001_, 002_, ... — lexicographic == chronological

  const { rows } = await pool.query(
    'SELECT filename FROM schema_migrations'
  );
  const applied = new Set(rows.map((r) => r.filename));
  return files.filter((f) => !applied.has(f));
}

export async function runMigrations() {
  await ensureTrackingTable();
  const pending = await listPending();

  if (pending.length === 0) {
    logger.info('no pending migrations');
    return { applied: [] };
  }

  const applied = [];
  for (const filename of pending) {
    const full = path.join(MIGRATIONS_DIR, filename);
    const sql = await readFile(full, 'utf8');
    logger.info({ filename }, 'applying migration');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename]
      );
    });
    applied.push(filename);
  }

  logger.info({ applied }, 'migrations complete');
  return { applied };
}

// CLI mode: node src/db/migrate.js
const isDirectRun = (() => {
  const entryHref = process.argv[1]
    ? new URL(`file://${path.resolve(process.argv[1])}`).href
    : null;
  return entryHref === import.meta.url;
})();

if (isDirectRun) {
  runMigrations()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'migration failed');
      await closePool().catch(() => {});
      process.exit(1);
    });
}
