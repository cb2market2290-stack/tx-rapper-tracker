// test/stripe.test.js
// Offline coverage for src/services/stripe.js — the pure helpers that
// shape Stripe webhook payloads into our DB row format. Future Stripe
// API tweaks will land here first.
//
// We DON'T test:
//   * The Stripe SDK itself (lazy-imported, not present in test env).
//   * The DB writers (linkCustomer, upsertSubscription, etc.) — those
//     are thin SQL wrappers and require a live Postgres. The HTTP
//     smoke (scripts/test-payments.sh) covers them.
//   * The webhook signature verification — that's the SDK's job.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Required env BEFORE importing stripe.js (which transitively loads
// config.js + db/pool.js).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const {
  unixToDate,
  shapeSubscription,
  shapeCheckoutSession,
  isActiveStatus,
  getStripe,
  getPlanForUser,
  rankAtLeast,
  priceIdForTier,
  _resetStripeClientForTests,
} = await import('../src/services/stripe.js');
const { config } = await import('../src/config.js');

// ---------------------------------------------------------------------------
// unixToDate
// ---------------------------------------------------------------------------

test('unixToDate returns null for null/undefined/zero/negative', () => {
  assert.equal(unixToDate(null), null);
  assert.equal(unixToDate(undefined), null);
  assert.equal(unixToDate(0), null);
  assert.equal(unixToDate(-1), null);
  assert.equal(unixToDate('not a number'), null);
});

test('unixToDate converts integer Unix seconds to Date', () => {
  const d = unixToDate(1700000000);          // 2023-11-14T22:13:20Z
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1700000000 * 1000);
});

test('unixToDate accepts numeric strings', () => {
  // Stripe always sends numbers, but our shaping should tolerate string ints.
  const d = unixToDate('1700000000');
  assert.equal(d.getTime(), 1700000000 * 1000);
});

// ---------------------------------------------------------------------------
// shapeSubscription
// ---------------------------------------------------------------------------

test('shapeSubscription throws on missing sub.id', () => {
  assert.throws(() => shapeSubscription(null));
  assert.throws(() => shapeSubscription({}));
  assert.throws(() => shapeSubscription({ status: 'active' }));
});

test('shapeSubscription pulls priceId from items.data[0].price.id', () => {
  const sub = {
    id: 'sub_123',
    customer: 'cus_456',
    status: 'active',
    items: { data: [{ price: { id: 'price_abc' } }] },
    current_period_start: 1700000000,
    current_period_end:   1702592000,
    cancel_at_period_end: false,
    canceled_at: null,
  };
  const out = shapeSubscription(sub);
  assert.equal(out.stripeSubscriptionId, 'sub_123');
  assert.equal(out.stripeCustomerId, 'cus_456');
  assert.equal(out.status, 'active');
  assert.equal(out.priceId, 'price_abc');
  assert.ok(out.currentPeriodStart instanceof Date);
  assert.ok(out.currentPeriodEnd instanceof Date);
  assert.equal(out.cancelAtPeriodEnd, false);
  assert.equal(out.canceledAt, null);
});

test('shapeSubscription returns null priceId when items missing', () => {
  const out = shapeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'incomplete' });
  assert.equal(out.priceId, null);
});

test('shapeSubscription handles expanded customer object form', () => {
  // When ?expand=customer is used, sub.customer is the object, not the id string.
  const sub = {
    id: 'sub_2',
    customer: { id: 'cus_obj_1', email: 'foo@example.com' },
    status: 'trialing',
    items: { data: [{ price: { id: 'price_1' } }] },
  };
  const out = shapeSubscription(sub);
  assert.equal(out.stripeCustomerId, 'cus_obj_1');
});

test('shapeSubscription defaults status to incomplete when missing', () => {
  // Defensive: should never happen in real Stripe payloads, but a safe default
  // beats writing NULL into a NOT NULL column.
  const out = shapeSubscription({ id: 'sub_3', customer: 'cus_3' });
  assert.equal(out.status, 'incomplete');
});

test('shapeSubscription preserves cancel-at-period-end flag', () => {
  const out = shapeSubscription({
    id: 'sub_4', customer: 'cus_4', status: 'active',
    cancel_at_period_end: true,
    canceled_at: 1700000000,
  });
  assert.equal(out.cancelAtPeriodEnd, true);
  assert.ok(out.canceledAt instanceof Date);
});

// ---------------------------------------------------------------------------
// isActiveStatus
// ---------------------------------------------------------------------------

