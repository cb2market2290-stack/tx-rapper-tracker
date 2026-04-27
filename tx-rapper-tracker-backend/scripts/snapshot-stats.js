#!/usr/bin/env node
// scripts/snapshot-stats.js
// Daily snapshot of YouTube channel stats for the seed-list artists.
//
// For each artist:
//   1. Resolve channel ID via search (1 quota unit pseudo-cost: 100)
//   2. Fetch channel stats (1 quota unit)
//   3. UPSERT into artist_stats_daily for today's date.
//
// Idempotent: re-running the same day refreshes the values without
// inserting a new row. Designed to be wired into the Cowork `schedule`
// skill at ~04:00 daily.
//
// Run manually:
//   node scripts/snapshot-stats.js
//
// The script reuses the in-process YouTube service so it gets the same
// caching benefit as the live API path.

import { search, channels } from '../src/services/youtube.js';
import { query, closePool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { mailer } from '../src/lib/mailer.js';
import { config } from '../src/config.js';
import { refreshBreakoutSignals } from '../src/services/breakout.js';
import { evaluateAllSavedSearches } from '../src/services/savedsearch-evaluator.js';

// Roster lives in the `artists` table (migration 006) so admins can edit
// without a deploy. We load the active rows at the start of each run and
// follow whatever the admin panel has set.
async function loadRoster() {
  const { rows } = await query(
    `SELECT name
       FROM artists
      WHERE NOT is_archived
      ORDER BY sort_order ASC, name ASC`
  );
  return rows.map((r) => r.name);
}

async function snapshotArtist(name) {
  const sr = await search({ q: `${name} rapper`, maxResults: 1, type: 'channel' });
  const chanId = sr?.items?.[0]?.id?.channelId;
  if (!chanId) {
    return { name, ok: false, reason: 'no_channel_found' };
  }

  const cr = await channels({ id: chanId });
  const stats = cr?.items?.[0]?.statistics || {};
  const subs = parseInt(stats.subscriberCount || '0', 10);
  const lifetimeViews = parseInt(stats.viewCount || '0', 10);

  await query(
    `INSERT INTO artist_stats_daily (artist_name, captured_on, channel_id, subs, lifetime_views)
     VALUES ($1, current_date, $2, $3, $4)
     ON CONFLICT (artist_name, captured_on) DO UPDATE
       SET channel_id     = EXCLUDED.channel_id,
           subs           = EXCLUDED.subs,
           lifetime_views = EXCLUDED.lifetime_views,
           captured_at    = now()`,
    [name, chanId, subs, lifetimeViews]
  );
  return { name, ok: true, channelId: chanId, subs, lifetimeViews };
}

// Scrub upstream error text before persisting. YouTube API error payloads
// sometimes echo the request URL (including a `key=AIza…` query param).
// Strip anything that looks like an API key and truncate to keep the row
// bounded — the admin snapshot-status panel surfaces this text.
function safeErrorMsg(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/key=AIza[0-9A-Za-z_-]+/g, 'key=…redacted')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '…redacted')
    .slice(0, 500);
}

// Email admins when a run finishes in anything other than 'ok'. No-op when
// there are no configured admins or the mailer is the console logger and
// we're just re-verifying locally. Best-effort — failures here are logged
// but don't fail the script (the DB breadcrumb is already the source of
// truth for the admin panel).
async function alertOnFailure({ status, results, errorMsg, startedAt }) {
  if (status === 'ok') return;
  const recipients = config.adminEmails || [];
  if (recipients.length === 0) {
    logger.warn({ status }, 'snapshot non-ok but no adminEmails configured');
    return;
  }
  const failed = results.filter((r) => !r.ok);
  const lines = [
    `The daily snapshot job finished with status: ${status}.`,
    '',
    `Started:  ${startedAt}`,
    `Artists:  ${results.length} total, ${results.length - failed.length} ok, ${failed.length} failed`,
    '',
    failed.length ? 'Per-artist failures:' : '',
    ...failed.map((r) => `  - ${r.name}: ${r.reason}`),
    '',
    errorMsg ? `Error: ${errorMsg}` : '',
    '',
    'Check /admin for the snapshot_runs history.',
  ].filter(Boolean);
  const text = lines.join('\n');
  const subject = `[snapshot] ${status} — ${failed.length}/${results.length} failed`;
  for (const to of recipients) {
    try {
      await mailer.send({ to, subject, text });
    } catch (err) {
      logger.warn({ err: err.message, to }, 'alert email failed');
    }
  }
}

// Records the run in snapshot_runs so the admin panel can show "last
// snapshot: 04:05 OK / 6 artists". Swallows its own errors — if we can't
// write the breadcrumb we still want the primary script to exit with the
// status of the actual snapshot work.
async function recordRun(startedAt, row) {
  try {
    const duration = Date.now() - new Date(startedAt).getTime();
    await query(
      `INSERT INTO snapshot_runs
         (started_at, finished_at, status, artists_total, rows_upserted, error_msg, duration_ms)
       VALUES ($1, now(), $2, $3, $4, $5, $6)`,
      [startedAt, row.status, row.artistsTotal, row.rowsUpserted, safeErrorMsg(row.errorMsg), duration]
    );
  } catch (err) {
    logger.error({ err: err.message }, 'snapshot_runs write failed');
  }
}

