// src/routes/referrals.js
// Phase 3d.3b — referral routes: per-user share token + click capture.
//
// Two endpoints:
//   GET  /api/referrals/me     — requires session. Returns the
//                                  signed-in user's stable token,
//                                  shareable link, and stats.
//                                  Auto-creates the row in `referrals`
//                                  on first call (lazy backfill).
//   POST /api/referrals/click  — anonymous. Body: {token}. Records
//                                  a click into referral_clicks.
//                                  Idempotent within 24h-same-IP.
//                                  Used by app.html's onload when
//                                  ?ref=<token> hits the URL.

import { Router } from 'express';

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../middleware/authenticate.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  ensureToken,
  isValidToken,
  recordClick,
  getStats,
  getReferrerByToken,
} from '../services/referrals.js';

const router = Router();

// ── helpers ─────────────────────────────────────────────────────────────

function buildShareLink(req, token) {
  const base = config.appBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/+$/, '')}/?ref=${encodeURIComponent(token)}`;
}

// ── routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/referrals/me
 *
 * Returns { token, link, stats } for the signed-in user.
 * Auto-creates the row in `referrals` on first call.
 */
router.get('/me', requireUser(), async (req, res, next) => {
  try {
    const ref = await ensureToken(req.user.id);
    const stats = await getStats(req.user.id);
    res.json({
      kind: 'referrals.me',
      token: ref.token,
      link: buildShareLink(req, ref.token),
      stats,
      createdAt: ref.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/referrals/click
 *
 * Anonymous. Body: { token }.
 *
 * Records the click iff the token resolves to a real referrer and
 * the same (token, ip) hasn't been recorded in the last 24h. Returns
 * { kind:'referrals.click_recorded' } or 'referrals.click_deduped';
 * either way 200 (don't leak the dedupe state to potential abusers).
 *
 * Uses req.body — express.json() is mounted globally so the body
 * parser is in scope.
 */
router.post('/click', async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!isValidToken(token)) {
      // Don't 4xx for bad tokens — return a no-op response so a
      // probe can't distinguish "valid token, dedup hit" from "bad
      // token shape." Defense in depth against fishing attacks.
      return res.json({ kind: 'referrals.click_deduped' });
    }
    const referrer = await getReferrerByToken(token);
    if (!referrer) {
      return res.json({ kind: 'referrals.click_deduped' });
    }
    const inserted = await recordClick({
      token,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    if (inserted) {
      logger.info(
        { token, referrerUserId: referrer.userId },
        'referrals: click recorded'
      );
      return res.json({ kind: 'referrals.click_recorded' });
    }
    return res.json({ kind: 'referrals.click_deduped' });
  } catch (err) {
    next(err);
  }
});

export default router;
