// src/middleware/requirePaid.js
// Phase 2d (introduced) + Phase 2e.A (multi-tier).
//
// Gate routes behind an active subscription, optionally at-or-above a
// minimum tier.
//
// Flow:
//   1. requireUser must run before this — we don't 401 here, we defer
//      to the upstream gate. (Mounting requirePaid on a route that
//      isn't already requireUser'd is a wiring bug.)
//   2. Read active_user_plan via getPlanForUser. The view returns
//      plan_rank as an integer (0=free, 1=pro, 2=premium, 99=unmapped
//      paying). When opts.minTier is set we look up the rank for that
//      slug from pricing_tiers and require user.planRank >= minRank.
//      When unset we fall back to the legacy "any paid plan" check
//      (plan === 'paid' from the back-compat alias).
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

import { getPlanForUser, rankAtLeast } from '../services/stripe.js';
import { query } from '../db/pool.js';
import { HttpError } from './errorHandler.js';

// Cache rank lookups for the lifetime of the process. Tier ranks change
// only via SQL or the seeder script, both of which require a server
// restart in our deploy posture; caching is safe and saves a DB hit on
// every gated request.
const _rankCache = new Map(); // slug → rank

async function rankForSlug(slug) {
  if (_rankCache.has(slug)) return _rankCache.get(slug);
  const { rows } = await query(
    `SELECT rank FROM pricing_tiers WHERE slug = $1`,
    [slug]
  );
  const rank = rows[0]?.rank;
  if (Number.isFinite(rank)) _rankCache.set(slug, rank);
  return rank;
}

// Test seam — flush the cache so a unit test that swaps pricing_tiers
// rows doesn't get a stale rank.
export function _resetRequirePaidCacheForTests() {
  _rankCache.clear();
}

export function requirePaid(opts = {}) {
  // Optional override for the link the 402 payload points to.
  const upgradePath = opts.upgradePath || '/api/payments/checkout';
  // Optional minimum tier slug ('pro' | 'premium' | …). When unset, any
  // paid plan unlocks the route.
  const minTier = opts.minTier || null;

  return async function requirePaidMiddleware(req, res, next) {
    try {
      if (!req.user) {
        // Defensive — should be unreachable if the route stack is
        // correct. Coerce to 401 so the response is predictable.
        return next(new HttpError(401, 'unauthenticated', 'sign in required'));
      }
      const plan = await getPlanForUser(req.user.id);

      let allowed;
      if (minTier) {
        const minRank = await rankForSlug(minTier);
        if (!Number.isFinite(minRank)) {
          // Misconfigured route — minTier slug doesn't exist in
          // pricing_tiers. Loudly fail closed.
          return next(
            new HttpError(
              500,
              'pricing_misconfigured',
              `requirePaid: minTier='${minTier}' is not in pricing_tiers`
            )
          );
        }
        allowed = rankAtLeast(plan?.planRank, minRank);
      } else {
        allowed = plan && plan.plan === 'paid';
      }

      if (allowed) return next();

      // 402 with a kind the frontend dispatches on. Includes minTier
      // when set so the Upgrade card can preselect the right plan.
      res.status(402).json({
        kind: 'payments.required',
        plan: plan?.plan || 'free',
        planSlug: plan?.planSlug || 'free',
        planRank: plan?.planRank ?? 0,
        planDisplayName: plan?.planDisplayName || 'Free',
        stripeStatus: plan?.stripeStatus || 'free',
        minTier: minTier || null,
        // The frontend doesn't navigate here directly — it POSTs to
        // /checkout to get the Stripe-hosted URL. Surfacing the path
        // anyway so a curl response is self-documenting.
        upgrade: { method: 'POST', path: upgradePath },
        message: minTier
          ? `this endpoint requires the ${minTier} tier or higher`
          : 'this endpoint requires a paid subscription',
      });
    } catch (err) {
      next(err);
    }
  };
}

export default requirePaid;
