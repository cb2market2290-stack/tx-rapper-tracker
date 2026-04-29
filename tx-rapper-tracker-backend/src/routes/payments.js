// src/routes/payments.js
// Phase 2c (payments scaffolding).
//
// Webhook receiver for Stripe events. The route mounts under
// /api/payments/webhook and is the *only* place we trust to mutate
// stripe_subscriptions — there's no client-driven "I just paid"
// endpoint, by design. The browser never tells us about money.
//
// Important wiring quirks:
//
//   * Stripe signs the RAW request body. By the time express.json()
//     has parsed it, the bytes don't match the signature anymore. We
//     mount this handler with express.raw() so req.body is a Buffer.
//     The mount in src/index.js needs to be ahead of any global
//     express.json() — we expose buildRouter() so the wiring is
//     explicit there.
//
//   * If Stripe is disabled (no keys configured), we return 503 from
//     the receiver instead of 404. 503 communicates "this endpoint
//     exists but is intentionally off" so a misconfigured production
//     deploy is loud, not silent.
//
//   * Webhook handlers must be idempotent. Stripe re-delivers events
//     on 5xx or timeout. We INSERT … ON CONFLICT into
//     stripe_webhook_events at the start of each request and
//     short-circuit if the event id was already processed.

import { Router } from 'express';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { requireUser } from '../middleware/authenticate.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  getStripe,
  shapeSubscription,
  upsertSubscription,
  recordEventStart,
  recordEventFinish,
  userForCustomer,
  // Phase 2d revenue path
  shapeCheckoutSession,
  recordCheckoutSessionComplete,
  createCheckoutSession,
  createCustomerPortalSession,
  getPlanForUser,
  getTiers,
  priceIdForTier,
  linkCustomer,
} from '../services/stripe.js';
import { query } from '../db/pool.js';
// Phase 3d.3 — referral coupon hook for checkout.session.completed.
import { createReferralCoupon } from '../services/referrals.js';

/**
 * Build the payments router. Exported as a builder (not a default
 * Router) so src/index.js can mount it with the express.raw() body
 * parser specifically — global express.json() would consume the bytes
 * Stripe needs to verify the signature.
 */
