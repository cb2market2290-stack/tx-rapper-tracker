// src/routes/saved-searches.js
// Phase 3a.2 — saved searches CRUD endpoints.
//
// All endpoints require a session (mounted under requireUser() in
// src/index.js). They are owner-scoped — every read/write filters by
// req.user.id, so user A can never list, read, patch, or delete user B's
// rows.
//
// Endpoints:
//   GET    /api/saved-searches              List own + tier info
//   GET    /api/saved-searches/:id          Get one (404 on not-yours)
//   POST   /api/saved-searches              Create (403 on cap exceeded)
//   PATCH  /api/saved-searches/:id          Patch any subset of fields
//   DELETE /api/saved-searches/:id          Delete (404 on not-yours)
//
// Tier-cap response (403):
//   { kind:'savedsearches.tier_cap', planSlug, cap, count, ... }
// Frontend dispatches on `kind` to render the upgrade nudge.
//
// Why no zod here: the validation surface is owned by services/savedsearches.js
// (normalizeCreatePayload + normalizeUpdatePayload). Keeping it in one
// place means tests don't have to assert the same rules twice. A bad
// payload throws ValidationError → mapped to 400 below.

import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { getPlanForUser } from '../services/stripe.js';
import {
  capForPlanSlug,
  countForUser,
  create,
  getByIdForUser,
  listForUser,
  remove,
  TierCapError,
  update,
  ValidationError,
} from '../services/savedsearches.js';

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toHttp(err) {
  if (err instanceof ValidationError) {
    return new HttpError(400, 'bad_request', err.message);
  }
  return err;
}

/**
 * GET /api/saved-searches
 *
 * Returns the list of saved searches owned by the current user, plus
 * tier-context the frontend needs to render the "X of Y used" line and
 * decide whether the "New" button is disabled. Doing it in one round
 * trip saves a second request from the dashboard on every page load.
 */
router.get('/', async (req, res, next) => {
  try {
    const [rows, plan] = await Promise.all([
      listForUser(req.user.id),
      getPlanForUser(req.user.id),
    ]);
    const cap = capForPlanSlug(plan?.planSlug);
    res.json({
      kind: 'savedsearches.list',
      planSlug: plan?.planSlug || 'free',
      planDisplayName: plan?.planDisplayName || 'Free',
      cap,                  // null = unlimited
      count: rows.length,
      atCap: cap != null && rows.length >= cap,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/saved-searches/:id
 *
 * Owner-scoped. We don't differentiate "not found" from "not yours" —
 * 404 either way to avoid leaking the existence of someone else's row.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, 'bad_request', 'id must be a UUID');
    }
    const row = await getByIdForUser(req.user.id, id);
    if (!row) {
      throw new HttpError(404, 'not_found', 'saved search not found');
    }
    res.json({ kind: 'savedsearches.get', row });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/saved-searches
 *
 * Body: { name, metric, threshold, comparator, artistId?, enabled? }
 *
 * On cap exceeded: 403 with the tier-cap payload so the frontend can
 * swap in an upgrade card. We do NOT use 402 here — that status is
 * reserved for "you need to pay to use this feature at all" (gated
 * routes). Saved searches at the free tier are usable; you've just
 * filled your one slot.
 */
router.post('/', async (req, res, next) => {
  try {
    const plan = await getPlanForUser(req.user.id);
    const row = await create(req.user.id, plan?.planSlug, req.body);
    res.status(201).json({ kind: 'savedsearches.created', row });
  } catch (err) {
    if (err instanceof TierCapError) {
      const plan = await getPlanForUser(req.user.id).catch(() => null);
      return res.status(403).json({
        error: 'tier_cap',
        kind: err.kind,
        message: err.message,
        planSlug: err.planSlug,
        planDisplayName: plan?.planDisplayName || err.planSlug,
        cap: err.cap,
        count: err.count,
        upgrade: { method: 'POST', path: '/api/payments/checkout' },
      });
    }
    next(toHttp(err));
  }
});

/**
 * PATCH /api/saved-searches/:id
 *
 * Body: any subset of { name, metric, threshold, comparator, artistId, enabled }.
 * At least one field required. Owner-scoped.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, 'bad_request', 'id must be a UUID');
    }
    const row = await update(req.user.id, id, req.body);
    if (!row) {
      throw new HttpError(404, 'not_found', 'saved search not found');
    }
    res.json({ kind: 'savedsearches.updated', row });
  } catch (err) {
    next(toHttp(err));
  }
});

/**
 * DELETE /api/saved-searches/:id
 * Owner-scoped. 404 if the row doesn't exist or doesn't belong to
 * this user.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, 'bad_request', 'id must be a UUID');
    }
    const ok = await remove(req.user.id, id);
    if (!ok) {
      throw new HttpError(404, 'not_found', 'saved search not found');
    }
    res.json({ kind: 'savedsearches.deleted', id });
  } catch (err) {
    next(err);
  }
});

export default router;
