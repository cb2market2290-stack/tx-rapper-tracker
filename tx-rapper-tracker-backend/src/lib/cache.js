// src/lib/cache.js
// Two-tier cache for upstream API responses.
//
// L1 (in-process): node-cache. Microsecond hits for hot keys, no DB chatter.
//   TTL: min(L2-TTL, 60s) so we re-check L2 reasonably often and pick up
//   writes from sibling processes within a minute.
//
// L2 (Postgres): the `cache` table. Survives restarts, shared across
//   processes, has its own expires_at column for lazy eviction.
//
// On a miss in both, the loader is invoked exactly once per concurrent
// request set (in-flight collapsing) and the result is written to BOTH
// tiers. On a 502 from upstream YouTube, the loader throws and nothing
// is cached — next request retries.

import NodeCache from 'node-cache';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { logger } from './logger.js';

// L1 TTL is bounded so even hot keys re-validate against Postgres within
// ~60s. Keeps multi-process deploys honest without much overhead.
const L1_TTL_CAP_SECONDS = 60;

const l1 = new NodeCache({
  stdTTL: Math.min(config.cacheTtlSeconds, L1_TTL_CAP_SECONDS),
  checkperiod: 60,
  useClones: false, // we only cache plain JSON we don't mutate
});

const inflight = new Map();

// ---- L2 helpers ----------------------------------------------------------

async function l2Get(key) {
  const { rows } = await query(
    `SELECT value FROM cache WHERE key = $1 AND expires_at > now()`,
    [key]
  );
  return rows.length ? rows[0].value : undefined;
}

async function l2Set(key, value, ttlSeconds) {
  // ON CONFLICT so concurrent writers race safely; last write wins.
  await query(
    `INSERT INTO cache (key, value, expires_at)
     VALUES ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
     ON CONFLICT (key) DO UPDATE
       SET value      = EXCLUDED.value,
           expires_at = EXCLUDED.expires_at,
           created_at = now()`,
    [key, JSON.stringify(value), String(ttlSeconds)]
  );
}

// ---- Public API ---------------------------------------------------------

export function cacheGet(key) {
  // Synchronous L1-only read kept for backwards compat. Most callers should
  // use getOrFetch instead, which checks both tiers.
  return l1.get(key);
}

export async function cacheSet(key, value, ttlSeconds) {
  const ttl = ttlSeconds ?? config.cacheTtlSeconds;
  l1.set(key, value, Math.min(ttl, L1_TTL_CAP_SECONDS));
  try {
    await l2Set(key, value, ttl);
  } catch (err) {
    logger.warn({ err, key }, 'cache: L2 write failed (continuing with L1 only)');
  }
}

/**
 * Two-tier read-through. Returns cached value if present (L1 then L2),
 * otherwise calls loader() exactly once per concurrent miss set, writes
 * the result to both tiers, and returns it.
 *
 * If the L2 write fails (DB transient hiccup) we still return the value —
 * the L1 entry buys us up to L1_TTL_CAP_SECONDS of relief while L2
 * recovers.
 */
export async function getOrFetch(key, loader, ttlSeconds) {
  const l1Hit = l1.get(key);
  if (l1Hit !== undefined) return l1Hit;

  // Try L2. On error, fall through to loader — better than failing the request.
  try {
    const l2Hit = await l2Get(key);
    if (l2Hit !== undefined) {
      l1.set(key, l2Hit, Math.min(ttlSeconds ?? config.cacheTtlSeconds, L1_TTL_CAP_SECONDS));
      return l2Hit;
    }
  } catch (err) {
    logger.warn({ err, key }, 'cache: L2 read failed (falling through to loader)');
  }

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await loader();
      const ttl = ttlSeconds ?? config.cacheTtlSeconds;
      l1.set(key, value, Math.min(ttl, L1_TTL_CAP_SECONDS));
      try {
        await l2Set(key, value, ttl);
      } catch (err) {
        logger.warn({ err, key }, 'cache: L2 write failed after fetch');
      }
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function cacheStats() {
  return l1.getStats();
}

/**
 * Drop expired rows from L2. Call periodically (e.g. via a cron / scheduled
 * task) so the cache table doesn't grow without bound. Idempotent.
 */
export async function sweepExpired() {
  const { rowCount } = await query(`DELETE FROM cache WHERE expires_at <= now()`);
  return rowCount;
}