export function buildRouter() {
  const router = Router();

  // --- POST /api/payments/webhook ----------------------------------------
  // Stripe delivers events here. The raw body parser is mounted at the
  // route, not the app, so the rest of the API still uses JSON.
  router.post(
    '/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    handleWebhook
  );

  // --- GET /api/payments/status ------------------------------------------
  // Trivial diagnostic — returns whether payments are enabled. Useful
  // for the readiness script + a future admin panel widget. Doesn't
  // leak any subscription data.
  router.get('/status', (_req, res) => {
    res.json({
      kind: 'payments.status',
      enabled: config.stripe.enabled,
      hasSecretKey: Boolean(config.stripe.secretKey),
      hasWebhookSecret: Boolean(config.stripe.webhookSecret),
      hasPriceId: Boolean(config.stripe.priceId),
      apiVersion: config.stripe.apiVersion,
    });
  });

  // --- GET /api/payments/plan -------------------------------------------
  // Returns the current paid/free tier for the signed-in user. The
  // frontend uses this to render the "Upgrade" CTA + handle 402s.
  // Never leaks the Stripe subscription id or price id — coarse only.
  // Phase 2e.A: surfaces the tier slug + rank + display name so the
  // plan-pill renders the friendly name (Pro / Premium / Free).
  router.get('/plan', requireUser(), async (req, res, next) => {
    try {
      const plan = await getPlanForUser(req.user.id);
      res.json({
        kind: 'payments.plan',
        plan: plan.plan,                                  // 'paid' | 'free' (back-compat)
        planSlug: plan.planSlug || 'free',                // 'free' | 'pro' | 'premium' | 'paid'
        planRank: plan.planRank ?? 0,
        planDisplayName: plan.planDisplayName || 'Free',
        stripeStatus: plan.stripeStatus || 'free',
        currentPeriodEnd: plan.currentPeriodEnd || null,
        cancelAtPeriodEnd: plan.cancelAtPeriodEnd || false,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- GET /api/payments/tiers ------------------------------------------
  // Public list of pricing tiers — slug, display name, monthly amount,
  // bullet-feature list, whether purchasable. Used by the frontend
  // Upgrade card and by the admin pricing-wiring widget. Does NOT
  // require auth: showing the public pricing ladder before the user
  // signs in is the whole point of marketing pages.
  router.get('/tiers', async (_req, res, next) => {
    try {
      const tiers = await getTiers();
      res.json({ kind: 'payments.tiers', tiers });
    } catch (err) {
      next(err);
    }
  });

  // --- POST /api/payments/checkout --------------------------------------
  // Creates a Stripe Checkout Session for the signed-in user and returns
  // the hosted URL the frontend should redirect to. Body shape (all
  // optional):
  //   { tier?, priceId?, successUrl?, cancelUrl? }
  //
  // Phase 2e.A: prefer { tier: 'pro' | 'premium' } — we resolve it via
  // pricing_tiers.stripe_price_id. The legacy { priceId } shape still
  // works for back-compat (frontend doesn't have to look up the tier
  // itself). Falls back to config.stripe.priceId only when neither is
  // provided. 400 'bad_request' when the tier isn't seeded.
  //
  // 503 when Stripe isn't configured — same posture as the webhook.
  router.post('/checkout', requireUser(), express.json({ limit: '4kb' }), async (req, res, next) => {
    try {
      if (!config.stripe.enabled) {
        return res.status(503).json({
          kind: 'payments.disabled',
          message: 'Stripe not configured (set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET)',
        });
      }

      const body = req.body || {};
      let priceId = body.priceId || null;
      let tier = body.tier || null;

      // Resolve tier → price id. If tier is set but unmapped, fail
      // loudly: 400 with a kind the frontend can map to "this plan
      // isn't purchasable yet". We do NOT silently fall through to
      // STRIPE_PRICE_ID — that masks misconfiguration.
      if (!priceId && tier) {
        const resolved = await priceIdForTier(tier);
        if (!resolved) {
          throw new HttpError(
            400,
            'tier_not_purchasable',
            `tier '${tier}' has no Stripe price id seeded — run scripts/seed-pricing-tiers.js`
          );
        }
        priceId = resolved;
      }

      if (!priceId) priceId = config.stripe.priceId;
      if (!priceId) {
        throw new HttpError(
          400,
          'bad_request',
          "no priceId — pass {tier:'pro'} or set STRIPE_PRICE_ID"
        );
      }
      const base = config.appBaseUrl || `http://localhost:${config.port}`;
      const successUrl = body.successUrl || `${base}/?checkout=success`;
      const cancelUrl  = body.cancelUrl  || `${base}/?checkout=cancel`;

      const out = await createCheckoutSession({
        userId: req.user.id,
        email: req.user.email,
        priceId,
        successUrl,
        cancelUrl,
      });
      logger.info(
        { userId: req.user.id, tier, priceId, sessionId: out.sessionId },
        'stripe checkout session created'
      );
      res.json({
        kind: 'payments.checkout',
        url: out.url,
        sessionId: out.sessionId,
        tier: tier || null,
        priceId,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- POST /api/payments/portal ----------------------------------------
  // Returns the Customer Portal URL for the signed-in user. The portal
  // is where Stripe lets users update payment methods, view invoices,
  // and cancel — we don't reimplement any of that.
  router.post('/portal', requireUser(), express.json({ limit: '2kb' }), async (req, res, next) => {
    try {
      if (!config.stripe.enabled) {
        return res.status(503).json({
          kind: 'payments.disabled',
          message: 'Stripe not configured (set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET)',
        });
      }
      const base = config.appBaseUrl || `http://localhost:${config.port}`;
      const returnUrl = (req.body && req.body.returnUrl) || `${base}/?portal=closed`;
      const out = await createCustomerPortalSession({
        userId: req.user.id,
        email: req.user.email,
        returnUrl,
      });
      res.json({ kind: 'payments.portal', url: out.url });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function handleWebhook(req, res) {
  // Refuse early if the env isn't configured. 503 is the right
  // status — the route is intentional but disabled. Stripe's retry
  // logic will keep delivering, which is what we want during a
  // misconfigured deploy: noisy, not silent.
  if (!config.stripe.enabled) {
    return res.status(503).json({
      kind: 'payments.disabled',
      message: 'Stripe not configured (set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET)',
    });
  }

  const sig = req.get('stripe-signature') || '';
  if (!sig) {
    return res.status(400).json({ error: 'bad_request', message: 'missing Stripe-Signature header' });
  }

  // Verify the signature against the raw body. constructEvent throws
  // on tampered / mis-signed payloads; treat that as a 400.
  let event;
  try {
    const stripe = await getStripe();
    event = stripe.webhooks.constructEvent(
      req.body,                  // Buffer (raw)
      sig,
      config.stripe.webhookSecret
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'stripe webhook signature failed');
    return res.status(400).json({ error: 'invalid_signature' });
  }

  // Idempotency: dedupe by event.id. ON CONFLICT in recordEventStart
  // means a re-delivered event hits this branch and we ack 200
  // without doing anything else.
  const isNew = await recordEventStart(event.id, event.type, event);
  if (!isNew) {
    logger.info({ eventId: event.id, type: event.type }, 'stripe webhook already processed');
    return res.json({ kind: 'webhook.duplicate', eventId: event.id });
  }

  // Dispatch by event type. We're scaffolding — only the subscription
  // lifecycle events are wired today. Anything else gets recorded as
  // "ok, no-op" so we have an audit trail without code branches we
  // haven't tested yet.
  let okFlag = true;
  let errMessage = null;
  try {
    await dispatchEvent(event);
  } catch (err) {
    okFlag = false;
    errMessage = err && err.message ? err.message : String(err);
    logger.error({ err: errMessage, eventId: event.id, type: event.type },
      'stripe webhook handler failed');
    // Fall through and ack 200 anyway IF the failure was already
    // recorded — Stripe re-delivering won't help. (This is a Phase 2d
    // judgment call we'll revisit.)
  } finally {
    await recordEventFinish(event.id, okFlag, errMessage).catch((e) =>
      logger.error({ err: e.message }, 'stripe: failed to record event finish')
    );
  }

  // 200 even on handler errors so Stripe doesn't retry our buggy code
  // forever. The error is logged + persisted in stripe_webhook_events.
  res.json({ kind: 'webhook.received', eventId: event.id, ok: okFlag });
}

// Pull the relevant object out of the event and route it to the right
// updater. Anything not in the switch is a deliberate no-op (recorded
// as ok=true via stripe_webhook_events).
async function dispatchEvent(event) {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data && event.data.object;
      if (!sub || !sub.id) {
        throw new Error('subscription event missing data.object.id');
      }
      const shaped = shapeSubscription(sub);
      const userId = await userForCustomer(shaped.stripeCustomerId);
      if (!userId) {
        // We received an event for a customer we don't know about.
        // This is a real misconfiguration in dev (someone created a
        // sub through the dashboard without our checkout flow). Log
        // and move on — we'll learn about the user when they next
        // sign in and we link them.
        logger.warn(
          { customerId: shaped.stripeCustomerId, type: event.type },
          'stripe: subscription event for unknown customer'
        );
        return;
      }
      await upsertSubscription(userId, shaped, sub);
      return;
    }

    case 'checkout.session.completed': {
      // Phase 2d. The user finished checkout. Two pieces of work:
      //   1. Mark our stripe_checkout_sessions row complete (audit).
      //   2. Make sure stripe_customers links the user → customer id.
      //      Normally createCheckoutSession already wrote this, but
      //      defense-in-depth handles dashboard-created sessions and
      //      the (rare) race where the webhook lands before our
      //      INSERT committed.
      // We do NOT upsert the subscription here — the
      // customer.subscription.created event arrives separately and is
      // the canonical place for that. Doing it twice risks ordering
      // bugs.
      const sess = event.data && event.data.object;
      if (!sess || !sess.id) {
        throw new Error('checkout.session.completed missing data.object.id');
      }
      const shaped = shapeCheckoutSession(sess);
      await recordCheckoutSessionComplete(shaped.stripeSessionId, sess);

      // Best-effort customer-link: client_reference_id is our user id
      // (we set it in createCheckoutSession). If both are present and
      // we don't have a stripe_customers row yet, write one.
      const userId = sess.client_reference_id || null;
      if (userId && shaped.stripeCustomerId) {
        await linkCustomer(userId, {
          stripeCustomerId: shaped.stripeCustomerId,
          email: shaped.customerEmail,
        }).catch((err) =>
          logger.warn(
            { err: err.message, userId, customerId: shaped.stripeCustomerId },
            'stripe: linkCustomer at checkout.completed failed (non-fatal)'
          )
        );
      }
      logger.info(
        { sessionId: shaped.stripeSessionId, userId, status: shaped.paymentStatus },
        'stripe: checkout session completed'
      );

      // Phase 3d.3 — referral coupon hook. If this user signed up via
      // a referral link AND the session paid_status is paid (= they
      // actually converted, not just abandoned cart), issue a coupon
      // to the referrer. Best-effort: a failure here logs + returns
      // without re-throwing so the rest of the webhook flow stays
      // happy. Idempotency lives in the service layer's INSERT ... ON
      // CONFLICT (referred_user_id) DO NOTHING so Stripe re-deliveries
      // are no-ops.
      const isPaid =
        shaped.paymentStatus === 'paid' || shaped.paymentStatus === 'no_payment_required';
      if (userId && isPaid) {
        try {
          const ref = await query(
            `SELECT u.referrer_token AS token, r.user_id AS referrer_user_id
               FROM users u
               LEFT JOIN referrals r ON r.token = u.referrer_token
              WHERE u.id = $1`,
            [userId]
          );
          const row = ref.rows[0];
          if (row && row.referrer_user_id) {
            // Self-referral guard happens inside createReferralCoupon
            // (isDifferentUser); already-issued short-circuit also
            // there. Anti-fraud IP guard is in the route layer; the
            // webhook context doesn't have a useful client IP
            // (Stripe's IP, not the user's), so we trust the
            // signup-time check that lives in routes/auth.js (TODO:
            // wire ipIsSignupAbusing into signup as a follow-up).
            const result = await createReferralCoupon({
              referrerUserId: row.referrer_user_id,
              referredUserId: userId,
            });
            logger.info(
              {
                userId,
                referrerUserId: row.referrer_user_id,
                couponIssued: result.issued,
                reason: result.reason || null,
              },
              'referrals: checkout-completed coupon path'
            );
          }
        } catch (err) {
          logger.warn(
            { err: err.message, userId },
            'referrals: coupon-issue failed at checkout.completed (non-fatal)'
          );
        }
      }

      return;
    }

    case 'invoice.payment_failed': {
      // We don't gate or downgrade here — Stripe will follow up with
      // customer.subscription.updated when status flips to past_due or
      // unpaid, and that's where state actually changes. Record + log
      // so the audit trail in stripe_webhook_events tells the full
      // story.
      const inv = event.data && event.data.object;
      logger.warn(
        {
          invoiceId: inv?.id,
          customerId: inv?.customer,
          amountDue: inv?.amount_due,
          attemptCount: inv?.attempt_count,
        },
        'stripe: invoice payment failed'
      );
      return;
    }

    case 'invoice.payment_succeeded': {
      // Same posture — customer.subscription.updated follows. Log only.
      const inv = event.data && event.data.object;
      logger.debug(
        { invoiceId: inv?.id, customerId: inv?.customer },
        'stripe: invoice payment succeeded'
      );
      return;
    }

    default:
      // Recorded but not acted on.
      logger.debug({ type: event.type }, 'stripe webhook: unhandled type, recording only');
      return;
  }
}

// Default export for ergonomic imports — but the *recommended* import
// is `import { buildRouter } from './routes/payments.js'` because
// callers must mount express.raw() at the route, not globally.
export default buildRouter();
