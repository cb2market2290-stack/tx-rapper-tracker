// src/routes/artists.js
// Read-only roster endpoint for signed-in users. The admin CRUD for the
// same table lives in src/routes/admin.js — split because the read path
// is hot (every page load) and the write path is rare + needs audit.

import { Router } from 'express';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { getArtistFeatures } from '../services/features.js';
import { getOrGenerateBrief } from '../services/briefs.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requirePaid } from '../middleware/requirePaid.js';

const router = Router();

// UUIDs are the artists.id type; validate before hitting the DB so we
// return a clean 400 instead of a parser error.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/artists
 * Returns the active roster ordered for display. The frontend uses this
 * as the seed list for rendering + ranking, and the snapshot script uses
 * it as the target list for its daily crawl.
 */
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      // Phase 3c.4: include `slug` + `is_public` so the frontend can
      // build `/a/:slug` Share URLs and (in admin views) surface the
      // visibility flag. Both columns are NOT NULL after migration 016
      // so they're always populated; older clients that don't read them
      // simply ignore the extra fields (additive, no breaking change).
      `SELECT id, name, slug, is_public, sort_order
         FROM artists
        WHERE NOT is_archived
        ORDER BY sort_order ASC, name ASC`
    );
    res.json({ kind: 'artists.list', rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/artists/:id/features
 * Per-track audio features (tempo, key, energy, etc.) for the given
 * artist, plus an aggregated summary the frontend can mix into the
 * ranking score. Empty arrays + null summary fields are valid responses
 * for an artist with no tracks analyzed yet — the UI handles "no data"
 * gracefully.
 *
 * Phase 2c: Python worker (scripts/extract-features.py) populates the
 * underlying track_features table; the read path is hot enough to live
 * here rather than behind /api/admin/.
 *
 * Phase 2d: gated by requirePaid. Free-tier users get a 402 with an
 * upgrade hint that the frontend swaps into an inline "Upgrade" card.
 * The roster list (`GET /api/artists`) stays free — only the expensive
 * audio-feature path is gated.
 */
router.get('/:id/features', requirePaid(), async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, 'bad_request', 'artist id must be a UUID');
    }
    // Confirm the artist exists + isn't archived. Without this guard we'd
    // return an empty payload for any random UUID, which is misleading.
    const { rows } = await query(
      `SELECT id FROM artists WHERE id = $1 AND NOT is_archived`,
      [id]
    );
    if (rows.length === 0) {
      throw new HttpError(404, 'not_found', 'artist not found');
    }
    const features = await getArtistFeatures(id);
    res.json({ kind: 'artists.features', ...features });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/artists/:id/brief
 *
 * Phase 3b — Premium-only AI artist brief. A Claude-generated paragraph
 * (~80-120 words) summarizing recent snapshots + audio features in
 * plain prose. Read-through cache; same fingerprint → same bytes;
 * cache invalidates on the next snapshot or features re-extract or
 * prompt-version bump.
 *
 * Status mapping for this route specifically:
 *   200 + brief                    cache hit OR fresh generation succeeded
 *   200 + brief:''+kind:'briefs.no_data'
 *                                  artist has zero snapshots — nothing
 *                                  meaningful for Claude to summarize.
 *                                  We don't 404 because the artist
 *                                  exists; we don't 503 because the SDK
 *                                  is fine; the right answer is
 *                                  "wait for the next snapshot."
 *   402                            free / pro user (requirePaid gate)
 *   404                            artist missing or archived
 *   503  briefs_unconfigured       cache miss + ANTHROPIC_API_KEY unset
 *   504  briefs_timeout            Claude took longer than
 *                                  config.briefs.timeoutMs
 *   502  briefs_upstream           Anthropic returned an error / SDK
 *                                  threw something that wasn't a timeout
 */
router.get(
  '/:id/brief',
  requirePaid({ minTier: 'premium' }),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID_RE.test(id)) {
        throw new HttpError(400, 'bad_request', 'artist id must be a UUID');
      }

      // The 25s timeout lives here, not in the service module. We
      // attach an AbortSignal so the SDK's in-flight request is
      // canceled when we time out — otherwise the connection would
      // linger past the 504 we send the client.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), config.briefs.timeoutMs);
      try {
        const result = await getOrGenerateBrief(id, { signal: ac.signal });
        res.json({
          kind: 'artists.brief',
          artistId: id,
          brief: result.brief,
          generatedAt: result.generatedAt,
          model: result.model,
          promptVersion: result.promptVersion,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          cacheHit: !!result.cacheHit,
          shapingDegraded: !!result.shapingDegraded,
          fingerprint: result.fingerprint,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Map the service-level error codes to HTTP status. Anything we
      // don't recognize falls through to the global error handler.
      switch (err && err.code) {
        case 'artist_not_found':
          return next(new HttpError(404, 'not_found', 'artist not found'));
        case 'insufficient_data':
          // Friendly empty-state — see the route docstring.
          return res.json({
            kind: 'briefs.no_data',
            artistId: req.params.id,
            brief: '',
            message:
              'No snapshots yet — the brief will appear after the next snapshot lands.',
          });
        case 'briefs_unconfigured':
          return next(
            new HttpError(
              503,
              'briefs_unconfigured',
              'AI briefs are not configured on this server.'
            )
          );
        default:
          break;
      }
      // AbortError → 504. The Anthropic SDK rethrows DOMException
      // 'AbortError' when the signal fires; we also tolerate a plain
      // Error with name === 'AbortError' for forward-compat.
      if (
        err &&
        (err.name === 'AbortError' || err.code === 'ABORT_ERR' ||
          (err.cause && err.cause.name === 'AbortError'))
      ) {
        return next(
          new HttpError(504, 'briefs_timeout', 'Claude took too long; try again.')
        );
      }
      // Anything else from the SDK → 502 with a clean message rather
      // than a stack trace. Logged via the global error handler.
      const looksLikeAnthropic =
        err && (err.status === 429 || err.status === 529 || err.status >= 500);
      if (looksLikeAnthropic) {
        return next(
          new HttpError(
            502,
            'briefs_upstream',
            'Anthropic upstream error. Try again in a moment.'
          )
        );
      }
      next(err);
    }
  }
);

export default router;
