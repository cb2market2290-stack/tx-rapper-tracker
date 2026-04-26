-- 012_pricing_tiers.sql
-- Phase 2e.A — multi-tier pricing.
--
-- Replaces the single binary plan ('paid' | 'free') from migration 011 with
-- a slug-based ladder of tiers (free → pro → premium) that maps to Stripe
-- prices via a small lookup table. The view active_user_plan is rewritten
-- to surface the slug + rank so middleware can compare "user is at least
-- minTier".
--
-- Design notes:
--
--   * pricing_tiers is the single source of truth for tier metadata. The
--     stripe_price_id column is left NULL at migration time — operators
--     fill it in via scripts/seed-pricing-tiers.js after creating prices
--     in the Stripe Dashboard. Until then, the tier exists but no
--     subscription can map to it.
--
--   * Why a table not a config map? Two reasons. First, the view needs
--     it for the SQL JOIN — config in JS would force the tier mapping
--     into application code, which means routes and admin queries would
--     have to fetch + decorate. Second, ops humans can `SELECT * FROM
--     pricing_tiers` and immediately see what's wired.
--
--   * The view falls back to plan='paid' rank=99 when a subscription's
--     price_id isn't in pricing_tiers. This preserves the migration-011
--     gating semantics for any prices the operator hasn't seeded yet —
--     paying users keep paying, they just don't have a friendly tier
--     name. requirePaid() with no minTier still grants access. Calling
--     requirePaid({minTier:'pro'}) on an unmapped paid sub WILL fail,
--     which is the right loudness — operator should seed.
--
--   * Backward compat: callers that read `plan` and compare to 'paid'
--     still work in the unmapped fallback case. New callers compare
--     plan_rank instead.

BEGIN;

CREATE TABLE IF NOT EXISTS pricing_tiers (
  -- Lowercase slug ('free' | 'pro' | 'premium'); referenced from JS by
  -- the same string.
  slug                 TEXT PRIMARY KEY,
  -- Ordering rank for "minimum tier" comparisons. 0=free, higher=more.
  -- Gaps are allowed — leave 10/20/30 if you want room to insert later.
  rank                 INT NOT NULL,
  -- The Stripe price id for this tier (price_…). Filled in after the
  -- price exists in the Stripe Dashboard. NULL means "tier defined but
  -- not purchasable yet" — the free tier is permanently NULL here.
  stripe_price_id      TEXT,
  -- Human-readable name for the plan-pill + Upgrade card.
  display_name         TEXT NOT NULL,
  -- For the public pricing page. Stored in the smallest unit (cents).
  -- 0 for free, NULL when not yet set on a paid tier.
  monthly_amount_cents INT,
  -- Free-form JSONB for "what does this tier get you?" — bullet list
  -- the frontend renders into the Upgrade card. Optional today, useful
  -- later.
  features             JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helps "WHERE stripe_price_id = $1" lookups during webhook + plan reads.
CREATE INDEX IF NOT EXISTS pricing_tiers_price_idx
  ON pricing_tiers (stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

-- Seed the three default tiers. The price ids are populated later via
-- scripts/seed-pricing-tiers.js. Idempotent: ON CONFLICT no-ops on rerun.
INSERT INTO pricing_tiers (slug, rank, display_name, monthly_amount_cents, features)
VALUES
  ('free',    0, 'Free',    0,    '["Up to 5 artists","Daily charts","Standard ranking"]'::jsonb),
  ('pro',     1, 'Pro',     NULL, '["Unlimited artists","Audio feature analysis","Custom search"]'::jsonb),
  ('premium', 2, 'Premium', NULL, '["Everything in Pro","Compare mode","Priority extraction"]'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Replace active_user_plan view
-- ---------------------------------------------------------------------------
-- New columns:
--   plan_slug       -- 'free' | 'pro' | 'premium' | (rare) 'paid'
--   plan_rank       -- INT for minTier comparisons in middleware
--   plan_display_name
-- Backcompat columns (kept):
--   plan            -- alias of plan_slug (so existing callers still work)
--   stripe_status, stripe_subscription_id, price_id, current_period_end,
--   cancel_at_period_end

DROP VIEW IF EXISTS active_user_plan;

CREATE VIEW active_user_plan AS
SELECT
  u.id                                     AS user_id,
  u.email                                  AS email,
  COALESCE(s.status, 'free')               AS stripe_status,
  COALESCE(s.stripe_subscription_id, '')   AS stripe_subscription_id,
  COALESCE(s.price_id, '')                 AS price_id,
  -- plan_slug: prefer the seeded tier; for unmapped paying subs fall
  -- back to 'paid' (preserves migration-011 semantics); else 'free'.
  CASE
    WHEN pt.slug IS NOT NULL THEN pt.slug
    WHEN s.status IN ('active','trialing','past_due') THEN 'paid'
    ELSE 'free'
  END                                      AS plan_slug,
  CASE
    WHEN pt.rank IS NOT NULL THEN pt.rank
    WHEN s.status IN ('active','trialing','past_due') THEN 99  -- unmapped paying
    ELSE 0
  END                                      AS plan_rank,
  COALESCE(pt.display_name,
    CASE
      WHEN s.status IN ('active','trialing','past_due') THEN 'Paid'
      ELSE 'Free'
    END)                                   AS plan_display_name,
  -- Back-compat alias — old callers read .plan and compare to 'paid'
  -- or 'free'. Keep it usable: paying tiers (pro, premium, paid) all
  -- map to 'paid' here so the boolean check still works.
  CASE
    WHEN s.status IN ('active','trialing','past_due') THEN 'paid'
    ELSE 'free'
  END                                      AS plan,
  s.current_period_end                     AS current_period_end,
  s.cancel_at_period_end                   AS cancel_at_period_end
FROM users u
LEFT JOIN LATERAL (
  -- Same "best subscription" picker as migration 011.
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
) s ON TRUE
LEFT JOIN pricing_tiers pt ON pt.stripe_price_id = s.price_id;

COMMENT ON VIEW active_user_plan IS
  'One row per user. plan_slug = free|pro|premium|paid (paid = unmapped paying). Source of truth for paid-tier gating.';

COMMIT;
