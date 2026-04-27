// src/services/savedsearches.js
// Phase 3a.2 — saved searches CRUD + tier-capped quotas.
//
// A saved search is a user-owned alert predicate against breakout_signals
// (and the lifetime_views passthrough). The 3a.3 evaluator walks every
// enabled row each snapshot cycle and emails the owner when the predicate
// trips (with a one-email-per-search-per-day cap).
//
// This module is the JS contract over migrations/014_saved_searches.sql.
// It's organised so the bits that DON'T touch the DB live up top and
// can be unit-tested without a live Postgres:
//
//   * Pure validation (VALID_METRICS / VALID_COMPARATORS, threshold
//     range checks per metric, normalizePayload).
//   * Tier-cap math (TIER_CAPS, capForPlanSlug, isOverCap).
//   * shapeRow snake→camel conversion.
//
// Then the DB-touching getters/mutators follow.
//
// Tier caps: Free 1, Pro 5, Premium unlimited. Caps live here in JS, not
// in the DB — changing them is a deploy not a migration. The "paid"
// back-compat slug (a paying sub whose price_id isn't in pricing_tiers)
// is treated as Pro for capping purposes: better to give a paying user
// the higher cap than the lower one if the operator hasn't seeded yet.
//
// Public surface:
//   TIER_CAPS                                — slug → cap (or null=∞)
//   VALID_METRICS, VALID_COMPARATORS         — enums
//   capForPlanSlug(slug)                     — lookup with sensible fallback
//   normalizePayload(input)                  — pure validate + coerce; throws ValidationError
//   shapeRow(r)                              — snake → camel
//   listForUser(userId)                      — owner-scoped list, newest first
//   countForUser(userId)                     — for tier-cap math
//   getByIdForUser(userId, id)               — owner-scoped get (404 → null)
//   create(userId, planSlug, payload)        — enforces cap, throws TierCapError
//   update(userId, id, patch)                — owner-scoped patch, null on not-found
//   remove(userId, id)                       — owner-scoped delete, bool returned

import { query } from '../db/pool.js';

// ---------------------------------------------------------------------------
// Custom error types — let the route layer translate them to specific
// HTTP responses without overloading HttpError's `code` field.
// ---------------------------------------------------------------------------

/**
 * Validation failure (bad metric, threshold out of range, etc). Routes
 * map this to HTTP 400.
 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.kind = 'savedsearches.validation';
  }
}

/**
 * User has hit their tier cap. Routes map this to HTTP 403 with a
 * payload the frontend can render into an upgrade nudge.
 */
export class TierCapError extends Error {
  constructor({ planSlug, cap, count }) {
    super(
      `tier cap reached: ${planSlug} allows ${cap} saved searches (you have ${count})`
    );
    this.name = 'TierCapError';
    this.kind = 'savedsearches.tier_cap';
    this.planSlug = planSlug;
    this.cap = cap;
    this.count = count;
  }
}

// ---------------------------------------------------------------------------
// Constants — kept in lock-step with migration 014's CHECK constraints.
// If you add a metric or comparator here you must also update the CHECK
// (and the 3a.3 evaluator will need a branch for any new metric).
// ---------------------------------------------------------------------------

export const VALID_METRICS = Object.freeze([
  'view_growth_7d',     // raw delta (lifetime views, 7-day window)
  'pct_growth_7d',      // pct delta (0.05 = +5%)
  'acceleration_7d',    // week-over-week change in raw delta
  'lifetime_views',     // raw lifetime view count (passthrough, not a delta)
]);

export const VALID_COMPARATORS = Object.freeze(['>', '>=', '<', '<=']);

/**
 * Tier caps. null = unlimited. Source of truth for "how many saved
 * searches this user is allowed to have". Mirrored against active_user_plan
 * at create-time.
 *
 * Why the 'paid' back-compat fallback maps to Pro: an operator may
 * provision a Stripe price that isn't yet in pricing_tiers — until they
 * run the seeder, paying users land in plan_slug='paid' rank=99. Caps
 * shouldn't disappear in that gap, but they shouldn't unlock Premium
 * either (that'd let a Pro-priced sub get Premium quotas). Treat as Pro.
 */
