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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { config, redacted } from './config.js';
import { logger } from './lib/logger.js';

import { cspNonce, securityHeaders } from './middleware/security.js';
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
import savedSearchesRoutes from './routes/saved-searches.js';
import publicRoutes from './routes/public.js';
import digestRoutes from './routes/digest.js';
import referralsRoutes from './routes/referrals.js';
import { buildRouter as buildPaymentsRouter } from './routes/payments.js';
import { closePool } from './db/pool.js';
import spotifyRoutes from './routes/spotify.js';
import { startSpotifyScheduler } from './services/spotifyScheduler.js';
import apiTokensRoutes from './routes/apiTokens.js';
import exportRoutes from './routes/export.js';
import { apiKeyAuth } from './middleware/apiKeyAuth.js';
import pwaRoutes from './routes/pwa.js';
import { pwaHeaders } from './middleware/pwaHeaders.js';

const app = express();

// Trust the first proxy hop (Cloudflare Tunnel). Without this, req.ip is
// always 127.0.0.1 and rate limits don't work correctly behind a proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Platform middleware ---------------------------------------------------
// Phase 3.5.2 — CSP nonce middleware MUST run before securityHeaders() so
// res.locals.cspNonce is populated when helmet builds the CSP header.
app.use(pwaHeaders);
app.use(apiKeyAuth());
app.use(cspNonce());
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
// Saved searches CRUD — Phase 3a.2. All endpoints are owner-scoped and
// require a session. Tier caps (Free 1 / Pro 5 / Premium ∞) live in
// services/savedsearches.js, enforced at create-time against
// active_user_plan. Cap-exceeded returns 403 with kind:'savedsearches.tier_cap'
// so the frontend can render an upgrade nudge.
app.use('/api/saved-searches', requireUser(), savedSearchesRoutes);

// Phase 3d.2 — digest preferences + preview + unsubscribe.
// /preferences + /preview need a session (gated inside the router).
// /unsubscribe is anonymous + HMAC-token-gated by design (one-click
// from email, no re-login needed). Mounting the router itself with
// no auth middleware so each handler can decide.
app.use('/api/digest', digestRoutes);

// Phase 3d.3 — referral program. /me requires session (gated inside
// the router); /click is anonymous (used by app.html's onload when
// ?ref=<token> hits the URL).
app.use('/api/referrals', referralsRoutes);
app.use('/api/pwa', pwaRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/tokens', apiTokensRoutes);
app.use('/api/export', exportRoutes);

// Phase 3c — public, un-gated, server-rendered profile + compare pages,
// plus /robots.txt and /sitemap.xml. Mounted BEFORE the static-frontend
// handler below so /a/:slug + /compare/:slugs win route matching against
// the catch-all SPA. Anonymous-OK by design: these pages are the public
// funnel surface. Filters on artists.is_public so admin-hidden rows
// 404 even though the artist is still in the in-app roster.
app.use('/', publicRoutes);

// --- PWA static files -----------------------------------------------
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public")));

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

  // Phase 3.5.2 — read both pages once at startup into memory. Per
  // request we substitute every __CSP_NONCE__ placeholder with the
  // per-request nonce on res.locals.cspNonce (set by cspNonce()
  // middleware up top). String.prototype.replaceAll is O(N) over the
  // page bytes; on a 130KB app.html that's negligible compared to the
  // 5-50ms page-DB roundtrips users wait for elsewhere.
  //
  // We DO read the file once at startup (not per-request) because the
  // pages are static asset bundles — they only change on deploy, when
  // the launchd backend is restarted anyway. Cache miss on a hot path
  // would cost a syscall per request for no reason.
  const appHtmlSource   = readFileSync(appHtml,   'utf8');
  const adminHtmlSource = readFileSync(adminHtml, 'utf8');

  function renderHtml(source) {
    return (req, res) => {
      const nonce = res.locals.cspNonce || '';
      // replaceAll keeps things tidy; substitute once per inline block.
      // The CSP header already authorizes 'nonce-${nonce}', so any
      // matching nonce= attribute on a <script> or <style> is allowed
      // and any unmatched (= injected) inline block is blocked.
      const html = source.replaceAll('__CSP_NONCE__', nonce);
      res.type('html').send(html);
    };
  }

  // Explicit routes for the two entry points — no directory listing, no
  // accidental exposure of run_model.py etc.
  app.get('/',       renderHtml(appHtmlSource));
  app.get('/app',    renderHtml(appHtmlSource));
  // /reset?token=... is the target of password-reset emails. Serve the same
  // SPA — the page reads the token out of the query string on load.
  app.get('/reset',  renderHtml(appHtmlSource));
  app.get('/admin',  renderHtml(adminHtmlSource));

  logger.info({ frontendDir }, 'serving frontend with CSP nonces');
} else {
  logger.info('no frontend dir found; API-only mode');
}

// --- Tail: 404 + error handler --------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

// --- Boot ------------------------------------------------------------------
const server = startSpotifyScheduler();
app.listen(config.port, () => {
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
