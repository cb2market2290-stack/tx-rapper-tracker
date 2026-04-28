// src/middleware/security.js
// Hardened response headers. Lines up with the "Application security" section
// of the Music Analytics Platform Brainstorm (strict nonce-based CSP, HSTS, etc).
//
// Phase 3.5.2 — closes the TODO that used to live here. The two static
// HTML pages we serve from this origin (app.html + admin.html) plus the
// server-rendered public-pages templates (routes/public.js) carry inline
// <script> and <style> blocks. We previously allowed those via
// 'unsafe-inline' on script-src + style-src; now we use a per-request
// nonce so inline blocks are individually whitelisted and any DOM-injected
// script (XSS) without the right nonce is blocked.
//
// Wiring:
//   1. cspNonce() runs BEFORE securityHeaders() and stores 16 random bytes
//      (base64url) on res.locals.cspNonce.
//   2. securityHeaders() reads res.locals.cspNonce via helmet's directive-
//      callback shape: each directive entry can be a function (req, res) =>
//      string, evaluated per-request.
//   3. The static-html serving layer in src/index.js substitutes the
//      __CSP_NONCE__ placeholder in app.html / admin.html before sending.
//   4. Inline blocks in routes/public.js#pageShell read the nonce off
//      res.locals via the route handler and inject it into the rendered
//      HTML.
//
// External script srcs (Chart.js from cdnjs) are still allowed by URL —
// the cdnjs origin gets script-src on its own, no nonce needed.

import crypto from 'node:crypto';
import helmet from 'helmet';

/**
 * Generate a per-request CSP nonce and attach to res.locals.cspNonce.
 * Must run BEFORE securityHeaders() so the nonce is available when
 * helmet builds the response headers.
 *
 * 16 bytes of randomBytes → base64url is 22 chars; well under the 64
 * chars helmet's CSP middleware allows per directive value.
 */
export function cspNonce() {
  return function cspNonceMiddleware(_req, res, next) {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64url');
    next();
  };
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Per-request nonce. helmet calls this function with (req, res)
          // for every request that needs a CSP header. We read the nonce
          // from res.locals (set by cspNonce middleware above).
          (_req, res) => `'nonce-${res.locals.cspNonce}'`,
          'https://cdnjs.cloudflare.com', // Chart.js
        ],
        // 'script-src-attr none' would also block inline event handlers
        // (onclick=...). We keep them allowed for now because the existing
        // pages use a few onsubmit= attributes; tightening to 'none' is a
        // follow-up that requires a sweep through app.html for inline
        // event handlers and converting them to data-action delegated
        // listeners (we already use that pattern; just need to finish the
        // conversion).
        styleSrc: [
          "'self'",
          (_req, res) => `'nonce-${res.locals.cspNonce}'`,
        ],
        imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'], // YouTube thumbs
        connectSrc: ["'self'"], // same-origin /api/* now
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // safe default for JSON APIs
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HSTS only makes sense behind HTTPS. Cloudflare Tunnel gives you HTTPS.
    hsts: {
      maxAge: 63_072_000, // 2 years
      includeSubDomains: true,
      preload: true,
    },
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xXssProtection: false, // deprecated; CSP covers this
  });
}
