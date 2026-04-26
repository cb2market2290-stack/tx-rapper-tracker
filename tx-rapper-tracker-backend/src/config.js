// src/config.js
// Centralized, validated configuration. Never log the raw object —
// it contains API keys. Use the `redacted()` helper when you need to print it.

import 'dotenv/config';
import { z } from 'zod';

// Small helpers to parse env strings into useful shapes.
const parseList = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  CORS_ORIGINS: z.string().default('http://localhost:8080,null'),
  YOUTUBE_API_KEY: z.string().min(10, 'YOUTUBE_API_KEY is required. See .env.example.'),
  // GOOGLE_TRENDS_PROXY_BASE removed in phase 2b.9 along with /api/trends.
  // Old .envs that still set it will be silently ignored by zod (strict=false).
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(600),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  // Legacy single-ceiling knob. Kept so old .envs don't break; we now
  // tier by anon vs authed vs auth-endpoints below.
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  // Strict bucket for /api/auth/login and /api/auth/signup (per IP).
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
  // Generous bucket for authed requests (per user.id).
  RATE_LIMIT_AUTHED_MAX: z.coerce.number().int().min(1).default(240),
  // Tight bucket for anon requests (per IP).
  RATE_LIMIT_ANON_MAX: z.coerce.number().int().min(1).default(30),
  // --- Phase 2b.2: password hygiene ---
  // Reject passwords that appear in breach lists more than this many times.
  // 0 disables the HaveIBeenPwned check entirely (useful for offline dev).
  HIBP_REJECT_THRESHOLD: z.coerce.number().int().min(0).default(10),
  // zxcvbn score threshold (0=worst, 4=best). Rejects &lt; this.
  ZXCVBN_MIN_SCORE: z.coerce.number().int().min(0).max(4).default(2),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // --- Phase 2b: database + sessions ---
  DATABASE_URL: z
    .string()
    .min(10, 'DATABASE_URL is required. See .env.example.')
    .default('postgres://localhost/tx_rapper_tracker_dev'),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 chars. Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'),
  SESSION_COOKIE_NAME: z.string().default('tx_sid'),
  SESSION_COOKIE_DOMAIN: z.string().default(''),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60 * 24 * 14), // 14d
  SESSION_COOKIE_SECURE: z.coerce.boolean().default(false), // flip to true in prod (HTTPS)
  // Comma-separated emails that can hit /api/admin/*. Empty by default —
  // admin routes 404 until this is filled in.
  ADMIN_EMAILS: z.string().default(''),
  // Absolute path to the frontend directory. Used by the static-file handler
  // to serve app.html at / and admin.html at /admin from the same origin as
  // the API. Default points at the sibling tx-rapper-tracker/ checkout.
  FRONTEND_DIR: z.string().default(''),

  // --- Password reset ---
  // Public base URL used to construct the reset link. Should be the same
  // origin the frontend is served from. Falls back to a local dev URL.
  APP_BASE_URL: z.string().url().default('http://localhost:8787'),
  // Token lifetime — long enough to handle email delays, short enough
  // that a stolen link window is narrow. 30 min is the sweet spot.
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  // --- Mail ---
  // "Name <address@domain>" or just "address@domain". Resend requires the
  // domain to be verified; in dev the console transport ignores it.
  MAIL_FROM: z.string().default('TX Rapper Tracker <no-reply@localhost>'),
  // Optional. When set, we use Resend's HTTPS API. Leave blank in dev
  // and we fall back to the ConsoleMailer (logs + /tmp/last-reset-email.txt).
  RESEND_API_KEY: z.string().default(''),

  // --- 2FA (Phase 2b.13) ---
  // AES-256-GCM key for encrypting user_totp.secret_encrypted at rest.
  // Provide a 64-hex-char string (32 bytes). Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // If blank, we derive one from SESSION_SECRET — OK for dev, LOUD warn in
  // prod (rotating SESSION_SECRET would brick existing enrollments).
  TOTP_ENC_KEY: z.string().default(''),
  // otpauth:// issuer label shown in the user's authenticator app
  // (Google Authenticator, 1Password, etc.). Usually the product name.
  TOTP_ISSUER: z.string().default('TX Rapper Tracker'),

  // --- WebAuthn (Phase 2b.14) ---
  // The Relying Party ID — the bare hostname users see in the WebAuthn
  // dialog. MUST match (or be a registrable suffix of) the origin the
  // user is on. Localhost is the only value that works without HTTPS.
  WEBAUTHN_RP_ID: z.string().default('localhost'),
  // Display name shown to the user in the platform's WebAuthn UI.
  WEBAUTHN_RP_NAME: z.string().default('TX Rapper Tracker'),
  // Comma-separated list of expected origins. The first is canonical;
  // additional entries cover the dev frontend running on a different
  // port and the prod tunnel. We pass them all to verifyAuthentication-
  // Response so any of them is accepted.
  WEBAUTHN_ORIGINS: z.string().default('http://localhost:8787,http://localhost:8080'),

  // --- Stripe payments (Phase 2c scaffolding) ---
  // Live OR test secret key. Empty disables payments entirely — the
  // webhook receiver returns 503 and getStripe() throws. Lets us deploy
  // the scaffolding without a real Stripe account configured.
  STRIPE_SECRET_KEY: z.string().default(''),
  // Webhook signing secret (whsec_…). Required when STRIPE_SECRET_KEY is
  // set; without it we can't verify event signatures and must reject all
  // webhook deliveries. Leaving these decoupled so dev can use Stripe
  // CLI's `stripe listen` (which gives you a fresh secret).
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  // Default price id for the paid tier. Stored here (not hardcoded) so
  // upgrading/A-B-testing prices is an env flip, not a code change.
  STRIPE_PRICE_ID: z.string().default(''),
  // API version pin — Stripe encourages explicit versioning so a future
  // Stripe-side default change can't silently shift our payload shapes.
  STRIPE_API_VERSION: z.string().default('2024-06-20'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message. Don't print the raw env.
  console.error('[config] Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const config = Object.freeze({
  env: env.NODE_ENV,
  port: env.PORT,
  corsOrigins: parseList(env.CORS_ORIGINS),
  youtubeApiKey: env.YOUTUBE_API_KEY,
  cacheTtlSeconds: env.CACHE_TTL_SECONDS,
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,          // legacy — not used by new tiered limiter
    authMax: env.RATE_LIMIT_AUTH_MAX, // per-IP, strict, for login/signup
    authedMax: env.RATE_LIMIT_AUTHED_MAX, // per-user, generous
    anonMax: env.RATE_LIMIT_ANON_MAX, // per-IP, tight
  },
  passwordPolicy: Object.freeze({
    hibpRejectThreshold: env.HIBP_REJECT_THRESHOLD,
    zxcvbnMinScore: env.ZXCVBN_MIN_SCORE,
  }),
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  session: Object.freeze({
    secret: env.SESSION_SECRET,
    cookieName: env.SESSION_COOKIE_NAME,
    cookieDomain: env.SESSION_COOKIE_DOMAIN || undefined,
    ttlSeconds: env.SESSION_TTL_SECONDS,
    cookieSecure: env.SESSION_COOKIE_SECURE,
  }),
  adminEmails: Object.freeze(parseList(env.ADMIN_EMAILS)),
  frontendDir: env.FRONTEND_DIR || null,
  appBaseUrl: env.APP_BASE_URL.replace(/\/+$/, ''), // strip trailing slash
  passwordResetTtlSeconds: env.PASSWORD_RESET_TTL_MINUTES * 60,
  mail: Object.freeze({
    from: env.MAIL_FROM,
    resendApiKey: env.RESEND_API_KEY || null,
  }),
  totp: Object.freeze({
    // Empty string = derive from SESSION_SECRET at runtime in totp.js.
    // Keeping the raw env value here (not the derived bytes) so redacted()
    // can show "derived from SESSION_SECRET" or "explicit" without leaking.
    encKey: env.TOTP_ENC_KEY || null,
    issuer: env.TOTP_ISSUER,
  }),
  webauthn: Object.freeze({
    rpId: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    // Pre-parsed origins list — passed straight to verifyAuthentication-
    // Response so dev (localhost:8080) AND same-origin (localhost:8787)
    // both validate without code changes.
    origins: Object.freeze(parseList(env.WEBAUTHN_ORIGINS)),
  }),
  stripe: Object.freeze({
    // null when unset — services/stripe.js uses this as the "feature
    // disabled" signal so the rest of the app keeps working without
    // a Stripe account configured.
    secretKey: env.STRIPE_SECRET_KEY || null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    priceId: env.STRIPE_PRICE_ID || null,
    apiVersion: env.STRIPE_API_VERSION,
    // Convenience flag the rest of the app reads instead of doing a
    // 3-way check across keys.
    enabled: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
  }),
});

// Safe-to-log view of the config. Redacts anything that looks like a secret.
export function redacted() {
  return {
    ...config,
    youtubeApiKey: config.youtubeApiKey
      ? `${config.youtubeApiKey.slice(0, 4)}…redacted`
      : null,
    databaseUrl: config.databaseUrl
      ? config.databaseUrl.replace(/:\/\/[^@/]+@/, '://…redacted@')
      : null,
    session: {
      ...config.session,
      secret: '…redacted',
    },
    mail: {
      ...config.mail,
      resendApiKey: config.mail.resendApiKey ? '…redacted' : null,
    },
    totp: {
      ...config.totp,
      encKey: config.totp.encKey ? '…redacted (explicit)' : 'derived from SESSION_SECRET',
    },
    stripe: {
      ...config.stripe,
      secretKey: config.stripe.secretKey ? '…redacted' : null,
      webhookSecret: config.stripe.webhookSecret ? '…redacted' : null,
    },
  };
}
