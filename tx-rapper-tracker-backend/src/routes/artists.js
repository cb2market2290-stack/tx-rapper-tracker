// src/routes/artists.js
// Read-only roster endpoint for signed-in users. The admin CRUD for the
// same table lives in src/routes/admin.js — split because the read path
// is hot (every page load) and the write path is rare + needs audit.

import { Router } from 'express';
import { query } from '../db/pool.js';
import { getArtistFeatures } from '../services/features.js';
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
      `SELECT id, name, sort_order
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

export default router;
