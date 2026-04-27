// src/services/savedsearch-evaluator.js
// Phase 3a.3 — saved-search evaluator + mailer.
//
// Each snapshot cycle (after the matview refresh in snapshot-stats.js)
// we walk every enabled saved_search, check its predicate against
// breakout_signals, and email the owner when it trips. One email per
// saved search per 24h regardless of tier — the cap protects users
// (and us) from runaway alert churn.
//
// Design choices:
//
//   * SQL does the matching, not JS. Each metric maps to a column in
//     breakout_signals (lifetime_views = views_now), so "find matching
//     artists" is a single parameterized query per saved search. Two
//     predicate sources (matview + raw stats) would mean two query
//     paths and two bug surfaces.
//
//   * The 24h cap is enforced by `last_alerted_at < now() - 24h` in the
//     loader's WHERE clause. Filtering at load time means a saved
//     search inside the cooling-off window is never even a candidate
//     for matching — a tiny bit of CPU saved per cycle, and it makes
//     the mental model "this query returns the searches that COULD
//     fire right now".
//
//   * Per-search artist matching: scope=null means "any artist",
//     scope=uuid means "this artist only". For "any artist" we limit
//     to the top-5 hottest matches by metric value, so a poorly-set
//     threshold (alert when growth > 0) doesn't blast the user with
//     50 emails on day one.
//
//   * Mailer failures are LOGGED, not raised. One bad recipient
//     shouldn't tank the whole cycle. We DON'T update last_alerted_at
//     when send fails — so the next cycle will retry for that user.
//
// Public surface:
//   evaluateAllSavedSearches({ now, baseUrl, mailer })
//                                      — orchestrator. Returns
//                                        { evaluated, fired, errors }.
//
// Pure helpers (exported for tests):
//   applyComparator(value, op, threshold)
//   metricColumn(metric)
//   formatValueForMetric(metric, value)
//   humanizeMetric(metric)
//   humanizeComparator(op)
//   buildEmailPayload({ savedSearch, matches, recipient, baseUrl })
//   shouldAlert(savedSearch, now)

import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { mailer as defaultMailer } from '../lib/mailer.js';

// ---------------------------------------------------------------------------
// Pure helpers — no DB, no I/O, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Map a saved-search metric to the underlying breakout_signals column.
 * lifetime_views aliases to views_now (the matview's lifetime-views
 * passthrough column). Keep this in lock-step with VALID_METRICS in
 * services/savedsearches.js.
 */
export function metricColumn(metric) {
  switch (metric) {
    case 'view_growth_7d':   return 'view_growth_7d';
    case 'pct_growth_7d':    return 'pct_growth_7d';
    case 'acceleration_7d':  return 'acceleration_7d';
    case 'lifetime_views':   return 'views_now';
    default:
      throw new Error(`unknown metric: ${metric}`);
  }
}

/**
 * Pure comparator. Operates on already-coerced numbers — the loader
 * normalizes BIGINT-as-string before this is called.
 */
export function applyComparator(value, op, threshold) {
  if (value == null || !Number.isFinite(Number(value))) return false;
  const v = Number(value);
  switch (op) {
    case '>':  return v >  threshold;
    case '>=': return v >= threshold;
    case '<':  return v <  threshold;
    case '<=': return v <= threshold;
    default:   throw new Error(`unknown comparator: ${op}`);
  }
}

/**
 * Has the cooling-off window elapsed for this saved search? Searches
 * never alerted (last_alerted_at IS NULL) are always due.
 */
export function shouldAlert(savedSearch, now = new Date()) {
  if (!savedSearch?.last_alerted_at) return true;
  const last = new Date(savedSearch.last_alerted_at).getTime();
  return now.getTime() - last >= 24 * 60 * 60 * 1000;
}

/**
 * Pretty-print a metric for email subjects. Kept compact ("7-day growth"
 * not "view growth over the last 7 days") because users will scan these.
 */
export function humanizeMetric(metric) {
  switch (metric) {
    case 'view_growth_7d':   return '7-day view growth';
    case 'pct_growth_7d':    return '7-day percentage growth';
    case 'acceleration_7d':  return '7-day acceleration';
    case 'lifetime_views':   return 'lifetime views';
    default:                 return metric;
  }
}

export function humanizeComparator(op) {
  switch (op) {
    case '>':  return 'above';
    case '>=': return 'at or above';
    case '<':  return 'below';
    case '<=': return 'at or below';
    default:   return op;
  }
}

/**
 * Format a value for human display. Compact-int for view counts,
 * percentage with sign for ratios. NULL → 'n/a' so emails never
 * say "matched at undefined".
 */
