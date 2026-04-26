#!/usr/bin/env node
// scripts/seed-pricing-tiers.js
// Phase 2e.A — populate pricing_tiers.stripe_price_id from env.
//
// What this does:
//   * Reads STRIPE_PRICE_PRO + STRIPE_PRICE_PREMIUM from process env.
//   * UPSERTs the corresponding pricing_tiers rows (already seeded by
//     migration 012) with the price ids. Idempotent — running twice
//     with the same env is a no-op past the first run.
//   * Optionally accepts --pro <price_id> --premium <price_id> flags so
//     ops can run a one-off rotation without exporting env vars.
//   * Prints the resulting table for confirmation.
//
// Why a separate script (not auto-run on boot):
//   * Migrations should be deterministic. Inserting environment-dependent
//     data inside a SQL migration file would mean two operators with
//     different envs end up with different DBs.
//   * Boot-time UPSERT is tempting but couples the prod server to env at
//     server-start, which is a worse failure mode than "operator forgot
//     to run the seeder". A clean, explicit, idempotent CLI is the right
//     ergonomic.
//
// Usage:
//   # Read from env (preferred — same source of truth as the rest of
//   # the app).
//   node scripts/seed-pricing-tiers.js
//
//   # Override on the CLI without touching .env.
//   node scripts/seed-pricing-tiers.js --pro price_… --premium price_…
//
//   # Just dump the current pricing_tiers state.
//   node scripts/seed-pricing-tiers.js --status

import 'dotenv/config';
import { closePool, query } from '../src/db/pool.js';

function parseArgs(argv) {
  const out = { pro: null, premium: null, status: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pro') out.pro = argv[++i] || null;
    else if (a === '--premium') out.premium = argv[++i] || null;
    else if (a === '--status') out.status = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/seed-pricing-tiers.js              # seed from env
  node scripts/seed-pricing-tiers.js --pro price_… --premium price_…
  node scripts/seed-pricing-tiers.js --status     # show table only

Reads STRIPE_PRICE_PRO + STRIPE_PRICE_PREMIUM from env when no flags set.
Idempotent. Safe to run repeatedly.`);
}

async function dumpTiers() {
  const { rows } = await query(
    `SELECT slug, rank, stripe_price_id, display_name, monthly_amount_cents
       FROM pricing_tiers ORDER BY rank ASC`
  );
  console.log('\npricing_tiers:');
  console.log(
    'slug      rank  price_id                       display     monthly_cents'
  );
  for (const r of rows) {
    const slug = r.slug.padEnd(9);
    const rank = String(r.rank).padEnd(5);
    const pid = (r.stripe_price_id || '(unset)').padEnd(30);
    const name = (r.display_name || '').padEnd(11);
    const cents =
      r.monthly_amount_cents == null ? '(unset)' : String(r.monthly_amount_cents);
    console.log(`${slug} ${rank} ${pid} ${name} ${cents}`);
  }
  console.log('');
}

async function upsertTier(slug, priceId) {
  if (!priceId) {
    console.log(`  ${slug}: skipped (no price id provided)`);
    return false;
  }
  // Update the existing row only — migration 012 seeded all three slugs.
  // If the slug is missing, migration didn't run. Bail loudly.
  const { rowCount } = await query(
    `UPDATE pricing_tiers
        SET stripe_price_id = $2,
            updated_at = now()
      WHERE slug = $1
        AND ($2 IS DISTINCT FROM stripe_price_id)`,
    [slug, priceId]
  );
  if (rowCount === 0) {
    // Either slug missing, or already up-to-date.
    const { rows } = await query(
      `SELECT 1 FROM pricing_tiers WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) {
      throw new Error(
        `pricing_tiers row for slug='${slug}' is missing — did migration 012 run?`
      );
    }
    console.log(`  ${slug}: already up to date (${priceId})`);
    return false;
  }
  console.log(`  ${slug}: set price → ${priceId}`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.status) {
    await dumpTiers();
    return;
  }

  const pro = args.pro || process.env.STRIPE_PRICE_PRO || '';
  const premium = args.premium || process.env.STRIPE_PRICE_PREMIUM || '';

  if (!pro && !premium) {
    console.error(
      'error: neither STRIPE_PRICE_PRO nor STRIPE_PRICE_PREMIUM set, and no --pro/--premium flag passed'
    );
    console.error('       (run with --status to see the current table)');
    printHelp();
    process.exit(1);
  }

  console.log('seeding pricing_tiers:');
  await upsertTier('pro', pro);
  await upsertTier('premium', premium);
  await dumpTiers();
}

main()
  .catch((err) => {
    console.error('seed-pricing-tiers failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
