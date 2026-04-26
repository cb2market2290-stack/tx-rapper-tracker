// src/middleware/security.js
// Hardened response headers. Lines up with the "Application security" section
// of the Music Analytics Platform Brainstorm (strict nonce-based CSP, HSTS, etc).
//
// CSP directives account for the two HTML pages we serve from this origin:
//   app.html   — inline <style> + inline <script>, Chart.js from cdnjs,
//                YouTube thumbnails from i.ytimg.com.
//   admin.html — inline <style> + inline <script>, same-origin fetches only.
// 'unsafe-inline' is present on script-src / style-src because the pages
// have inline blocks; migrating to nonces is a follow-up.

import helmet from 'helmet';

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // inline <script> blocks in app.html / admin.html
          'https://cdnjs.cloudflare.com', // Chart.js
        ],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline <style> blocks
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
