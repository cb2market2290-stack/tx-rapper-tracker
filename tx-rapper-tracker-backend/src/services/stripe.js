// src/services/stripe.js
// Phase 2c (payments scaffolding).
//
// Thin wrapper around the Stripe Node SDK + the DB tables from
// migration 010. Two responsibilities:
//
//   1. Lazy-init a single Stripe client. We don't construct it at module
//      load because (a) the package is optional in dev — we shouldn't
//      hard-fail if it's not installed, and (b) tests don't need a real
//      client to exercise the pure helpers below.
//
//   2. Provide *pure helpers* (no I/O) that shape Stripe webhook payloads
//      into the columns of stripe_subscriptions. These are the
//      interesting bits to unit-test, since Stripe's payload shape is
//      where future-Stripe-changes will bite us.
//
// Phase 2d additions (revenue path):
//   - createCheckoutSession + createCustomerPortalSession (real SDK calls)
//   - ensureCustomer (get-or-create the Stripe customer for a user)
//   - shapeCheckoutSession + recordCheckoutSession{Start,Complete}
//   - getPlanForUser reads the active_user_plan view added in migration 011
//
// All the DB getters live here too so tests / future routes can pull a
// user's current subscription without re-implementing the JOIN.

import { config } from '../config.js';
import { query } from '../db/pool.js';

// Cached client; null until first getStripe() call.
let _client = null;

/**
 * Returns a configured Stripe client. Throws if STRIPE_SECRET_KEY isn't
 * set or the `stripe` package isn't installed. Callers that should
 * gracefully degrade (e.g. webhook receiver returning 503) should check
 * `config.stripe.enabled` first.
 */
export async function getStripe() {
  if (_client) return _client;
  if (!config.stripe.secretKey) {
    throw new Error('Stripe not configured: STRIPE_SECRET_KEY is empty');
  }
  // Dynamic import so the package is optional. Production envs that
  // need payments must `npm install stripe` separately.
  let StripeMod;
  try {
    StripeMod = await import('stripe');
  } catch (err) {
    throw new Error(
      'Stripe SDK not installed. Run `npm install stripe` in the backend directory.'
    );
  }
  const Stripe = StripeMod.default || StripeMod;
  _client = new Stripe(config.stripe.secretKey, {
    apiVersion: config.stripe.apiVersion,
  });
  return _client;
}