// Keep artist_stats_daily bounded to the longest chart we allow
// (HistoryQuery.days.max = 730) plus a week of slack for DST/timezone fuzz.
// snapshot_runs is tiny per-row but also gets pruned so the admin panel
// doesn't have to scroll past a year of green rows.
async function pruneOld() {
  try {
    const stats = await query(
      `DELETE FROM artist_stats_daily
        WHERE captured_on < current_date - interval '737 days'`
    );
    const runs = await query(
      `DELETE FROM snapshot_runs
        WHERE started_at < now() - interval '90 days'`
    );
    if (stats.rowCount || runs.rowCount) {
      logger.info({ stats: stats.rowCount, runs: runs.rowCount }, 'retention prune');
    }
  } catch (err) {
    // Non-fatal — if prune fails the snapshot itself still succeeded,
    // and the next run will try again.
    logger.warn({ err: err.message }, 'retention prune failed');
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const artists = await loadRoster();
  if (artists.length === 0) {
    // No roster = nothing to do. Record a breadcrumb so the admin panel
    // shows this wasn't a silent failure, then exit clean.
    logger.warn('snapshot: no active artists in roster, nothing to do');
    await recordRun(startedAt, {
      status: 'ok',
      artistsTotal: 0,
      rowsUpserted: 0,
      errorMsg: null,
    });
    return { results: [], status: 'ok' };
  }
  const results = [];
  for (const name of artists) {
    try {
      const r = await snapshotArtist(name);
      results.push(r);
      logger.info(r, 'snapshot artist');
    } catch (err) {
      logger.error({ err: err.message, name }, 'snapshot artist failed');
      results.push({ name, ok: false, reason: err.message });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  logger.info({ total: results.length, ok, failed }, 'snapshot complete');

  // All-ok → 'ok'; some-failed → 'partial'; zero-ok → 'error'.
  const status = ok === 0 ? 'error' : failed === 0 ? 'ok' : 'partial';
  const errorMsg = failed
    ? results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.reason}`).join('; ')
    : null;
  await recordRun(startedAt, {
    status,
    artistsTotal: results.length,
    rowsUpserted: ok,
    errorMsg,
  });

  // Refresh the breakout_signals matview AFTER the upserts have landed —
  // otherwise the dashboard "movers" strip still serves yesterday's deltas
  // for the rest of the day. CONCURRENTLY (via the unique index from
  // migration 013) keeps the API path serving stale-but-consistent data
  // during the rebuild instead of blanking out. Wrapped in try/catch
  // because a refresh failure shouldn't tank the snapshot run — the
  // breadcrumb above is already written.
  try {
    await refreshBreakoutSignals();
    logger.info('breakout_signals refreshed');
  } catch (err) {
    logger.warn({ err: err.message }, 'breakout_signals refresh failed');
  }

  // Walk every enabled saved_search after the matview is fresh — this
  // is what powers the per-user email alerts (Phase 3a.3). Wrapped in
  // try/catch so an evaluator blowup doesn't tank the snapshot run; the
  // breadcrumb above is already written. The 24h cooling-off cap inside
  // the evaluator is what prevents alert spam if the cron fires twice
  // in the same day.
  try {
    const baseUrl = config.appBaseUrl || '';
    const result = await evaluateAllSavedSearches({ baseUrl });
    logger.info(result, 'saved-search evaluator complete');
  } catch (err) {
    logger.warn({ err: err.message }, 'saved-search evaluator failed');
  }

  // Fire off alerts before pruning — we care more about getting the signal
  // out than about keeping the table tidy if the process were to crash.
  await alertOnFailure({ status, results, errorMsg, startedAt });

  // Retention after the snapshot, not before — if the INSERT fails we
  // don't want to have already deleted yesterday's row.
  await pruneOld();

  return { results, status };
}

main()
  .then(async ({ status }) => {
    await closePool();
    // Non-zero exit for a total failure so the scheduler/ops layer can
    // pick it up, but a partial success is still "mostly worked".
    process.exit(status === 'error' ? 1 : 0);
  })
  .catch(async (err) => {
    logger.error({ err: err.message }, 'snapshot fatal');
    // Best-effort: write a failure breadcrumb even when the loop itself
    // crashed before any artists could be processed.
    try {
      await query(
        `INSERT INTO snapshot_runs (started_at, finished_at, status, error_msg)
         VALUES (now(), now(), 'error', $1)`,
        [safeErrorMsg(err.message)]
      );
    } catch (_) { /* ignore */ }
    await closePool().catch(() => {});
    process.exit(1);
  });