test('isActiveStatus: active / trialing / past_due count as paying', () => {
  assert.equal(isActiveStatus('active'), true);
  assert.equal(isActiveStatus('trialing'), true);
  assert.equal(isActiveStatus('past_due'), true);
});

test('isActiveStatus: canceled / incomplete / unpaid do NOT count as paying', () => {
  assert.equal(isActiveStatus('canceled'), false);
  assert.equal(isActiveStatus('incomplete'), false);
  assert.equal(isActiveStatus('incomplete_expired'), false);
  assert.equal(isActiveStatus('unpaid'), false);
  assert.equal(isActiveStatus(''), false);
  assert.equal(isActiveStatus(null), false);
  assert.equal(isActiveStatus(undefined), false);
});

// ---------------------------------------------------------------------------
// getStripe — error paths only (no SDK installed in test sandbox)
// ---------------------------------------------------------------------------

test('getStripe throws when STRIPE_SECRET_KEY is empty', async () => {
  // Default config.stripe.secretKey is null in test env. getStripe should
  // throw a clear error so callers don't silently 500.
  _resetStripeClientForTests();
  await assert.rejects(
    () => getStripe(),
    /STRIPE_SECRET_KEY is empty/
  );
});

test('config.stripe.enabled is false when keys missing', () => {
  // Sanity: the convenience flag must agree with the explicit checks.
  assert.equal(config.stripe.enabled, false);
  assert.equal(config.stripe.secretKey, null);
  assert.equal(config.stripe.webhookSecret, null);
});

// ---------------------------------------------------------------------------
// shapeCheckoutSession (Phase 2d) — pin the payload-shape contract
// ---------------------------------------------------------------------------
// These tests guard the boundary between Stripe's checkout.session payload
// and the stripe_checkout_sessions row. They DON'T need a network or DB —
// the helper is pure. Future Stripe shape tweaks will fail here first.

test('shapeCheckoutSession throws on missing sess.id', () => {
  assert.throws(() => shapeCheckoutSession(null));
  assert.throws(() => shapeCheckoutSession({}));
  assert.throws(() => shapeCheckoutSession({ mode: 'subscription' }));
});

