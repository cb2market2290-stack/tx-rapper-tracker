// src/middleware/rateLimit.js
// Two-tier rate limiting:
//   * Anonymous requests bucket by IP with a tight ceiling.
//   * Authenticated requests bucket by user.id with a much higher ceiling.
//
// Why split them? A logged-in user deserves a generous quota (they earned it
// by creating an account), but an anon IP should be kept on a short leash so
// nobody can burn our YouTube quota with a script.
//
// This assumes attachUser() has already run upstream, so req.user is
// populated for valid sessions. Make sure you mount this middleware AFTER
// cookieParser + attachUser in src/index.js.

import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// Login / signup get a separate, strict bucket so someone can't brute-force
// by rotating IPs. Still per-IP, but different limit than the generic floor
// so the UI can retry quickly on typos without getting a 429.
const STRICT_AUTH_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/forgot',
  '/api/auth/reset',
  // 2FA verify is the brute-force target for the second step (~1M trials
  // for a stolen pre-cookie) — keep it on the strict bucket.
  '/api/auth/2fa/verify',
  // Disable also takes a TOTP code; same reasoning.
  '/api/auth/2fa/disable',
  // WebAuthn authenticate paths sit on the same pre_2fa session and are
  // the equivalent brute-force target for security-key login.
  '/api/auth/webauthn/authenticate/options',
  '/api/auth/webauthn/authenticate/verify',
]);

export function rateLimitMiddleware() {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    // max can be a function of req — that's how we tier by user vs IP.
    max(req) {
      if (STRICT_AUTH_PATHS.has(req.path)) return config.rateLimit.authMax;
      if (req.user?.id) return config.rateLimit.authedMax;
      return config.rateLimit.anonMax;
    },
    // Key by user when authed, else by IP. Prefixed so a user's bucket and
    // their IP's bucket never collide.
    keyGenerator(req) {
      if (req.user?.id) return 'u:' + req.user.id;
      // express-rate-limit's default ipKeyGenerator respects trust proxy.
      return 'ip:' + (req.ip ?? 'unknown');
    },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Skip /health and /ready so Cloudflare can probe freely.
    skip: (req) => req.path === '/health' || req.path === '/ready',
    handler(req, res) {
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests. Slow down and retry.',
      });
    },
  });
}
