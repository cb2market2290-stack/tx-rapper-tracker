// src/middleware/authenticate.js
// Attach req.user + req.session if the request carries a valid session cookie.
//
// We expose two middlewares:
//   * attachUser         — always runs, sets req.user / req.session or leaves undefined.
//                          Never errors; safe to mount globally.
//   * requireUser        — 401s if no user is attached. Use on protected routes.
//
// The cookie is read by name from req.cookies (populated by cookie-parser).
// cookie-parser must be registered BEFORE this middleware.

import { config } from '../config.js';
import { findActiveSession, unsignCookieValue } from '../auth/sessions.js';
import { HttpError } from './errorHandler.js';

export function attachUser() {
  return async function attachUserMiddleware(req, _res, next) {
    try {
      const cookieValue = req.cookies?.[config.session.cookieName];
      if (!cookieValue) return next();

      const raw = unsignCookieValue(cookieValue);
      if (!raw) return next(); // bad signature: treat as no session

      const session = await findActiveSession(raw);
      if (!session) return next();

      req.user = session.user;
      req.session = {
        id: session.sessionId,
        expiresAt: session.expiresAt,
        // We intentionally do NOT attach the raw token — callers shouldn't
        // need it, and leaking it to downstream middleware or templates
        // would undo the hashing-at-rest protection.
      };
      next();
    } catch (err) {
      // Never block a request on an auth-lookup error — log and move on.
      req.log?.warn({ err }, 'attachUser failed');
      next();
    }
  };
}

export function requireUser() {
  return function requireUserMiddleware(req, _res, next) {
    if (!req.user) {
      return next(new HttpError(401, 'unauthenticated', 'sign in required'));
    }
    next();
  };
}

// Env-var allow-list admin check. Matches on lowercased email against
// config.adminEmails. Chosen over a DB boolean because:
//   * It's read-only admin — audit + active-session view only.
//   * One-person deploys shouldn't need a migration to add an admin.
//   * The allow-list is deploy-time config; an attacker who gets DB
//     write can't self-promote without also getting the env.
// Returns 404 for EVERYONE who isn't on the list — including anonymous —
// so we don't even confirm the route exists. (attachUser runs earlier
// and populates req.user if the cookie is valid.)
export function requireAdmin() {
  return function requireAdminMiddleware(req, _res, next) {
    const email = req.user?.email?.toLowerCase?.();
    const allowed = (config.adminEmails ?? []).map((e) => e.toLowerCase());
    if (!email || !allowed.includes(email)) {
      return next(new HttpError(404, 'not_found', 'not found'));
    }
    next();
  };
}
