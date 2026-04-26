-- migrations/001_init.sql
-- Phase 2b foundation: users, sessions, and an audit log for auth events.
--
-- Design notes:
--   * id is a UUID v4 so we never leak sequential user counts through the URL.
--   * email is citext so "Paul@..." and "paul@..." match the same account.
--   * password_hash is an Argon2id string ($argon2id$v=19$m=...$t=...$p=...$salt$hash).
--   * session_token_hash is sha256 of the random token — we never store the raw
--     token, so a DB dump doesn't let you impersonate live sessions.
--   * ON DELETE CASCADE on sessions: deleting a user nukes their sessions too.
--   * audit_log is append-only; no FK so we keep rows after a user is deleted.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  -- Reserved for Phase 2b.2; nullable for now so MFA can be added later.
  mfa_enrolled_at TIMESTAMPTZ,
  is_disabled     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip                  INET,
  user_agent          TEXT,
  revoked_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx  ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx  ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     UUID,            -- no FK: keep after user delete
  event       TEXT NOT NULL,   -- e.g. 'signup', 'login', 'login_failed', 'logout'
  ip          INET,
  user_agent  TEXT,
  details     JSONB
);

CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_event_idx ON audit_log (event, at DESC);