export const TIER_CAPS = Object.freeze({
  free: 1,
  pro: 5,
  paid: 5,        // back-compat: unmapped paying sub → treat as Pro for caps
  premium: null,  // unlimited
});

/**
 * Look up the cap for a plan slug. Falls back to the free cap on
 * unknown slugs — fail-closed, never accidentally grant unlimited.
 */
export function capForPlanSlug(slug) {
  if (slug == null) return TIER_CAPS.free;
  return Object.prototype.hasOwnProperty.call(TIER_CAPS, slug)
    ? TIER_CAPS[slug]
    : TIER_CAPS.free;
}

/**
 * Has this user already hit (or exceeded) the cap for their plan?
 * cap===null means unlimited, so always returns false.
 */
export function isOverCap({ planSlug, count }) {
  const cap = capForPlanSlug(planSlug);
  if (cap == null) return false;
  return count >= cap;
}

// ---------------------------------------------------------------------------
// Per-metric threshold range checks. The DB stores threshold as DOUBLE
// PRECISION which means "any number, no constraint". We refuse obviously
// nonsensical thresholds before the row hits Postgres so the 3a.3
// evaluator never has to reason about them.
//
// Ranges:
//   view_growth_7d   — non-negative integer-ish (you can't have less
//                      than zero growth as an alert threshold; that's
//                      what "<" comparator is for, with a positive value).
//                      Wait — the comparator handles direction. A user
//                      could legitimately set "alert when growth < -100k"
//                      to catch falling artists. So this one is unbounded.
//   pct_growth_7d    — DB stores as ratio (0.05 = +5%). User-facing API
//                      accepts the same. Range [-1, 100] catches
//                      reasonable values: -100% (artist lost everything)
//                      to +10000% (a viral hit). Anything outside is
//                      almost certainly a unit confusion (pct vs ratio).
//   acceleration_7d  — Same story as view_growth_7d. Unbounded.
//   lifetime_views   — Must be non-negative; nothing has fewer than 0
//                      views.
// ---------------------------------------------------------------------------

const THRESHOLD_RANGES = {
  view_growth_7d:   { min: -1e12, max: 1e12 },   // sanity bounds only
  pct_growth_7d:    { min: -1, max: 100 },        // ratio
  acceleration_7d:  { min: -1e12, max: 1e12 },
  lifetime_views:   { min: 0, max: 1e15 },
};

function validateThresholdForMetric(metric, threshold) {
  const r = THRESHOLD_RANGES[metric];
  if (!r) return; // unreachable if metric was validated first
  if (!Number.isFinite(threshold)) {
    throw new ValidationError(`threshold must be a finite number`);
  }
  if (threshold < r.min || threshold > r.max) {
    throw new ValidationError(
      `threshold ${threshold} out of range for metric '${metric}' (${r.min}…${r.max})`
    );
  }
}

// ---------------------------------------------------------------------------
// Pure validation — pre-DB shaping. Routes pass req.body through this
// before either INSERT (full payload required) or UPDATE (any subset
// allowed). The shape it returns is exactly what the SQL expects.
// ---------------------------------------------------------------------------

/**
 * Validate + coerce a CREATE payload. Caller has already established
 * the user is authenticated.
 *
 * Required: name, metric, threshold, comparator
 * Optional: artistId, enabled (defaults true)
 *
 * Returns { name, metric, threshold, comparator, artistId, enabled }.
 * Throws ValidationError on any problem.
 */
export function normalizeCreatePayload(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('payload must be an object');
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 80) {
    throw new ValidationError('name must be 1–80 chars after trimming');
  }

  const metric = input.metric;
  if (!VALID_METRICS.includes(metric)) {
    throw new ValidationError(
      `metric must be one of: ${VALID_METRICS.join(', ')}`
    );
  }

  const comparator = input.comparator;
  if (!VALID_COMPARATORS.includes(comparator)) {
    throw new ValidationError(
      `comparator must be one of: ${VALID_COMPARATORS.join(', ')}`
    );
  }

  // Accept numbers and numeric strings — Express doesn't coerce JSON
  // bodies but a curl smoke might send "0.05".
  const threshold = typeof input.threshold === 'string'
    ? Number(input.threshold)
    : input.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new ValidationError('threshold must be a finite number');
  }
  validateThresholdForMetric(metric, threshold);

  // artistId is optional. null/undefined/empty-string all mean "any
  // artist" (the breakout-list watch). Otherwise must look like a UUID.
  let artistId = null;
  if (input.artistId != null && input.artistId !== '') {
    if (typeof input.artistId !== 'string' || !UUID_RE.test(input.artistId)) {
      throw new ValidationError('artistId must be a UUID or null');
    }
    artistId = input.artistId;
  }

  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);

  return { name, metric, threshold, comparator, artistId, enabled };
}

