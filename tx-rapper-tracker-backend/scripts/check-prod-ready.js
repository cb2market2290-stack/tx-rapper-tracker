#!/usr/bin/env node
// scripts/check-prod-ready.js
// Pre-deploy sanity check. Reads .env via config.js (so it fails the same
// way the server would), then layers on production-only assertions that
// config.js doesn't do itself because they'd break dev.
//
// Exit codes:
//   0 — all green
//   1 — at least one error (don't deploy)
//
// Usage:  node scripts/check-prod-ready.js
// Hook into CI before `npm start` in prod.

import 'dotenv/config';
import { config } from '../src/config.js';
import { query, closePool } from '../src/db/pool.js';

const errors = [];
const warnings = [];

function err(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

// ---- NODE_ENV ------------------------------------------------------------
const isProd = config.env === 'production';
if (!isProd) {
  warn(`NODE_ENV=${config.env} — this script is intended for production deploys`);
}

// ---- Session cookie ------------------------------------------------------
if (isProd && !config.session.cookieSecure) {
  err('SESSION_COOKIE_SECURE must be true in production (HTTPS-only cookie)');
}
if (isProd && /replace_me|change_me|REPLACE_WITH/.test(config.session.secret)) {
  err('SESSION_SECRET still looks like the placeholder from .env.production.example');
}
if (config.session.secret.length < 32) {
  err(`SESSION_SECRET is ${config.session.secret.length} chars; must be at least 32`);
}

// ---- CORS ----------------------------------------------------------------
if (isProd) {
  const bad = config.corsOrigins.filter(
    (o) => o === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(o)
  );
  if (bad.length) {
    err(`CORS_ORIGINS contains dev-only entries in prod: ${bad.join(', ')}`);
  }
  if (config.corsOrigins.some((o) => o.startsWith('http://'))) {
    err('CORS_ORIGINS contains plain-http origin in prod — must be https://');
  }
  if (config.corsOrigins.length === 0) {
    err('CORS_ORIGINS is empty — API will reject every browser origin');
  }
}

// ---- Database URL --------------------------------------------------------
if (isProd) {
  if (/localhost|127\.0\.0\.1/.test(config.databaseUrl)) {
    err('DATABASE_URL points at localhost in prod');
  }
  if (!/sslmode=require/.test(config.databaseUrl)) {
    warn('DATABASE_URL has no sslmode=require — OK for a trusted VPC, risky on public internet');
  }
}

// ---- Upstream keys -------------------------------------------------------
if (!config.youtubeApiKey || /your_.*_here/i.test(config.youtubeApiKey)) {
  err('YOUTUBE_API_KEY is missing or still a placeholder');
}

// ---- Rate limits ---------------------------------------------------------
// The dev .env intentionally keeps authMax loose (~50) so scripts/test-policy
// and scripts/test-reset can send ~15 login requests per run without getting
// 429'd. Only flag this when we're actually checking a prod env; the generic
// NODE_ENV warning above already covers the dev case.
if (isProd && config.rateLimit.authMax > 12) {
  warn(`RATE_LIMIT_AUTH_MAX=${config.rateLimit.authMax} is loose for login — 8-12 is the recommended range`);
}
if (config.rateLimit.authedMax < config.rateLimit.anonMax) {
  err(`RATE_LIMIT_AUTHED_MAX (${config.rateLimit.authedMax}) must be >= RATE_LIMIT_ANON_MAX (${config.rateLimit.anonMax})`);
}

// ---- Password policy -----------------------------------------------------
if (config.passwordPolicy.zxcvbnMinScore < 2 && isProd) {
  warn(`ZXCVBN_MIN_SCORE=${config.passwordPolicy.zxcvbnMinScore} is below the recommended floor (2)`);
}
if (config.passwordPolicy.hibpRejectThreshold === 0 && isProd) {
  warn('HIBP_REJECT_THRESHOLD=0 disables breach-list checks — OK only if you have outbound-HTTPS blocked');
}

// ---- Live DB probe -------------------------------------------------------
async function checkDb() {
  try {
    await query('SELECT 1');
    // Confirm every migration has run by looking for the newest table we expect.
    const { rows } = await query(
      `SELECT to_regclass('public.password_reset_tokens') AS t,
              to_regclass('public.sessions') AS s,
              to_regclass('public.users') AS u,
              to_regclass('public.audit_log') AS a`
    );
    const { t, s, u, a } = rows[0];
    const missing = Object.entries({ users: u, sessions: s, audit_log: a, password_reset_tokens: t })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      err(`missing tables: ${missing.join(', ')} — run \`npm run migrate\``);
    }
  } catch (dbErr) {
    err(`database probe failed: ${dbErr.message}`);
  }
}

// ---- Report --------------------------------------------------------------
await checkDb();
await closePool().catch(() => {});

const dot = (color, text) => `\x1b[${color}m${text}\x1b[0m`;
const ok = (s) => dot('32', '✓ ' + s);
const wr = (s) => dot('33', '! ' + s);
const bd = (s) => dot('31', '✗ ' + s);

console.log(`\nEnvironment: ${config.env}`);
console.log(`Port:         ${config.port}`);
console.log(`CORS origins: ${config.corsOrigins.join(', ') || '(none)'}`);
console.log(`DB host:      ${config.databaseUrl.replace(/:\/\/[^@/]+@/, '://…@')}`);
console.log('');

if (warnings.length) {
  console.log('Warnings:');
  for (const w of warnings) console.log('  ' + wr(w));
  console.log('');
}

if (errors.length) {
  console.log('Errors:');
  for (const e of errors) console.log('  ' + bd(e));
  console.log('');
  console.log(bd(`not ready — ${errors.length} error(s)`));
  process.exit(1);
}

console.log(ok('ready to deploy'));
process.exit(0);
