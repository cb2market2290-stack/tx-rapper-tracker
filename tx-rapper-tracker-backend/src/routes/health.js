// src/routes/health.js
// Cheap, unauthenticated health/ready endpoints for uptime checks.
//   /health        — process is up (no DB touch).
//   /ready         — app can serve traffic (cache stats).
//   /api/health/deep — Phase 3.5.4 composite freshness check
//                      (DB reachable, last snapshot < 26h, last
//                      audio extract < 7d, briefs configured when
//                      enabled). 200 on green, 503 on any red.

import { Router } from 'express';
import { cacheStats } from '../lib/cache.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';

const router = Router();
const startedAt = Date.now();

router.get('/health', (_req, res) => {
  res.json({ ok: true, uptimeMs: Date.now() - startedAt });
});

router.get('/ready', (_req, res) => {
  res.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    cache: cacheStats(),
  });
});

// ── /api/health/deep (Phase 3.5.4) ──────────────────────────────────────
//
// Composite freshness check. Wires to two consumers:
//   1. External uptime monitor (UptimeRobot, Better Stack, Cloudflare
//      Health Checks) — point at this URL. 200 = healthy, 503 = page.
//   2. launchd-side cron (5-minute LaunchAgent) curls the URL and pipes
//      any non-200 to the Phase 3.5.3 mailer. Cron-of-last-resort that
//      catches anything 3.5.3's own try/catch wrappers miss.
//
// Public + un-authenticated by design — no PII, no resource enumeration.
// Mounted under /api/health/deep so the existing /api/* rate limit
// applies (= bounded against probing).
//
// Thresholds (intentionally generous so a single missed cron doesn't
// page on its own):
//   * DB:               SELECT 1 round-trip succeeds within 1s.
//   * Snapshot fresh:   MAX(captured_on) ≤ 26h ago. Daily cron runs at
//                       04:00; 26h gives one full miss + 2h slack
//                       before paging.
//   * Extract fresh:    MAX(extracted_at) ≤ 7d ago. Audio extraction
//                       is enqueue-driven; 7d covers normal pacing
//                       even if no new tracks landed.
//   * Briefs:           when config.briefs.enabled, ANTHROPIC_API_KEY
//                       must be present. When disabled, this check is
//                       reported as "not_applicable" and never fails.
//
// Empty-state handling (= a fresh box with no data yet):
//   * snapshot_fresh: no rows  → ok=true, lastAt=null. We can't say the
//                                snapshot is stale if it was never run.
//                                The deploy script's check-prod-ready
//                                covers the first-run case separately.
//   * extract_fresh:  no rows  → ok=true, lastAt=null, applicable=false.
//                                Audio extraction is opt-in per artist;
//                                a roster with zero analyzed tracks is
//                                a valid configuration.

const SNAPSHOT_FRESH_HOURS = 26;
const EXTRACT_FRESH_DAYS = 7;
const DB_TIMEOUT_MS = 1000;

async function checkDb() {
  const start = Date.now();
  try {
    // Race the SELECT 1 against a 1s timeout. If the pool is exhausted
    // or the connection is wedged, we fail fast rather than hanging
    // the health check itself.
    await Promise.race([
      query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('db_timeout')), DB_TIMEOUT_MS)
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err.message || String(err),
    };
  }
}

async function checkSnapshotFresh() {
  try {
    const { rows } = await query(
      `SELECT MAX(captured_on)::text AS day,
              EXTRACT(EPOCH FROM (now() - MAX(captured_on))) / 3600 AS age_hours
         FROM artist_stats_daily`
    );
    const day = rows[0]?.day || null;
    const ageHours =
      rows[0]?.age_hours == null ? null : Number(rows[0].age_hours);
    if (day == null) {
      // No snapshots yet — fresh-box state. Don't fail the health
      // check; first-run state is valid.
      return { ok: true, lastAt: null, ageHours: null, applicable: false };
    }
    return {
      ok: ageHours <= SNAPSHOT_FRESH_HOURS,
      lastAt: day,
      ageHours: Math.round(ageHours * 10) / 10,
      applicable: true,
      thresholdHours: SNAPSHOT_FRESH_HOURS,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkExtractFresh() {
  try {
    const { rows } = await query(
      `SELECT MAX(extracted_at)::text AS at,
              EXTRACT(EPOCH FROM (now() - MAX(extracted_at))) / 86400 AS age_days
         FROM track_features`
    );
    const at = rows[0]?.at || null;
    const ageDays =
      rows[0]?.age_days == null ? null : Number(rows[0].age_days);
    if (at == null) {
      // Zero analyzed tracks — opt-in per artist. Valid configuration;
      // mark not-applicable so it doesn't 503 a healthy box.
      return { ok: true, lastAt: null, ageDays: null, applicable: false };
    }
    return {
      ok: ageDays <= EXTRACT_FRESH_DAYS,
      lastAt: at,
      ageDays: Math.round(ageDays * 10) / 10,
      applicable: true,
      thresholdDays: EXTRACT_FRESH_DAYS,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkBriefsConfigured() {
  // When the briefs feature is OFF (config.briefs.enabled = false), we
  // shouldn't fail the deep-health check just because the API key is
  // unset. That's a valid configuration — same posture as Stripe being
  // disabled in dev. Report "applicable: false" and pass.
  if (!config.briefs.enabled) {
    return { ok: true, applicable: false };
  }
  return {
    ok: !!config.briefs.apiKey,
    applicable: true,
    enabled: true,
  };
}

router.get('/api/health/deep', async (_req, res) => {
  // Run the four checks in parallel — each one is independent and the
  // total wall-clock should be max(checks) not sum(checks).
  const [db, snapshot, extract, briefs] = await Promise.all([
    checkDb(),
    checkSnapshotFresh(),
    checkExtractFresh(),
    Promise.resolve(checkBriefsConfigured()),
  ]);

  const checks = {
    db,
    snapshot_fresh: snapshot,
    extract_fresh: extract,
    briefs_configured: briefs,
  };
  const failed = Object.entries(checks)
    .filter(([, v]) => !v.ok)
    .map(([k]) => k);

  const status = failed.length === 0 ? 'ok' : 'degraded';
  const code = status === 'ok' ? 200 : 503;
  res.status(code).json({
    kind: 'health.deep',
    status,
    failed,
    checks,
    uptimeMs: Date.now() - startedAt,
  });
});

export default router;