/**
 * Validate + coerce an UPDATE patch. Every field is optional but at
 * least one must be present. Returns the validated subset for SET …
 *
 * Throws ValidationError on any problem.
 */
export function normalizeUpdatePayload(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('payload must be an object');
  }
  const out = {};

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 80) {
      throw new ValidationError('name must be 1–80 chars after trimming');
    }
    out.name = name;
  }

  if (input.metric !== undefined) {
    if (!VALID_METRICS.includes(input.metric)) {
      throw new ValidationError(
        `metric must be one of: ${VALID_METRICS.join(', ')}`
      );
    }
    out.metric = input.metric;
  }

  if (input.comparator !== undefined) {
    if (!VALID_COMPARATORS.includes(input.comparator)) {
      throw new ValidationError(
        `comparator must be one of: ${VALID_COMPARATORS.join(', ')}`
      );
    }
    out.comparator = input.comparator;
  }

  if (input.threshold !== undefined) {
    const t = typeof input.threshold === 'string'
      ? Number(input.threshold)
      : input.threshold;
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new ValidationError('threshold must be a finite number');
    }
    // We can only range-check threshold against a known metric. If the
    // patch also changes metric, validate against the new one; if it
    // doesn't, the route layer must read the row first and pass the
    // current metric. Here we accept the patch and let the caller pass
    // _metricContext via a second arg if needed; otherwise we do the
    // basic finite check only.
    out.threshold = t;
  }

  if (input.artistId !== undefined) {
    if (input.artistId === null || input.artistId === '') {
      out.artistId = null;
    } else if (typeof input.artistId === 'string' && UUID_RE.test(input.artistId)) {
      out.artistId = input.artistId;
    } else {
      throw new ValidationError('artistId must be a UUID or null');
    }
  }

  if (input.enabled !== undefined) {
    out.enabled = Boolean(input.enabled);
  }

  if (Object.keys(out).length === 0) {
    throw new ValidationError('patch must include at least one field');
  }
  return out;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shape — DB row (snake_case) → API JSON (camelCase). Numbers are
// coerced because node-pg returns BIGINTs as strings.
// ---------------------------------------------------------------------------

export function shapeRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    metric: r.metric,
    threshold: r.threshold == null ? null : Number(r.threshold),
    comparator: r.comparator,
    artistId: r.artist_id,
    enabled: !!r.enabled,
    lastAlertedAt: r.last_alerted_at,
    lastMatchArtistId: r.last_match_artist_id,
    lastMatchValue:
      r.last_match_value == null ? null : Number(r.last_match_value),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// DB-touching paths
// ---------------------------------------------------------------------------

/**
 * List all saved searches owned by this user, newest first.
 */
export async function listForUser(userId) {
  if (!userId) return [];
  const { rows } = await query(
    `SELECT id, user_id, name, metric, threshold, comparator,
            artist_id, enabled,
            last_alerted_at, last_match_artist_id, last_match_value,
            created_at, updated_at
       FROM saved_searches
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [userId]
  );
  return rows.map(shapeRow);
}

/**
 * Count saved searches owned by this user — for tier-cap math.
 * Counts disabled rows too: pausing a search doesn't free a slot.
 */
export async function countForUser(userId) {
  if (!userId) return 0;
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM saved_searches WHERE user_id = $1`,
    [userId]
  );
  return rows[0]?.n ?? 0;
}

/**
 * Look up one saved search by id, scoped to the owner. Returns null
 * if either the row doesn't exist or it belongs to a different user
 * (we deliberately don't differentiate — same shape as a 404).
 */
