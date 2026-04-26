-- 011_checkout_sessions.sql
-- Phase 2d (payments revenue path).
--
-- Adds the Checkout Session log table and the active_user_plan view.
-- Both build on the Phase 2c base (010_stripe_payments.sql) and don't
-- alter any of those tables — pure additions, safe to migrate forward
-- and (with a corresponding manual rollback) backward.
--
-- Design notes:
--
--   * stripe_checkout_sessions logs every Checkout Session we create.
--     We only INSERT here on create (POST /api/payments/checkout); the
--     webhook handler UPDATEs to mark completed_at when
--     checkout.session.completed arrives. Idempotent on the natural
--     key (Stripe's session id).
--
--   * The "did this checkout finish?" question is answered by the
--     subscription state in stripe_subscriptions, NOT by this table.
--     This table is for debugging + audit ("we created a session for
--     this user — did Stripe ever call back?"). Keeping the question
--     answered by the subscription state means a forced re-sync from
--     Stripe still gives the right answer.
--
--   * active_user_plan is a SQL view (not a materialized one) so it's
--     always live. It joins users → stripe_subscriptions and picks the
--     "best" subscription per user via DISTINCT ON, where "best" means:
--       1. status in ('active','trialing','past_due')   — paying
--       2. else status = 'canceled' or 'incomplete'      — fall through
--     Tie-break: most recently updated. The plan column is a coarse
--     bucket the app cares about — 'paid' or 'free' — so the routes
--     don't have to know Stripe's status enum.
--
--   * Why not put plan on users.plan? Because Stripe is the source of
--     truth and a denormalized column drifts. The view is one indexed
--     join; it's fine.

BEGIN;

CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
  -- Stripe's session id (cs_…) is the natural key.
  stripe_session_id  TEXT PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'subscription' is the only mode we ship today; 'payment' is reserved
  -- for one-time charges later (no schema change needed).
  mode               TEXT NOT NULL CHECK (mode IN ('subscription', 'payment')),
  price_id           TEXT,                              -- the Stripe price the user picked
  success_url        TEXT NOT NULL,                     -- where Stripe redirects on success
  cancel_url         TEXT NOT NULL,                     -- where Stripe redirects on cancel
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Filled by the checkout.session.completed webhook. Null = pending.
  completed_at       TIMESTAMPTZ,
  -- Raw event payload from the completion webhook (not the session
  -- create response — we don't need that). JSONB so it's queryable.
  completion_payload JSONB
);

-- Hot lookup: "what's the latest checkout for this user?" — Phase 2d
-- frontend uses this to know whether to poll for plan flip after redirect.
CREATE INDEX IF NOT EXISTS stripe_checkout_sessions_user_idx
  ON stripe_checkout_sessions (user_id, created_at DESC);

-- "Was this session completed?" — supports the future audit panel.
CREATE INDEX IF NOT EXISTS stripe_checkout_sessions_completed_idx
  ON stripe_checkout_sessions (completed_at)
  WHERE completed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- active_user_plan view
-- ---------------------------------------------------------------------------
-- One row per user, with the coarse plan tier the app gates on.
-- Users with no stripe_subscriptions row appear as 'free'.
--
-- Performance: the underlying query uses the existing
-- stripe_subscriptions_user_status_idx for the DISTINCT ON sort, plus
-- a sequential scan of users (small). For the foreseeable future this
-- is well under 1ms even with thousands of users.

CREATE OR REPLACE VIEW active_user_plan AS
SELECT
  u.id                                    AS user_id,
  u.email                                 AS email,
  COALESCE(s.status, 'free')              AS stripe_status,
  COALESCE(s.stripe_subscription_id, '')  AS stripe_subscription_id,
  COALESCE(s.price_id, '')                AS price_id,
  CASE
    WHEN s.status IN ('active', 'trialing', 'past_due') THEN 'paid'
    ELSE 'free'
  END                                     AS plan,
  s.current_period_end                    AS current_period_end,
  s.cancel_at_period_end                  AS cancel_at_period_end
FROM users u
LEFT JOIN LATERAL (
  -- "Best" subscription: paying ones first, then most recently updated.
  -- The CASE in ORDER BY ranks the status enum so 'active' beats 'canceled'.
  SELECT *
    FROM stripe_subscriptions ss
   WHERE ss.user_id = u.id
   ORDER BY
     CASE ss.status
       WHEN 'active'     THEN 0
       WHEN 'trialing'   THEN 1
       WHEN 'past_due'   THEN 2
       WHEN 'incomplete' THEN 3
       WHEN 'canceled'   THEN 4
       ELSE 5
     END,
     ss.updated_at DESC
   LIMIT 1
) s ON TRUE;

COMMENT ON VIEW active_user_plan IS
  'One row per user. plan = paid|free. Source of truth for paid-tier gating; do NOT denormalize onto users.';

COMMIT;
