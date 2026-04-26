// src/middleware/requirePaid.js
// Phase 2d. Gate routes behind an active subscription.
//
// Flow:
//   1. requireUser must run before this — we don't 401 here, we defer
//      to the upstream gate. (Mounting requirePaid on a route that
//      isn't already requireUser'd is a wiring bug.)
//   2. Read active_user_plan via getPlanForUser. If plan === 'paid'
//      (active | trialing | past_due), pass through.
//   3. Otherwise return 402 Payment Required with a payload the
//      frontend can swap into an inline "Upgrade" card.
//
// Why 402 specifically? It's the HTTP status that exists for "this
// resource costs money and you haven't paid". Rare in the wild but
// semantically perfect — a 403 would imply the user can never have
// access; 401 would imply auth (and would be a lie since they ARE
// signed in); 404 would hide that the resource exists. 402 says
// "this exists, you're authenticated, you just need to upgrade",
// which is exactly what the UI wants to communicate.
//
// Soft-fail policy:
//   * If Stripe is disabled in dev (config.stripe.enabled === false)
//     we DO NOT auto-grant paid-tier — that would be a footgun in
//     prod if STRIPE_SECRET_KEY ever gets unset by accident. The
//     middleware always reads the DB.
//   * If the DB lookup throws (Postgres flake), we 500 via next(err).
//     A flake is loud, not silent. Better than serving paid content
//     to a free user.

import { getPlanForUser } from '../services/stripe.js';
import { HttpError } from './errorHandler.js';

export function requirePaid(opts = {}) {
  // Optional override for the link the 402 payload points to.
  const upgradePath = opts.upgradePath || '/api/payments/checkout';

  return async function requirePaidMiddleware(req, res, next) {
    try {
      if (!req.user) {
        // Defensive — should be unreachable if the route stack is
        // correct. Coerce to 401 so the response is predictable.
        return next(new HttpError(401, 'unauthenticated', 'sign in required'));
      }
      const plan = await getPlanForUser(req.user.id);
      if (plan && plan.plan === 'paid') {
        return next();
      }
      // 402 with a kind the frontend dispatches on.
      res.status(402).json({
        kind: 'payments.required',
        plan: plan?.plan || 'free',
        stripeStatus: plan?.stripeStatus || 'free',
        // The frontend doesn't navigate here directly — it POSTs to
        // /checkout to get the Stripe-hosted URL. Surfacing the path
        // anyway so a curl response is self-documenting.
        upgrade: { method: 'POST', path: upgradePath },
        message: 'this endpoint requires a paid subscription',
      });
    } catch (err) {
      next(err);
    }
  };
}

export default requirePaid;
