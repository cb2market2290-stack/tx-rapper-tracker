-- migrations/002_password_reset.sql
-- Table for future SMTP-based password-reset flow (Phase 2b.2).
-- The route that generates these tokens isn't wired yet (deferred until we
-- pick an email provider), but the schema is ready so the later code change
-- doesn't require another migration.
--
-- Design mirrors sessions: we store sha256(token) only, never the raw.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,           -- set when the reset is consumed
  requested_ip INET,
  requested_user_agent TEXT
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx
  ON password_reset_tokens (expires_at);
