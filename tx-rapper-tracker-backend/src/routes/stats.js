// src/routes/stats.js
// Read endpoints for historical artist stats. The data is populated by
// scripts/snapshot-stats.js running on a daily schedule.
//
// Today's "chart" is a single row per artist; after N days it's a real
// N-point time series. The frontend falls back to a synthetic curve if
// the response is empty, so this endpoint can return {rows: []} safely.

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { HttpError } from '../middleware/errorHandler.js';

const router = Router();

// Exported for test/stats.test.js — the route handler is a thin shim around
// this schema, so validating the schema gives us most of the coverage.
export const HistoryQuery = z.object({
  artist: z.string().trim().min(1).max(200),
  // 365 is the "1-year chart" default. Cap at 2y so a rogue query can't
  // stream unlimited rows. Floor at 1 to keep the SQL predictable.
  days: z.coerce.number().int().min(1).max(730).default(365),
});

function parse(schema, input) {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(
      400,
      'bad_request',
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
  }
  return r.data;
}

/**
 * GET /api/stats/history?artist=Megan+Thee+Stallion&days=365
 * Returns rows oldest-first so the frontend can plot directly.
 */
router.get('/history', async (req, res, next) => {
  try {
    const q = parse(HistoryQuery, req.query);
    const { rows } = await query(
      `SELECT captured_on::text AS day, subs, lifetime_views
         FROM artist_stats_daily
        WHERE artist_name = $1
          AND captured_on >= current_date - ($2::int || ' days')::interval
        ORDER BY captured_on ASC`,
      [q.artist, q.days]
    );
    res.json({
      kind: 'stats.history',
      artist: q.artist,
      days: q.days,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stats/freshness
 * Small summary of how current the snapshot data is. The frontend uses this
 * to render a "Data as of <date>" badge in the header so users can see at a
 * glance whether the 04:00 cron is still healthy.
 *
 * Shape: { kind, latestDay, artistsOnLatest, totalArtistsTracked, hoursSinceLatest }
 * latestDay is null if the table is empty (snapshot has never run).
 */
router.get('/freshness', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `WITH latest AS (
         SELECT MAX(captured_on) AS day FROM artist_stats_daily
       )
       SELECT
         (SELECT day FROM latest)::text                                      AS latest_day,
         (SELECT COUNT(DISTINCT artist_name) FROM artist_stats_daily
            WHERE captured_on = (SELECT day FROM latest))::int               AS artists_on_latest,
         (SELECT COUNT(DISTINCT artist_name) FROM artist_stats_daily)::int   AS total_artists_tracked,
         CASE WHEN (SELECT day FROM latest) IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (now() - (SELECT day FROM latest)::timestamp)) / 3600.0
         END                                                                 AS hours_since_latest`
    );
    const r = rows[0] || {};
    res.json({
      kind: 'stats.freshness',
      latestDay: r.latest_day || null,
      artistsOnLatest: r.artists_on_latest || 0,
      totalArtistsTracked: r.total_artists_tracked || 0,
      hoursSinceLatest: r.hours_since_latest == null ? null : Math.round(Number(r.hours_since_latest) * 10) / 10,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
