// src/index.js
// App entry point. Wires middleware + routes. Start with `npm start`.
//
// Phase 2a goals delivered here:
//   - YouTube + Google Trends proxy endpoints (server-side keys only)
//   - Strict security headers (Helmet-based CSP, HSTS, COOP, etc)
//   - Allow-list CORS
//   - Per-IP rate limiting
//   - Structured JSON logs with a PII scrubber
//   - Env-var driven config with fail-fast validation

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { config, redacted } from './config.js';
import { logger } from './lib/logger.js';

import { securityHeaders } from './middleware/security.js';
import { corsMiddleware } from './middleware/cors.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { attachUser, requireUser } from './middleware/authenticate.js';

import healthRoutes from './routes/health.js';
import youtubeRoutes from './routes/youtube.js';
import statsRoutes from './routes/stats.js';
import artistsRoutes from './routes/artists.js';
import authRoutes from './routes/auth.js';
import twoFactorRoutes from './routes/twofactor.js';
import webauthnRoutes from './routes/webauthn.js';
import adminRoutes from './routes/admin.js';
import insightsRoutes from './routes/insights.js';
import { buildRouter as buildPaymentsRouter } from './routes/payments.js';
import { closePool } from './db/pool.js';

const app = express();

// Trust the first proxy hop (Cloudflare Tunnel). Without this, req.ip is
// always 127.0.0.1 and rate limits don't work correctly behind a proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Platform middleware ---------------------------------------------------
app.use(securityHeaders());
app.use(corsMiddleware());
app.use(compression());

// Cookie parsing + optional session loading. These run BEFORE the payments
// mount so /api/payments/{checkout,portal,plan} can see req.user. They only
// read headers / do a session-cookie DB lookup — they don't touch req.body,
// so the raw-body Stripe webhook below is unaffected.
//
// IMPORTANT: attachUser must run BEFORE rateLimitMiddleware so the limiter
// can tier buckets by req.user.id (authed) vs req.ip (anon).
app.use(cookieParser());
app.use(attachUser());

// Stripe webhook MUST be mounted before express.json() — Stripe signs the
// raw body bytes, and once the JSON parser consumes them the signature
// can no longer be verified. The payments router uses express.raw() at
// the route level so it gets a Buffer for /webhook, while /checkout,
// /portal, /plan use their own express.json() inside the sub-router.
app.use('/api/payments', buildPaymentsRouter());

app.use(express.json({ limit: '100kb' })); // we don't accept big payloads here
app.use(
  pinoHttp({
    logger,
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Strip query strings from logged URLs — they can carry search terms
    // that we don't want in logs verbatim.
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split('?')[0],
          remoteAddress: req.remoteAddress,
        };
      },
    },
  })
);
app.use(rateLimitMiddleware());

// --- Routes ----------------------------------------------------------------
// Public:  /health, /api/auth/*  (you need these to be reachable logged out)
// Gated:   /api/youtube, /api/stats  (authed users only)
//
// Note: /api/trends was removed in phase 2b.9 — the unofficial
// trends.google.com endpoints started returning 429 (bot-block) and
// nothing in the frontend was calling them. The real 12-month chart is
// driven by /api/stats/history now, populated by scripts/snapshot-stats.js.
app.use('/', healthRoutes);
app.use('/api/auth', authRoutes);
// 2FA endpoints — /enroll, /enroll/verify, /disable need a full session
// (handled inside the router); /verify uses the pre_2fa cookie path.
app.use('/api/auth/2fa', twoFactorRoutes);
// WebAuthn (passkeys / hardware keys) — register endpoints need a full
// session, authenticate endpoints use the pre_2fa cookie path. Auth is
// gated inside the router itself.
app.use('/api/auth/webauthn', webauthnRoutes);
// Admin mounts its own requireAdmin middleware — requireUser + allow-list.
app.use('/api/admin', adminRoutes);
// Insights — anonymous-OK on purpose. The breakout/movers strip is the
// public funnel hook (per PHASE_3_BRAINSTORM.md, Track A → 3a). Heavy
// reads are precomputed by migration 013's matview, so cost is bounded
// even without auth. Rate limiter (already mounted above) still applies.
app.use('/api/insights', insightsRoutes);
app.use('/api/youtube', requireUser(), youtubeRoutes);
// Historical stats read-only endpoints. Data is populated by the daily
// scripts/snapshot-stats.js job, not by user requests, so this is cheap.
app.use('/api/stats',   requireUser(), statsRoutes);
// Roster read path — small, public (to signed-in users) because the main
// app needs it on every page load to know what to render.
app.use('/api/artists', requireUser(), artistsRoutes);

// --- Frontend static files ------------------------------------------------
// Serve the two HTML pages from the same origin as the API. Resolves
// SameSite cookie + CORS grief — there's just one origin now. Everything
// under /api/* is already mounted above, so it wins the route table.
//
// Resolution order:
//   1. FRONTEND_DIR env var (absolute path), if set.
//   2. Sibling `../tx-rapper-tracker` relative to this file — the dev layout.
//   3. No frontend serving; API stays pure JSON.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir =
  config.frontendDir ??
  (() => {
    const sibling = path.resolve(__dirname, '../../tx-rapper-tracker');
    return existsSync(sibling) ? sibling : null;
  })();

if (frontendDir && existsSync(frontendDir)) {
  const appHtml   = path.join(frontendDir, 'app.html');
  const adminHtml = path.join(frontendDir, 'admin.html');

  // Explicit routes for the two entry points — no directory listing, no
  // accidental exposure of run_model.py etc.
  app.get('/',       (_req, res) => res.sendFile(appHtml));
  app.get('/app',    (_req, res) => res.sendFile(appHtml));
  // /reset?token=... is the target of password-reset emails. Serve the same
  // SPA — the page reads the token out of the query string on load.
  app.get('/reset',  (_req, res) => res.sendFile(appHtml));
  app.get('/admin',  (_req, res) => res.sendFile(adminHtml));

  logger.info({ frontendDir }, 'serving frontend');
} else {
  logger.info('no frontend dir found; API-only mode');
}

// --- Tail: 404 + error handler --------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

// --- Boot ------------------------------------------------------------------
const server = app.listen(config.port, () => {
  logger.info({ config: redacted() }, `listening on :${config.port}`);
});

// --- Graceful shutdown -----------------------------------------------------
function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
    try {
      await closePool();
    } catch (poolErr) {
      logger.error({ err: poolErr }, 'error closing db pool');
    }
    process.exit(0);
  });
  // Force exit after 10s if sockets are hanging.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
