// src/middleware/cors.js
// Strict CORS: allow-list only, no wildcards. Credentials are ON because
// the browser needs to send our session cookie on cross-origin requests.
// Add your production origin to CORS_ORIGINS in .env.
//
// Same-origin skip: browsers DO send the Origin header on same-origin
// POSTs (contrary to folklore), so a naive allow-list blocks our own
// frontend when served from the backend. We detect same-origin by
// comparing the Origin's host to the request's Host header and short-
// circuit before the allow-list is consulted.

import cors from 'cors';
import { config } from '../config.js';

function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function corsMiddleware() {
  const allowList = new Set(config.corsOrigins);

  const crossOriginCors = cors({
    origin(origin, cb) {
      // `origin` is undefined for non-browser clients (curl, server-to-server).
      // We let those through — CSRF is controlled by SameSite cookies elsewhere.
      if (!origin) return cb(null, true);
      // `null` origin happens when the frontend is opened from file://
      // or a sandboxed iframe. We only allow it if explicitly listed.
      if (allowList.has(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: origin ${origin} not allow-listed`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    credentials: true,
    maxAge: 600,
  });

  return function corsGate(req, res, next) {
    if (isSameOrigin(req)) {
      // Same-origin request — no CORS headers needed, no allow-list check.
      return next();
    }
    return crossOriginCors(req, res, next);
  };
}
