// src/services/breakout.js
// Phase 3a.1 — breakout signals.
//
// Thin service layer over the breakout_signals materialized view. The
// view does the heavy lifting (see migrations/013_breakout_signals.sql);
// this module is the JS-side contract for refreshing it and reading it
// back in the shapes the API + frontend need.
//
// Public surface:
//   refreshBreakoutSignals()         — REFRESH ... CONCURRENTLY wrapper.
//                                      Idempotent. Safe to call from a
//                                      background cron or from the snapshot
//                                      script after the daily upserts land.
//   getTopMovers({limit, sortBy})    — top N rows of the matview, sorted by
//                                      one of three movement metrics, with
//                                      has_full_window pre-filtered.
//   getAllSignals({includePartial})  — full set, used by admin and tests.
//
// Sort modes (sortBy):
//   'growth'        — raw view delta (default; rewards big artists)
//   'percentage'    — pct delta (rewards small artists with big jumps)
//   'acceleration'  — week-over-week change in raw delta (still picking
//                     up vs cooling off)

import { query } from '../db/pool.js';

const SORT_CLAUSES = {
  growth: 'view_growth_7d DESC NULLS LAST',
  percentage: 'pct_growth_7d DESC NULLS LAST',
  acceleration: 'acceleration_7d DESC NULLS LAST',
};

export const VALID_SORTS = Object.keys(SORT_CLAUSES);

/**
 * REFRESH MATERIALIZED VIEW CONCURRENTLY breakout_signals.
 *
 * CONCURRENTLY keeps reads going during the rebuild — the unique index
 * on artist_id (created in migration 013) makes that legal. If the
 * view's never been refreshed before, CONCURRENTLY errors; the migration
 * does an initial REFRESH to seed it so this is safe in practice.
 *
 * Errors propagate. The snapshot script logs+swallows so a refresh
 * failure doesn't tank the whole snapshot run.
 */
export async function refreshBreakoutSignals() {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY breakout_signals');
  return { refreshed: true };
}

/**
 * @param {object} opts
 * @param {number} [opts.limit=5]      How many rows to return (1..50).
 * @param {string} [opts.sortBy='growth']
 *                                     One of VALID_SORTS.
 * @param {boolean} [opts.includePartial=false]
 *                                     If true, includes artists without
 *                                     a full 14-day window. Default false
 *                                     so the dashboard strip doesn't show
 *                                     newly-rostered artists with NULL
 *                                     velocity.
 * @returns {Promise<Array>} Rows from breakout_signals.
 */
export async function getTopMovers({
  limit = 5,
  sortBy = 'growth',
  includePartial = false,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('limit must be an integer in [1, 50]');
  }
  const orderClause = SORT_CLAUSES[sortBy];
  if (!orderClause) {
    throw new Error(`sortBy must be one of: ${VALID_SORTS.join(', ')}`);
  }
  const where = includePartial ? '' : 'WHERE has_full_window';
  const { rows } = await query(
    `SELECT artist_id,
            artist_name,
            as_of,
            views_now,
            views_7d_ago,
            views_14d_ago,
            view_growth_7d,
            pct_growth_7d,
            acceleration_7d,
            has_full_window,
            computed_at
       FROM breakout_signals
       ${where}
       ORDER BY ${orderClause}
       LIMIT $1`,
    [limit]
  );
  return rows.map(shapeRow);
}

/**
 * Return every row, with no filtering. Used by admin endpoints and tests.
 * Same shape as getTopMovers.
 */
export async function getAllSignals() {
  const { rows } = await query(
    `SELECT artist_id, artist_name, as_of,
            views_now, views_7d_ago, views_14d_ago,
            view_growth_7d, pct_growth_7d, acceleration_7d,
            has_full_window, computed_at
       FROM breakout_signals
       ORDER BY artist_name ASC`
  );
  return rows.map(shapeRow);
}

/**
 * Pure shaping — converts the snake_case row from PG into the camelCase
 * the API + frontend speak. Number coercion handles the BIGINT-as-string
 * quirk from node-postgres so the JSON is consistently typed.
 */
export function shapeRow(r) {
  return {
    artistId: r.artist_id,
    artistName: r.artist_name,
    asOf: r.as_of,
    viewsNow: numOrNull(r.views_now),
    views7dAgo: numOrNull(r.views_7d_ago),
    views14dAgo: numOrNull(r.views_14d_ago),
    viewGrowth7d: numOrNull(r.view_growth_7d),
    pctGrowth7d: r.pct_growth_7d == null ? null : Number(r.pct_growth_7d),
    acceleration7d: numOrNull(r.acceleration_7d),
    hasFullWindow: !!r.has_full_window,
    computedAt: r.computed_at,
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
