-- 010_stripe_payments.sql
-- Phase 2c (payments scaffolding).
--
-- Tables to bridge our internal users with Stripe's customer + subscription
-- records. We're not wiring checkout flows yet — that's Phase 2d. The point
-- of this migration is so the webhook receiver has somewhere to write when
-- it lands, and so the Stripe customer-id mapping isn't a panic-rewrite
-- when we flip the switch.
--
-- Design notes:
--   * One stripe_customers row per user — Stripe's "customer" is the
--     persistent identity, subscriptions come and go beneath it. Using a
--     hard FK + UNIQUE on user_id catches double-creation bugs early.
--   * stripe_subscriptions stores Stripe's authoritative state. We never
--     trust the frontend for "is this user paying?" — read from this table,
--     which is updated by webhook events.
--   * status mirrors Stripe's literal strings (active, trialing, past_due,
--     canceled, incomplete, etc) so we can join across versions of the API
--     without a translation layer.
--   * Webhook idempotency: stripe_webhook_events records every received
--     event id so re-deliveries don't double-apply. Stripe explicitly
--     supports re-sending events on failure, so this is load-bearing.

BEGIN;

CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  email             TEXT,                           -- snapshot at create time; may drift from users.email
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Look up by Stripe id when a webhook event arrives keyed on customer.
CREATE INDEX IF NOT EXISTS stripe_customers_stripe_id_idx
  ON stripe_customers (stripe_customer_id);

CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  -- Stripe's subscription id is the natural key. A user may have many
  -- subscriptions over time (cancel/resubscribe/upgrade), so don't
  -- constrain to one-per-user.
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL,
  status                 TEXT NOT NULL,            -- active | trialing | past_due | canceled | incomplete | ...
  price_id               TEXT,                     -- Stripe price.id; null if subscription has no price (rare)
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at            TIMESTAMPTZ,
  -- Raw payload from the most recent webhook update. Useful for debugging
  -- when Stripe adds fields we haven't modeled yet. JSONB so it's
  -- queryable but cheap when we don't need it.
  last_payload           JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot lookup: "does this user have an active subscription?" runs on
-- almost every gated request once paid tier is wired.
CREATE INDEX IF NOT EXISTS stripe_subscriptions_user_status_idx
  ON stripe_subscriptions (user_id, status);

CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_idx
  ON stripe_subscriptions (stripe_customer_id);

-- Webhook idempotency log — Stripe re-delivers events on failure, so we
-- ON CONFLICT DO NOTHING on insert and short-circuit any handler if the
-- event id was already processed. event_id is unique (Stripe guarantees
-- this); we keep payload + processed_at for debugging.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,                   -- evt_… from Stripe
  event_type   TEXT NOT NULL,                      -- customer.subscription.updated, etc.
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  ok           BOOLEAN,                            -- final outcome (true/false), null while in flight
  error        TEXT,                               -- first-line error if any
  payload      JSONB                               -- raw event for replay/debug
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_received_at_idx
  ON stripe_webhook_events (received_at DESC);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx
  ON stripe_webhook_events (event_type, received_at DESC);

COMMIT;
