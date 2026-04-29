#!/usr/bin/env node
// scripts/send-weekly-digest.js
// Phase 3d.2 — weekly digest cron. Runs hourly between 06:00 and
// 14:00 UTC; per-user, sends iff:
//   1. opted_in
//   2. local time is 09:00-09:59 in the user's timezone
//   3. last_sent_at > 6 days ago (or never sent)
//
// The breakout_signals matview is the source of truth for top movers
// + emerging-artist detection — we don't recompute anything here.
//
// Wiring (deferred to ops):
//   * Cron entry: 0 6-14 * * 1   (hourly between 06:00 and 14:00 UTC,
//     Mondays only). Mondays-only keeps the cron from running for
//     nothing 6 days a week.
//   * Or via launchd: a separate scripts/install-launchd-digest.sh
//     in a follow-up commit.
//
// CLI flags:
//   --dry-run           List who WOULD be emailed without sending.
//                       Sets DIGEST_DRY_RUN=true so the mailer is
//                       still ConsoleMailer in dev. No DB writes.
//   --force             Skip the 09:00-local-time gate. Useful for
//                       testing against a single test user.
//   --user <email>      Only consider this one user. Other gates
//                       still apply unless --force.

import { closePool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { config } from '../src/config.js';
import {
  getUsersDueForDigest,
  isDigestHourFor,
  isDueForResend,
  sendDigestForUser,
} from '../src/services/digest.js';
import { getAllSignals } from '../src/services/breakout.js';

function parseFlags(argv) {
  const flags = { dryRun: false, force: false, user: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--user') flags.user = argv[++i] || null;
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const now = new Date();
  const appBaseUrl = config.appBaseUrl || 'http://localhost:8787';

  logger.info(
    { dryRun: flags.dryRun, force: flags.force, user: flags.user, appBaseUrl },
    'digest cron start'
  );

  // Pull breakout signals once — same for every user. The signals
  // matview is artist-scoped, not user-scoped; the digest payload
  // shows the same top-5 to every recipient. (User-personalized
  // movers based on saved-search artists is a follow-up.)
  const signals = await getAllSignals();
  if (signals.length === 0) {
    logger.warn('no breakout_signals rows; skipping digest cron');
    return { sent: 0, skipped: 0 };
  }

  const users = await getUsersDueForDigest();
  let sent = 0;
  let skipped = 0;
  const reasons = {};

  for (const user of users) {
    if (flags.user && user.email !== flags.user) {
      skipped++;
      reasons.user_filter = (reasons.user_filter || 0) + 1;
      continue;
    }
    if (!flags.force && !isDigestHourFor(user, now)) {
      skipped++;
      reasons.wrong_hour = (reasons.wrong_hour || 0) + 1;
      continue;
    }
    if (!flags.force && !isDueForResend(user, now)) {
      skipped++;
      reasons.too_recent = (reasons.too_recent || 0) + 1;
      continue;
    }
    if (flags.dryRun) {
      logger.info({ to: user.email }, 'digest dry-run: would send');
      sent++;
      continue;
    }
    const result = await sendDigestForUser({ user, signals, appBaseUrl });
    if (result.sent) {
      sent++;
    } else {
      skipped++;
      reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    }
  }

  logger.info({ sent, skipped, reasons, total: users.length }, 'digest cron complete');
  return { sent, skipped, reasons };
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: err.message }, 'digest cron fatal');
    await closePool();
    process.exit(1);
  });