export function formatValueForMetric(metric, value) {
  if (value == null) return 'n/a';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  if (metric === 'pct_growth_7d') {
    const pct = n * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }
  // Compact-int for raw counts and deltas (1.2M, -350K, 12.5B).
  return formatCompactInt(n);
}

function formatCompactInt(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * Build the email payload from a saved search + its matches.
 * Pure: same inputs always produce the same {subject, text, html}.
 *
 * Subjects:
 *   single artist scope:   "[TX] GloRilla matched 'Megan over 1M' (above 1M views)"
 *   any-artist scope:      "[TX] 3 artists matched 'Anyone accelerating' (acceleration above 0)"
 *
 * The body has a header line, a list of matches with values, and a
 * link to the dashboard for each match. Both text/plain and a small
 * inline-styled HTML version are produced — the HTML one is what most
 * mail clients show; the text one is the fallback.
 */
export function buildEmailPayload({ savedSearch, matches, recipient, baseUrl }) {
  const metricLabel = humanizeMetric(savedSearch.metric);
  const opLabel = humanizeComparator(savedSearch.comparator);
  const thresholdLabel = formatValueForMetric(savedSearch.metric, savedSearch.threshold);
  const isScoped = !!savedSearch.artist_id;

  const subject = isScoped
    ? `[TX] ${matches[0]?.artist_name || 'an artist'} matched "${savedSearch.name}"`
    : `[TX] ${matches.length} artist${matches.length === 1 ? '' : 's'} matched "${savedSearch.name}"`;

  const ruleLine = `Rule: ${metricLabel} ${opLabel} ${thresholdLabel}`;

  const matchLines = matches.map((m) => {
    const valueLabel = formatValueForMetric(savedSearch.metric, m.value);
    return `  • ${m.artist_name} — ${valueLabel}`;
  });

  const linkBase = (baseUrl || '').replace(/\/$/, '');
  const dashLink = linkBase ? `${linkBase}/app` : '/app';
  const text = [
    `Hi,`,
    ``,
    `Your saved search "${savedSearch.name}" just fired.`,
    ruleLine,
    ``,
    `Matches (${matches.length}):`,
    ...matchLines,
    ``,
    `View on the dashboard: ${dashLink}`,
    ``,
    `— TX Rapper Tracker`,
    `(You're getting this because you set up a saved search alert. To stop, sign in and disable or delete the search.)`,
  ].join('\n');

  // Minimal inline-styled HTML. No external CSS — most clients strip
  // <style> blocks anyway.
  const matchListHtml = matches
    .map(
      (m) =>
        `<li><strong>${escapeHtml(m.artist_name)}</strong> — ${escapeHtml(
          formatValueForMetric(savedSearch.metric, m.value)
        )}</li>`
    )
    .join('');
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#222;max-width:560px">
      <p>Your saved search <strong>${escapeHtml(savedSearch.name)}</strong> just fired.</p>
      <p style="background:#f4f4f4;padding:8px 12px;border-radius:4px"><code>${escapeHtml(ruleLine)}</code></p>
      <p><strong>Matches (${matches.length}):</strong></p>
      <ul>${matchListHtml}</ul>
      <p><a href="${escapeHtml(dashLink)}">View on the dashboard</a></p>
      <hr style="border:none;border-top:1px solid #ddd"/>
      <p style="color:#777;font-size:12px">
        You're getting this because you set up a saved search alert.
        To stop, sign in and disable or delete the search.
      </p>
    </div>
  `.trim();

  return { to: recipient, subject, text, html };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// DB paths
// ---------------------------------------------------------------------------

/**
 * Load every enabled saved_search whose 24-hour cooling-off window has
 * elapsed (or that has never alerted). Joins users to get the recipient
 * email; we send to whatever's on file for the owning user.
 */
async function loadDueSavedSearches({ now }) {
  const { rows } = await query(
    `SELECT s.id, s.user_id, s.name, s.metric, s.threshold, s.comparator,
            s.artist_id, s.enabled,
            s.last_alerted_at, s.last_match_artist_id, s.last_match_value,
            u.email AS user_email
       FROM saved_searches s
       JOIN users u ON u.id = s.user_id
      WHERE s.enabled
        AND (s.last_alerted_at IS NULL
             OR s.last_alerted_at < $1::timestamptz - INTERVAL '24 hours')
      ORDER BY s.last_alerted_at NULLS FIRST, s.created_at ASC`,
    [now.toISOString()]
  );
  return rows;
}

/**
 * Find rows in breakout_signals that match this saved search's predicate.
 * Returns up to MAX_MATCHES entries sorted by metric value descending
 * (so we surface the strongest candidates when a search is broad).
 *
 * For artist-scoped searches we still filter by the metric — a user
 * setting "GloRilla growth > 1M" doesn't want an email when GloRilla's
 * growth is only 500K.
 */
async function findMatches(savedSearch) {
  const col = metricColumn(savedSearch.metric);
  const op = savedSearch.comparator;
  // Allowlist comparator before interpolating — it was already CHECK'd
  // at insert time, but defense-in-depth is cheap.
  if (!['>', '>=', '<', '<='].includes(op)) {
    throw new Error(`refusing to interpolate unsafe comparator: ${op}`);
  }

  const params = [savedSearch.threshold];
  let where = `${col} IS NOT NULL AND ${col} ${op} $1`;
  if (savedSearch.artist_id) {
    params.push(savedSearch.artist_id);
    where += ` AND artist_id = $${params.length}`;
  }

  // For broad alerts (no artist scope), cap the email at the top-N
  // hottest matches so a misconfigured threshold doesn't spam. For
  // scoped alerts there's at most 1 row anyway.
  const limit = savedSearch.artist_id ? 1 : 5;
  params.push(limit);

  const sql = `
    SELECT artist_id, artist_name, ${col} AS value
      FROM breakout_signals
     WHERE ${where}
     ORDER BY ${col} ${op === '<' || op === '<=' ? 'ASC' : 'DESC'}
     LIMIT $${params.length}
  `;
  const { rows } = await query(sql, params);
  return rows.map((r) => ({
    artist_id: r.artist_id,
    artist_name: r.artist_name,
    value: r.value == null ? null : Number(r.value),
  }));
}

/**
 * Mark a saved search as fired — write last_alerted_at to gate the
 * next 24h window, plus a breadcrumb of which artist+value tripped it
 * for the admin/debug surface. Best-effort; logged on failure.
 */
async function recordAlert(savedSearchId, primaryMatch, now) {
  try {
    await query(
      `UPDATE saved_searches
          SET last_alerted_at = $2,
              last_match_artist_id = $3,
              last_match_value = $4
        WHERE id = $1`,
      [
        savedSearchId,
        now.toISOString(),
        primaryMatch?.artist_id ?? null,
        primaryMatch?.value ?? null,
      ]
    );
  } catch (err) {
    logger.warn(
      { err: err.message, savedSearchId },
      'saved_search alert breadcrumb write failed'
    );
  }
}

/**
 * Walk every due saved search, find matches, send emails, mark fired.
 *
 * @param {object} opts
 * @param {Date}    [opts.now]      — reference time. Default new Date().
 * @param {string}  [opts.baseUrl]  — public URL base for dashboard links.
 *                                    Falls back to the env's PUBLIC_BASE_URL
 *                                    via config; '' if neither is set.
 * @param {object}  [opts.mailer]   — override transport (for tests).
 *                                    Default: the singleton from lib/mailer.
 * @returns {Promise<{evaluated:number, fired:number, errors:number}>}
 */
export async function evaluateAllSavedSearches({
  now = new Date(),
  baseUrl = '',
  mailer = defaultMailer,
} = {}) {
  let evaluated = 0;
  let fired = 0;
  let errors = 0;

  let due;
  try {
    due = await loadDueSavedSearches({ now });
  } catch (err) {
    logger.error(
      { err: err.message },
      'savedsearch-evaluator: load failed; skipping cycle'
    );
    return { evaluated: 0, fired: 0, errors: 1 };
  }

  for (const s of due) {
    evaluated++;
    try {
      const matches = await findMatches(s);
      if (matches.length === 0) continue;

      const payload = buildEmailPayload({
        savedSearch: s,
        matches,
        recipient: s.user_email,
        baseUrl,
      });

      try {
        await mailer.send(payload);
      } catch (sendErr) {
        // Don't update last_alerted_at — let next cycle retry.
        errors++;
        logger.warn(
          { err: sendErr.message, savedSearchId: s.id, to: s.user_email },
          'saved-search email send failed'
        );
        continue;
      }

      await recordAlert(s.id, matches[0], now);
      fired++;
      logger.info(
        {
          savedSearchId: s.id,
          to: s.user_email,
          name: s.name,
          matchCount: matches.length,
        },
        'saved-search fired'
      );
    } catch (err) {
      errors++;
      logger.error(
        { err: err.message, savedSearchId: s.id },
        'saved-search evaluation failed'
      );
    }
  }

  logger.info(
    { evaluated, fired, errors },
    'saved-search evaluator complete'
  );
  return { evaluated, fired, errors };
}
