// src/routes/insights.js
// Phase 3a.1 — read endpoints over the breakout_signals materialized view.
//
// The "movers" strip on the dashboard is the public-facing funnel hook
// (per PHASE_3_BRAINSTORM.md, Track A → 3a). It needs to be reachable
// without a session so anonymous landing-page visitors see live data and
// not a 401. The platform-wide rate limiter still applies.
//
// Endpoints:
//   GET /api/insights/breakout?limit=5&sortBy=growth[&includePartial=true]
//
// Tradeoffs documented:
//   * sortBy enum kept narrow (3 values) so we can add covering indices
//     for each one in migration 013. New sort modes need both a
//     SORT_CLAUSES entry in services/breakout.js AND a migration.
//   * limit cap=50 is generous on purpose — admins poke the same endpoint
//     while debugging. The frontend dashboard strip uses limit=5.
//   * includePartial is omitted on the public path (hides newly-rostered
//     artists without a 14-day window). Signed-in admins can pass it
//     through; we don't need a separate route for that, the matview is
//     the same shape either way.

import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errorHandler.js';
import { getTopMovers, VALID_SORTS } from '../services/breakout.js';

const router = Router();

// Exported so test/breakout.test.js can validate the schema in isolation
// without booting an Express app.
export const BreakoutQuery = z.object({
  // Default 5 — that's how many slots the dashboard strip renders. Cap at
  // 50 so a rogue query can't drag the whole matview over the wire.
  limit: z.coerce.number().int().min(1).max(50).default(5),
  // Enum mirrors VALID_SORTS in services/breakout.js — keep them in sync.
  sortBy: z.enum(VALID_SORTS).default('growth'),
  // Strings 'true'/'false' coerced to bool. Default false — public movers
  // strip should hide artists we've barely tracked.
  includePartial: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(false)
    .transform((v) => v === true || v === 'true'),
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
 * GET /api/insights/breakout
 * Returns the top N movers, sorted by one of:
 *   growth        — raw 7-day view delta (default)
 *   percentage    — pct growth (rewards small-but-spiking artists)
 *   acceleration  — week-over-week change in raw delta
 *
 * Public endpoint (anonymous OK). Used by:
 *   - Dashboard "Movers this week" strip (frontend)
 *   - Future public profile pages (Phase 3c)
 *   - Saved-search evaluator (Phase 3a.3) reuses the service directly,
 *     not this HTTP route.
 */
router.get('/breakout', async (req, res, next) => {
  try {
    const q = parse(BreakoutQuery, req.query);
    const rows = await getTopMovers(q);
    res.json({
      kind: 'insights.breakout',
      sortBy: q.sortBy,
      limit: q.limit,
      includePartial: q.includePartial,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
