-- migrations/007_totp.sql
-- Phase 2b.13: TOTP 2FA enrollment + recovery codes + session stage.
--
-- Design notes:
--   * user_totp holds one row per user who has enrolled (one-to-zero-or-one
--     with users.id). secret_encrypted is AES-256-GCM ciphertext keyed by
--     TOTP_ENC_KEY (env); we keep the iv|authTag|ciphertext in one BYTEA so
--     rotating is a single column update, not a schema change.
--   * confirmed_at separates "starting enrollment" (row inserted during
--     POST /2fa/enroll) from "verified the code" (POST /2fa/enroll/verify).
--     An unconfirmed row is treated as no-2fa and can be overwritten.
--   * Recovery codes are Argon2id-hashed and consumed atomically
--     (consumed_at = now()), so we never store the plaintext. 10 per user
--     is enough for a lost-phone scenario; UI surfaces a "regenerate" path
--     later under Phase 2b.14.
--   * sessions.stage encodes the login ladder:
--         'pre_2fa'    - waiting on the second factor (5-min expiry)
--         NULL / 'ok'  - full session (treat NULL as 'ok' for back-compat)
--     Using TEXT instead of an enum to keep future stages (WebAuthn) trivial.
--   * users.mfa_enrolled_at was reserved in 001_init.sql; we populate it on
--     successful enroll so /api/auth/me can report MFA status without a join.
--
-- This migration is idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF
-- NOT EXISTS on the sessions change).

CREATE TABLE IF NOT EXISTS user_totp (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted  BYTEA       NOT NULL,
  algorithm         TEXT        NOT NULL DEFAULT 'SHA1',  -- otplib default; Google Auth expects SHA1
  digits            INT         NOT NULL DEFAULT 6,
  period_seconds    INT         NOT NULL DEFAULT 30,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at      TIMESTAMPTZ,                          -- NULL = started but unverified
  last_used_at      TIMESTAMPTZ                           -- updated on successful /2fa/verify
);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT        NOT NULL,                       -- Argon2id of the plaintext code
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ                                 -- NULL = unused
);

-- Fast lookup of remaining codes (admin "X recovery codes left" + verify loop).
CREATE INDEX IF NOT EXISTS user_recovery_codes_active_idx
  ON user_recovery_codes (user_id) WHERE consumed_at IS NULL;

-- sessions.stage: NULL means full session (back-compat with all existing rows).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS stage TEXT;

-- Pre-2FA sessions are short-lived; index so the cleanup sweep can find them.
CREATE INDEX IF NOT EXISTS sessions_stage_idx
  ON sessions (stage) WHERE stage IS NOT NULL;