// Test seam: drop the cached client so tests that swap env vars get a
// fresh client. Not exported in a way customers should rely on.
export function _resetStripeClientForTests() {
  _client = null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Stripe surfaces dates as integer Unix seconds. Convert to JS Date
 * (or null when missing) so our DB columns store TIMESTAMPTZ cleanly.
 */
export function unixToDate(secs) {
  if (secs == null) return null;
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

/**
 * Reduce a Stripe `subscription` object (from any subscription.* event
 * or a list call) into the row shape stripe_subscriptions expects.
 *
 * Defensive about Stripe's "I might add fields" stance:
 *   - .items.data[0].price.id is the canonical price id; subs without
 *     items return null.
 *   - .canceled_at can be set on active subs that have a future
 *     cancellation; we record it without inferring status.
 *   - We never throw on missing fields — the caller decides what to
 *     reject.
 */
export function shapeSubscription(sub) {
  if (!sub || typeof sub !== 'object' || !sub.id) {
    throw new Error('shapeSubscription: missing sub.id');
  }
  const item = sub.items && Array.isArray(sub.items.data) && sub.items.data[0];
  const priceId = item && item.price && item.price.id ? item.price.id : null;
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null,
    status: sub.status || 'incomplete',
    priceId,
    currentPeriodStart: unixToDate(sub.current_period_start),
    currentPeriodEnd: unixToDate(sub.current_period_end),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    canceledAt: unixToDate(sub.canceled_at),
  };
}

/**
 * Returns true if the status is one of Stripe's "user can use the paid
 * features now" states. trialing counts (Stripe's own gating treats it
 * as active). past_due is borderline — we treat it as still-paying for
 * a grace window; the actual cutoff is a future Phase 2d decision.
 */
export function isActiveStatus(status) {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

// ---------------------------------------------------------------------------
// DB getters / writers
// ---------------------------------------------------------------------------

/**
 * Look up the Stripe customer id for a user (null if they've never
 * been linked to one). Hot path on every paid-tier check.
 */
export async function getCustomerForUser(userId) {
  const { rows } = await query(
    `SELECT stripe_customer_id, email, created_at
       FROM stripe_customers
      WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * Idempotently link a user to a Stripe customer id. Safe to call on
 * webhook re-deliveries — the UNIQUE on user_id makes ON CONFLICT a
 * no-op when the link already exists.
 */
export async function linkCustomer(userId, { stripeCustomerId, email }) {
  if (!userId || !stripeCustomerId) {
    throw new Error('linkCustomer: userId and stripeCustomerId are required');
  }
  await query(
    `INSERT INTO stripe_customers (user_id, stripe_customer_id, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET email = EXCLUDED.email,
           updated_at = now()`,
    [userId, stripeCustomerId, email || null]
  );
}

/**
 * Write or refresh a stripe_subscriptions row from a webhook payload.
 * The shape input must come from shapeSubscription() so callers can
 * unit-test the shaping in isolation.
 *
 * `lastPayload` is the raw event for forensic debugging — pass the
 * whole sub object you got from Stripe.
 */
export async function upsertSubscription(userId, shaped, lastPayload) {
  if (!userId) throw new Error('upsertSubscription: userId required');
  if (!shaped || !shaped.stripeSubscriptionId) {
    throw new Error('upsertSubscription: shaped.stripeSubscriptionId required');
  }
  await query(
    `INSERT INTO stripe_subscriptions
       (stripe_subscription_id, user_id, stripe_customer_id, status,
        price_id, current_period_start, current_period_end,
        cancel_at_period_end, canceled_at, last_payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (stripe_subscription_id) DO UPDATE
       SET status = EXCLUDED.status,
           price_id = EXCLUDED.price_id,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           canceled_at = EXCLUDED.canceled_at,
           last_payload = EXCLUDED.last_payload,
           updated_at = now()`,
    [
      shaped.stripeSubscriptionId,
      userId,
      shaped.stripeCustomerId,
      shaped.status,
      shaped.priceId,
      shaped.currentPeriodStart,
      shaped.currentPeriodEnd,
      shaped.cancelAtPeriodEnd,
      shaped.canceledAt,
      lastPayload ? JSON.stringify(lastPayload) : null,
    ]
  );
}

/**
 * Record a webhook event before processing so re-deliveries are no-ops.
 * Returns true if this is a new event (caller should process it),
 * false if we've already seen it (caller should ack 200 and skip).
 */
export async function recordEventStart(eventId, eventType, payload) {
  const { rows } = await query(
    `INSERT INTO stripe_webhook_events (event_id, event_type, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType, payload ? JSON.stringify(payload) : null]
  );
  return rows.length > 0;
}

/**
 * Mark an in-flight webhook event as finished (success or failure).
 * Stored for debugging/replay; never used by hot paths.
 */
export async function recordEventFinish(eventId, ok, errMessage) {
  await query(
    `UPDATE stripe_webhook_events
       SET processed_at = now(),
           ok = $2,
           error = $3
     WHERE event_id = $1`,
    [eventId, ok, errMessage ? String(errMessage).slice(0, 500) : null]
  );
}

/**
 * Find an internal user_id from a Stripe customer id. Used by webhook
 * handlers to attach an incoming subscription update to a user.
 */
export async function userForCustomer(stripeCustomerId) {
  const { rows } = await query(
    `SELECT user_id FROM stripe_customers WHERE stripe_customer_id = $1`,
    [stripeCustomerId]
  );
  return rows[0]?.user_id || null;
}

/**
 * Returns the user's "best" current subscription — most recent active one
 * if any, else most recent of any status. Used by the requirePaid()
 * middleware (Phase 2d) and the /api/payments/plan endpoint.
 */
export async function bestSubscriptionForUser(userId) {
  const { rows } = await query(
    `SELECT stripe_subscription_id, status, price_id,
            current_period_end, cancel_at_period_end, canceled_at
       FROM stripe_subscriptions
      WHERE user_id = $1
      ORDER BY (status IN ('active','trialing','past_due')) DESC,
               COALESCE(current_period_end, '1970-01-01'::timestamptz) DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Phase 2d: Checkout Sessions + Customer Portal + plan tier lookup
// ---------------------------------------------------------------------------

/**
 * Reduce a Stripe `checkout.session` object to the row shape
 * stripe_checkout_sessions expects. Pure — no I/O — so the test suite
 * can pin Stripe's payload shape without an SDK.
 *
 * Defensive: Stripe sometimes sends string-typed customer (preferred) and
 * sometimes the expanded object form; this normalises both.
 */
export function shapeCheckoutSession(sess) {
  if (!sess || typeof sess !== 'object' || !sess.id) {
    throw new Error('shapeCheckoutSession: missing sess.id');
  }
  const customer =
    typeof sess.customer === 'string'
      ? sess.customer
      : (sess.customer && sess.customer.id) || null;
  // success_url and cancel_url are required at create time; they should
  // always be present on the completed event echo too.
  return {
    stripeSessionId: sess.id,
    mode: sess.mode || 'subscription',
    stripeCustomerId: customer,
    customerEmail: sess.customer_details?.email || sess.customer_email || null,
    priceId:
      // line_items aren't expanded by default — but on the completed
      // payload we set Stripe to expand them. Tolerate both shapes.
      sess.line_items?.data?.[0]?.price?.id ||
      // Fallback: many setups stash the price in metadata.
      sess.metadata?.price_id ||
      null,
    successUrl: sess.success_url || null,
    cancelUrl: sess.cancel_url || null,
    subscriptionId:
      typeof sess.subscription === 'string'
        ? sess.subscription
        : (sess.subscription && sess.subscription.id) || null,
    paymentStatus: sess.payment_status || null,
  };
}

/**
 * Insert a row when we kick off a Checkout Session. Returns the row.
 * Idempotent on stripe_session_id — Stripe never reuses session ids,
 * so a conflict here means we're being called twice for one create.
 */
export async function recordCheckoutSessionStart({
  stripeSessionId,
  userId,
  mode,
  priceId,
  successUrl,
  cancelUrl,
}) {
  if (!stripeSessionId || !userId) {
    throw new Error('recordCheckoutSessionStart: stripeSessionId + userId required');
  }
  const { rows } = await query(
    `INSERT INTO stripe_checkout_sessions
       (stripe_session_id, user_id, mode, price_id, success_url, cancel_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_session_id) DO NOTHING
     RETURNING stripe_session_id, created_at`,
    [stripeSessionId, userId, mode || 'subscription', priceId || null, successUrl, cancelUrl]
  );
  return rows[0] || null;
}

/**
 * Mark a Checkout Session row complete from the
 * checkout.session.completed webhook. The completion payload is stored
 * in JSONB for replay/debug.
 */
export async function recordCheckoutSessionComplete(stripeSessionId, payload) {
  if (!stripeSessionId) {
    throw new Error('recordCheckoutSessionComplete: stripeSessionId required');
  }
  await query(
    `UPDATE stripe_checkout_sessions
        SET completed_at = now(),
            completion_payload = $2
      WHERE stripe_session_id = $1`,
    [stripeSessionId, payload ? JSON.stringify(payload) : null]
  );
}

/**
 * Read the active_user_plan view for a single user. Returns:
 *   {
 *     plan: 'paid' | 'free',           // back-compat alias
 *     planSlug: 'free' | 'pro' | 'premium' | 'paid',
 *     planRank: 0 | 1 | 2 | 99,        // 99 = unmapped paying sub
 *     planDisplayName: string,
 *     stripeStatus, currentPeriodEnd, cancelAtPeriodEnd
 *   }
 *
 * Hot path on every gated request. The view's underlying join is
 * indexed; for the foreseeable future this is well under a millisecond.
 *
 * Phase 2e.A: extended with planSlug + planRank + planDisplayName from
 * the pricing_tiers join. Old callers comparing .plan === 'paid' still
 * work — that column is retained as a back-compat alias.
 */
export async function getPlanForUser(userId) {
  if (!userId) {
    return {
      plan: 'free',
      planSlug: 'free',
      planRank: 0,
      planDisplayName: 'Free',
    };
  }
  const { rows } = await query(
    `SELECT plan, plan_slug, plan_rank, plan_display_name,
            stripe_status, current_period_end, cancel_at_period_end
       FROM active_user_plan
      WHERE user_id = $1`,
    [userId]
  );
  if (rows.length === 0) {
    // User exists but isn't in the view (shouldn't happen — the LEFT
    // JOIN guarantees a row). Treat as free defensively.
    return {
      plan: 'free',
      planSlug: 'free',
      planRank: 0,
      planDisplayName: 'Free',
      stripeStatus: 'free',
    };
  }
  const r = rows[0];
  return {
    plan: r.plan,
    planSlug: r.plan_slug,
    planRank: r.plan_rank,
    planDisplayName: r.plan_display_name,
    stripeStatus: r.stripe_status,
    currentPeriodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
  };
}

/**
 * Read all pricing tiers in rank order. Returns a list of:
 *   { slug, rank, stripePriceId, displayName, monthlyAmountCents, features, purchasable }
 * `purchasable` is true iff stripe_price_id is non-null AND non-zero
 * monthly_amount_cents (i.e. an actually purchasable paid tier). Free
 * tier is always returned but never purchasable.
 *
 * Frontend reads this to render the Upgrade card; admin uses it to
 * verify wiring at a glance.
 */
export async function getTiers() {
  const { rows } = await query(
    `SELECT slug, rank, stripe_price_id, display_name,
            monthly_amount_cents, features
       FROM pricing_tiers
      ORDER BY rank ASC`
  );
  return rows.map((r) => ({
    slug: r.slug,
    rank: r.rank,
    stripePriceId: r.stripe_price_id,
    displayName: r.display_name,
    monthlyAmountCents: r.monthly_amount_cents,
    features: r.features || [],
    purchasable: Boolean(r.stripe_price_id) && r.rank > 0,
  }));
}

/**
 * Resolve a tier slug → stripe_price_id. Returns null when the slug is
 * unknown OR the tier has no price wired up yet. Caller decides whether
 * to 503 / 400 in that case. Tier 'free' is never purchasable and
 * always returns null.
 */
export async function priceIdForTier(slug) {
  if (!slug || typeof slug !== 'string') return null;
  if (slug === 'free') return null;
  const { rows } = await query(
    `SELECT stripe_price_id FROM pricing_tiers WHERE slug = $1`,
    [slug]
  );
  return rows[0]?.stripe_price_id || null;
}

/**
 * Compare two tier ranks. Returns true iff `a` is at least `b`. Useful
 * for middleware: requirePaid({minTier:'pro'}) compares user's planRank
 * against the rank of 'pro'. Both sides are integers from the view /
 * pricing_tiers — pure compare, no I/O.
 */
export function rankAtLeast(userRank, minRank) {
  return Number.isFinite(userRank) && Number.isFinite(minRank) && userRank >= minRank;
}

/**
 * Get-or-create the Stripe customer for a user. Used by both
 * createCheckoutSession and createCustomerPortalSession — both flows
 * need a customer id to attach the session/portal to.
 *
 * Why not let Checkout auto-create one with `customer_email`? Because
 * we'd then have a one-off customer per session, breaking the link
 * between subsequent webhook events and the user. Creating it ourselves
 * up-front means stripe_customers always has the row before any
 * subscription event lands.
 *
 * Returns the Stripe customer id.
 */
export async function ensureCustomer(userId, email) {
  if (!userId) throw new Error('ensureCustomer: userId required');
  const existing = await getCustomerForUser(userId);
  if (existing) return existing.stripe_customer_id;

  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    email: email || undefined,
    // Tagging with our user id makes the dashboard searchable + lets
    // ops humans confirm "yes, this Stripe customer is X in our DB".
    metadata: { app_user_id: userId },
  });
  await linkCustomer(userId, { stripeCustomerId: customer.id, email });
  return customer.id;
}

/**
 * Create a Stripe Checkout Session for a subscription purchase. Returns
 * the hosted URL the caller should redirect the user to. Also writes a
 * stripe_checkout_sessions row so we can audit the create.
 *
 * The session is created with line_items expansion enabled so the
 * webhook payload contains the price id without a follow-up API call.
 */
export async function createCheckoutSession({
  userId,
  email,
  priceId,
  successUrl,
  cancelUrl,
  mode = 'subscription',
}) {
  if (!userId) throw new Error('createCheckoutSession: userId required');
  if (!priceId) throw new Error('createCheckoutSession: priceId required');
  if (!successUrl || !cancelUrl) {
    throw new Error('createCheckoutSession: successUrl + cancelUrl required');
  }
  const stripe = await getStripe();
  const customerId = await ensureCustomer(userId, email);

  const session = await stripe.checkout.sessions.create({
    mode,
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Echo our user id so a webhook payload alone is enough to find them
    // (defense-in-depth — we already have stripe_customers, but a missing
    // row there shouldn't break checkout completion).
    client_reference_id: userId,
    metadata: { app_user_id: userId, price_id: priceId },
    // Expand line_items in the completed-event payload.
    expand: ['line_items'],
  });

  await recordCheckoutSessionStart({
    stripeSessionId: session.id,
    userId,
    mode,
    priceId,
    successUrl,
    cancelUrl,
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Create a Customer Portal Session — the hosted page where the user can
 * cancel, update payment method, view invoices. Returns the URL.
 */
export async function createCustomerPortalSession({ userId, email, returnUrl }) {
  if (!userId) throw new Error('createCustomerPortalSession: userId required');
  if (!returnUrl) throw new Error('createCustomerPortalSession: returnUrl required');
  const stripe = await getStripe();
  const customerId = await ensureCustomer(userId, email);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}