export async function getByIdForUser(userId, id) {
  if (!userId || !id || !UUID_RE.test(id)) return null;
  const { rows } = await query(
    `SELECT id, user_id, name, metric, threshold, comparator,
            artist_id, enabled,
            last_alerted_at, last_match_artist_id, last_match_value,
            created_at, updated_at
       FROM saved_searches
      WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] ? shapeRow(rows[0]) : null;
}

/**
 * Create a saved search. The cap check is a count(*)+threshold compare
 * BEFORE the INSERT — there's no race-free way to enforce it in the DB
 * without a unique constraint we don't want, but the worst case under
 * concurrent inserts is one user gets cap+1 rows for a moment, and that
 * resolves itself when they delete or upgrade.
 *
 * On cap exceeded throws TierCapError. On bad payload throws
 * ValidationError. On DB problem the underlying error propagates.
 */
export async function create(userId, planSlug, input) {
  if (!userId) throw new ValidationError('userId required');
  const data = normalizeCreatePayload(input);

  const cap = capForPlanSlug(planSlug);
  if (cap != null) {
    const count = await countForUser(userId);
    if (count >= cap) {
      throw new TierCapError({ planSlug, cap, count });
    }
  }

  const { rows } = await query(
    `INSERT INTO saved_searches
       (user_id, name, metric, threshold, comparator, artist_id, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, name, metric, threshold, comparator,
               artist_id, enabled,
               last_alerted_at, last_match_artist_id, last_match_value,
               created_at, updated_at`,
    [
      userId,
      data.name,
      data.metric,
      data.threshold,
      data.comparator,
      data.artistId,
      data.enabled,
    ]
  );
  return shapeRow(rows[0]);
}

/**
 * Patch fields on a saved search owned by this user. Returns the
 * shaped row, or null if no row matched (404 territory).
 *
 * If the patch changes `metric` we re-range-check the threshold against
 * the NEW metric (using the current row's threshold if not also patched).
 * That keeps "metric=lifetime_views, threshold=-1" rejected even when
 * threshold isn't explicitly in the patch.
 */
export async function update(userId, id, input) {
  if (!userId || !id || !UUID_RE.test(id)) return null;
  const patch = normalizeUpdatePayload(input);

  // If metric is changing, re-validate threshold range against the
  // new metric. Pull current row if we need its threshold to compare.
  if (patch.metric !== undefined) {
    let thresh = patch.threshold;
    if (thresh === undefined) {
      const cur = await getByIdForUser(userId, id);
      if (!cur) return null;
      thresh = cur.threshold;
    }
    validateThresholdForMetric(patch.metric, thresh);
  } else if (patch.threshold !== undefined) {
    // Threshold patched but metric stayed the same — re-range-check
    // against the existing metric.
    const cur = await getByIdForUser(userId, id);
    if (!cur) return null;
    validateThresholdForMetric(cur.metric, patch.threshold);
  }

  // Build a dynamic SET clause. Allowlist of patchable columns guards
  // against accidental column-name leakage from the keys.
  const colMap = {
    name: 'name',
    metric: 'metric',
    threshold: 'threshold',
    comparator: 'comparator',
    artistId: 'artist_id',
    enabled: 'enabled',
  };
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = colMap[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) return null; // unreachable — normalize threw

  params.push(id, userId);
  const { rows } = await query(
    `UPDATE saved_searches
        SET ${sets.join(', ')}
      WHERE id = $${params.length - 1}
        AND user_id = $${params.length}
      RETURNING id, user_id, name, metric, threshold, comparator,
                artist_id, enabled,
                last_alerted_at, last_match_artist_id, last_match_value,
                created_at, updated_at`,
    params
  );
  return rows[0] ? shapeRow(rows[0]) : null;
}

/**
 * Delete a saved search owned by this user. Returns true iff a row
 * was actually removed (false → 404 in the route).
 */
export async function remove(userId, id) {
  if (!userId || !id || !UUID_RE.test(id)) return false;
  const { rowCount } = await query(
    `DELETE FROM saved_searches WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rowCount > 0;
}
