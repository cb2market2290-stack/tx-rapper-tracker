-- migrations/017_digest_prefs.sql
-- Phase 3d.2 — weekly digest email preferences.
--
-- Four columns on the existing users table. Default opt-in (locked
-- in PHASE_3D_DESIGN.md) — the digest is what makes the product feel
-- alive for free-tier users who otherwise might never come back.
-- Opt-out is one click via the unsubscribe HMAC token in every email.
--
--   * digest_opted_in       — BOOLEAN, default TRUE.
--   * digest_last_sent_at   — TIMESTAMPTZ, NULL for users who have
--                             never received one yet. Cron's
--                             SELECT FOR UPDATE gate uses this to
--                             prevent double-sending mid-Monday.
--   * digest_last_clicked_at — TIMESTAMPTZ, set when the user clicks
--                             a link in the email. Useful for
--                             eventually pruning "we keep emailing
--                             this person and they never engage"
--                             — explicitly NOT used to auto-pause
--                             v1; we just collect the data.
--   * digest_unsub_token    — TEXT, lazy-set on first send. HMAC of
--                             user_id with config.session.secret;
--                             clicking GET /api/digest/unsubscribe?token
--                             flips opted_in=FALSE without requiring
--                             a re-login. HMAC prevents anyone-with-
--                             the-URL from unsubscribing other users.
--
-- Plus a partial index for the cron's hot path:
--
--   SELECT id, email, digest_last_sent_at, ...
--     FROM users
--    WHERE digest_opted_in
--      AND (digest_last_sent_at IS NULL
--           OR digest_last_sent_at < <last-Monday-09:00>)
--
-- The partial index keeps "users opted-in" cheap to scan even when
-- the table grows — if 10% of users opt out, we don't pay the index
-- cost for them.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS digest_opted_in        BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS digest_last_sent_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS digest_last_clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS digest_unsub_token     TEXT;

-- Cron hot-path index. Partial on opted_in so we don't pay index
-- cost for opted-out users. Sort by last_sent_at ASC so the cron can
-- naturally pull the most-stale users first (= LIMIT N for a single
-- batch, in the order least-recently-sent-to wins).
CREATE INDEX IF NOT EXISTS users_digest_due_idx
  ON users (digest_last_sent_at NULLS FIRST)
  WHERE digest_opted_in;

COMMENT ON COLUMN users.digest_opted_in IS
  'Whether the user receives the weekly digest. Default TRUE; locked in PHASE_3D_DESIGN.md. One-click unsubscribe via digest_unsub_token.';
COMMENT ON COLUMN users.digest_last_sent_at IS
  'Timestamp of the most recent digest send. Cron gate to prevent double-sending mid-Monday.';
COMMENT ON COLUMN users.digest_unsub_token IS
  'HMAC of user_id with config.session.secret; lazy-set on first send. Lets the unsubscribe link work without a re-login.';

COMMIT;