test('shapeCheckoutSession normalizes string customer to id', () => {
  // Default Stripe shape: customer is a string id, not an expanded object.
  const out = shapeCheckoutSession({
    id: 'cs_str_1',
    customer: 'cus_111',
    mode: 'subscription',
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.stripeSessionId, 'cs_str_1');
  assert.equal(out.stripeCustomerId, 'cus_111');
  assert.equal(out.mode, 'subscription');
  assert.equal(out.successUrl, 'https://example.com/?ok=1');
  assert.equal(out.cancelUrl, 'https://example.com/?ok=0');
});

test('shapeCheckoutSession unwraps expanded customer object form', () => {
  // When ?expand=customer is used, customer is an object instead of a string id.
  const out = shapeCheckoutSession({
    id: 'cs_obj_1',
    customer: { id: 'cus_obj_222', email: 'foo@example.com' },
    mode: 'subscription',
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.stripeCustomerId, 'cus_obj_222');
});

test('shapeCheckoutSession returns null customer when neither string nor object', () => {
  // Real Stripe payloads always include a customer for subscription mode,
  // but tolerate the missing-field case rather than throwing.
  const out = shapeCheckoutSession({
    id: 'cs_no_cust',
    mode: 'subscription',
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.stripeCustomerId, null);
});

test('shapeCheckoutSession reads priceId from line_items.data[0].price.id', () => {
  // Canonical path: we ?expand=line_items so the completed-event payload
  // has the price right there.
  const out = shapeCheckoutSession({
    id: 'cs_li_1',
    customer: 'cus_1',
    mode: 'subscription',
    line_items: { data: [{ price: { id: 'price_canon' } }] },
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.priceId, 'price_canon');
});

test('shapeCheckoutSession falls back to metadata.price_id when line_items absent', () => {
  // Webhooks that aren't expanded still carry the price in our metadata
  // (set at create time in createCheckoutSession). Make sure the fallback
  // wires through.
  const out = shapeCheckoutSession({
    id: 'cs_meta_1',
    customer: 'cus_2',
    mode: 'subscription',
    metadata: { price_id: 'price_from_meta', app_user_id: 'u-123' },
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.priceId, 'price_from_meta');
});

test('shapeCheckoutSession yields null priceId when neither source is present', () => {
  const out = shapeCheckoutSession({
    id: 'cs_no_price',
    customer: 'cus_3',
    mode: 'subscription',
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.priceId, null);
});

test('shapeCheckoutSession defaults mode to subscription when missing', () => {
  // Defensive: real Stripe payloads always include mode, but a safe default
  // beats a NULL violation in the CHECK constraint.
  const out = shapeCheckoutSession({
    id: 'cs_no_mode',
    customer: 'cus_4',
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.mode, 'subscription');
});

test('shapeCheckoutSession unwraps subscription object id', () => {
  // subscription is null at create time, then the completed-event payload
  // includes either the string id (default) or the expanded object.
  const out = shapeCheckoutSession({
    id: 'cs_sub_obj',
    customer: 'cus_5',
    mode: 'subscription',
    subscription: { id: 'sub_42' },
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.subscriptionId, 'sub_42');
});

test('shapeCheckoutSession surfaces customer_details.email + payment_status', () => {
  const out = shapeCheckoutSession({
    id: 'cs_email',
    customer: 'cus_6',
    mode: 'subscription',
    customer_details: { email: 'paid@example.com' },
    payment_status: 'paid',
    success_url: 'https://example.com/?ok=1',
    cancel_url:  'https://example.com/?ok=0',
  });
  assert.equal(out.customerEmail, 'paid@example.com');
  assert.equal(out.paymentStatus, 'paid');
});

// ---------------------------------------------------------------------------
// getPlanForUser — offline guard for the falsy-userId fast path
// ---------------------------------------------------------------------------
// The view-backed lookup needs Postgres, but the "no userId? assume free"
// branch is pure and lives at the top of the function. Test it so we
// don't accidentally remove the guard in a refactor.

test('getPlanForUser returns free shape for falsy userId without DB call', async () => {
  // Important: this would crash if the function tried to query — the
  // test env has no DB. So a passing run also implicitly verifies the
  // early-return.
  // Phase 2e.A: shape extended with planSlug/planRank/planDisplayName.
  const expected = {
    plan: 'free',
    planSlug: 'free',
    planRank: 0,
    planDisplayName: 'Free',
  };
  for (const arg of [null, undefined, '', 0, false]) {
    const out = await getPlanForUser(arg);
    assert.deepEqual(out, expected, `falsy userId ${JSON.stringify(arg)}`);
  }
});

// ---------------------------------------------------------------------------
// rankAtLeast — pure helper, no I/O
// ---------------------------------------------------------------------------

test('rankAtLeast: equal ranks pass', () => {
  assert.equal(rankAtLeast(1, 1), true);
  assert.equal(rankAtLeast(0, 0), true);
  assert.equal(rankAtLeast(99, 99), true);
});

test('rankAtLeast: higher passes, lower fails', () => {
  assert.equal(rankAtLeast(2, 1), true);     // premium >= pro
  assert.equal(rankAtLeast(99, 1), true);    // unmapped paying >= pro
  assert.equal(rankAtLeast(1, 2), false);    // pro >= premium → false
  assert.equal(rankAtLeast(0, 1), false);    // free >= pro → false
});

test('rankAtLeast: non-finite inputs return false', () => {
  assert.equal(rankAtLeast(null, 1), false);
  assert.equal(rankAtLeast(undefined, 1), false);
  assert.equal(rankAtLeast(NaN, 1), false);
  assert.equal(rankAtLeast('1', 1), false);  // strict — must be a number
  assert.equal(rankAtLeast(1, null), false);
  assert.equal(rankAtLeast(1, NaN), false);
});

// ---------------------------------------------------------------------------
// priceIdForTier — offline guard for the falsy-slug + 'free' fast paths
// ---------------------------------------------------------------------------
// Like getPlanForUser, the DB-backed lookup needs Postgres, but the
// guards at the top of the function are pure. Test those here so a
// refactor that drops them is loud.

test("priceIdForTier returns null for 'free' without DB call", async () => {
  // 'free' is never purchasable — the function must short-circuit before
  // querying. A passing run in this no-DB test env proves the guard.
  const out = await priceIdForTier('free');
  assert.equal(out, null);
});

test('priceIdForTier returns null for falsy / non-string slug without DB call', async () => {
  for (const arg of [null, undefined, '', 0, false, 42, {}]) {
    const out = await priceIdForTier(arg);
    assert.equal(out, null, `slug ${JSON.stringify(arg)}`);
  }
});
