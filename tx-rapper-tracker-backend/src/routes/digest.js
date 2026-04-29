// src/routes/digest.js
// Phase 3d.2 — digest preferences + preview + one-click unsubscribe.
//
// Three endpoints:
//   GET    /api/digest/preferences         — read; requires session
//   PATCH  /api/digest/preferences         — write {opted_in: bool}
//   GET    /api/digest/preview             — admin-only; returns the
//                                             payload that would be
//                                             sent now
//   GET    /api/digest/unsubscribe?u=&t=   — public; HMAC-token-gated
//                                             one-click unsubscribe.
//                                             Renders a confirmation HTML
//                                             page so the click feels
//                                             like an action with feedback,
//                                             not just a 200 OK.

import { Router } from 'express';

import { query } from '../db/pool.js';
import { config } from '../config.js';
import { requireUser } from '../middleware/authenticate.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../lib/logger.js';
import {
  buildDigestPayload,
  signUnsubToken,
  verifyUnsubToken,
} from '../services/digest.js';
import { getAllSignals } from '../services/breakout.js';

const router = Router();

// Inline audit-log write — same shape as routes/auth.js#audit. We
// don't have a centralized audit module yet (each route inlines its
// own writes). Best-effort: a failed audit write logs but does not
// fail the user-visible flow.
async function audit({ req, userId, event, details }) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, event, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId ?? null,
        event,
        req?.ip ?? null,
        req?.get?.('user-agent') ?? null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message, event }, 'audit write failed');
  }
}

// UUID validator for the ?u= param on the unsubscribe link.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── helpers ─────────────────────────────────────────────────────────────

async function getPrefs(userId) {
  const { rows } = await query(
    `SELECT digest_opted_in,
            digest_last_sent_at,
            digest_last_clicked_at
       FROM users
      WHERE id = $1`,
    [userId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    optedIn: !!r.digest_opted_in,
    lastSentAt: r.digest_last_sent_at,
    lastClickedAt: r.digest_last_clicked_at,
  };
}

// ── routes ──────────────────────────────────────────────────────────────

router.get('/preferences', requireUser(), async (req, res, next) => {
  try {
    const prefs = await getPrefs(req.user.id);
    if (!prefs) {
      throw new HttpError(404, 'not_found', 'user not found');
    }
    res.json({ kind: 'digest.preferences', ...prefs });
  } catch (err) {
    next(err);
  }
});

router.patch('/preferences', requireUser(), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (typeof body.opted_in !== 'boolean' && typeof body.optedIn !== 'boolean') {
      throw new HttpError(
        400,
        'bad_request',
        'opted_in (boolean) is required'
      );
    }
    const optedIn =
      typeof body.optedIn === 'boolean' ? body.optedIn : body.opted_in;
    await query(
      `UPDATE users
          SET digest_opted_in = $2
        WHERE id = $1`,
      [req.user.id, optedIn]
    );
    await audit({
      req,
      userId: req.user.id,
      event: 'digest.optin_changed',
      details: { opted_in: optedIn },
    });
    const prefs = await getPrefs(req.user.id);
    res.json({ kind: 'digest.preferences', ...prefs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/digest/preview
 *
 * Returns the digest payload that would be sent to the requesting
 * user RIGHT NOW. Useful for development and for an admin "see what
 * the cron will send tomorrow" sanity check. Always builds against
 * fresh breakout_signals data.
 *
 * Returns {kind:'digest.preview', payload, builtAt} on success;
 * {kind:'digest.preview', payload:null, reason:'no_content'} when
 * there are zero movers + no emerging artist (the digest would not
 * ship in that state).
 */
router.get('/preview', requireUser(), async (req, res, next) => {
  try {
    const signals = await getAllSignals();
    const unsubToken = signUnsubToken(req.user.id);
    const appBaseUrl = config.appBaseUrl || `${req.protocol}://${req.get('host')}`;
    const payload = buildDigestPayload({
      appBaseUrl,
      signals,
      user: { id: req.user.id, email: req.user.email },
      unsubToken,
    });
    if (!payload) {
      return res.json({
        kind: 'digest.preview',
        payload: null,
        reason: 'no_content',
        builtAt: new Date().toISOString(),
      });
    }
    res.json({
      kind: 'digest.preview',
      payload,
      builtAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/digest/unsubscribe?u=<userId>&t=<HMAC>
 *
 * Public — no session required. The HMAC token is what gates this
 * (otherwise anyone with a user_id could unsubscribe other users by
 * URL). Renders a small confirmation HTML page so the click feels
 * like a real action; ALSO writes the audit log so an admin can
 * verify "yes, this user clicked the unsubscribe link, not someone
 * else with their email."
 */
router.get('/unsubscribe', async (req, res, next) => {
  try {
    const userId = String(req.query.u || '');
    const token = String(req.query.t || '');
    if (!UUID_RE.test(userId) || !token) {
      // Don't reveal which of (u missing vs t missing vs t mismatch)
      // by returning identical 400 for all bad-input cases. Defense
      // in depth against fishing for valid user_ids.
      return res.status(400).type('html').send(
        renderUnsubPage({
          ok: false,
          message: 'This unsubscribe link is invalid or malformed.',
        })
      );
    }
    if (!verifyUnsubToken(userId, token)) {
      return res.status(400).type('html').send(
        renderUnsubPage({
          ok: false,
          message: 'This unsubscribe link is invalid or has been revoked.',
        })
      );
    }
    const result = await query(
      `UPDATE users
          SET digest_opted_in = FALSE
        WHERE id = $1
        RETURNING email`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).type('html').send(
        renderUnsubPage({
          ok: false,
          message: 'No matching user found for this link.',
        })
      );
    }
    await audit({
      req,
      userId,
      event: 'digest.unsubscribed',
      details: { via: 'one_click_link' },
    });
    return res.type('html').send(
      renderUnsubPage({
        ok: true,
        message:
          'You have been unsubscribed from the weekly digest. You can re-enable it any time from your account settings.',
      })
    );
  } catch (err) {
    next(err);
  }
});

// Tiny inline HTML so we don't need a template engine + the page
// renders correctly even if static-frontend serving is misconfigured.
function renderUnsubPage({ ok, message }) {
  const status = ok ? 'Unsubscribed' : 'Unsubscribe failed';
  const color = ok ? '#9d6ee0' : '#e06060';
  // No nonce here — this is a static HTML response from a route, not
  // app.html. The CSP on this response (set by helmet for /api/*)
  // includes 'self' for style-src; no inline <script> at all.
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${status} — TX Rapper Tracker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="background:#0a0a0a;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;padding:24px">
<main style="max-width:480px;margin:48px auto;text-align:center">
  <h1 style="color:${color};font-size:1.4rem;margin:0 0 12px">${status}</h1>
  <p style="color:#999;line-height:1.5;margin:0 0 18px">${message}</p>
  <p><a href="/" style="color:#9d6ee0;text-decoration:none;border:1px solid #2a2a2a;border-radius:6px;padding:8px 14px;display:inline-block">Back to dashboard</a></p>
</main>
</body></html>`;
}

export default router;
