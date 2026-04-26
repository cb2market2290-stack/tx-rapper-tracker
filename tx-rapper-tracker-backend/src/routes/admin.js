// src/routes/admin.js
// Admin endpoints — read + a small, deliberate write surface.
//
//   GET  /api/admin/audit                     — last N audit_log rows
//   GET  /api/admin/sessions                  — active sessions
//   GET  /api/admin/users                     — user list (email, disabled flag, counts)
//   GET  /api/admin/stats                     — cheap counts for dashboard
//   POST /api/admin/sessions/:id/revoke       — mark one session revoked
//   POST /api/admin/users/:id/disable         — set users.is_disabled = TRUE + revoke their sessions
//   POST /api/admin/users/:id/enable          — set users.is_disabled = FALSE
//
// Gated by requireAdmin() — returns 404 (not 403) for everyone else, so we
// don't advertise the route. Allow-list comes from the ADMIN_EMAILS env var;
// see src/config.js and src/middleware/authenticate.js.
//
// Writes are deliberate and audit-logged. An admin cannot disable themselves
// (that would be an irrecoverable footgun on a single-admin deploy).

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/authenticate.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requeueForReextraction } from '../services/features.js';

const router = Router();

router.use(requireAdmin());

// ---- Query parsing helpers ----------------------------------------------
// Schemas are exported so test/admin.test.js can exercise them hermetically
// without mounting the full router. Keep them in sync with the handlers.
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  event: z.string().trim().min(1).max(64).optional(),
  userId: z.string().uuid().optional(),
});

function parseQ(schema, input) {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(
      400,
      'bad_request',
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
  }
  return r.data;
}

// ---- Routes -------------------------------------------------------------

/** GET /api/admin/audit?event=login_failed&limit=50&offset=0 */
router.get('/audit', async (req, res, next) => {
  try {
    const q = parseQ(ListQuery, req.query ?? {});
    const where = [];
    const params = [];
    if (q.event) {
      params.push(q.event);
      where.push(`event = $${params.length}`);
    }
    if (q.userId) {
      params.push(q.userId);
      where.push(`user_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(q.limit, q.offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const { rows } = await query(
      `SELECT a.id, a.at AS created_at, a.event, a.user_id, u.email, a.ip, a.user_agent, a.details
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         ${whereSql}
        ORDER BY a.at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    res.json({
      kind: 'admin.audit',
      rows,
      limit: q.limit,
      offset: q.offset,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/sessions?limit=100 */
router.get('/sessions', async (req, res, next) => {
  try {
    const q = parseQ(ListQuery, req.query ?? {});
    const params = [q.limit, q.offset];
    const { rows } = await query(
      `SELECT s.id, s.user_id, u.email, s.created_at, s.last_seen_at,
              s.expires_at, s.ip, s.user_agent
         FROM sessions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.revoked_at IS NULL
          AND s.expires_at > now()
        ORDER BY s.last_seen_at DESC NULLS LAST, s.created_at DESC
        LIMIT $1 OFFSET $2`,
      params
    );
    res.json({
      kind: 'admin.sessions',
      rows,
      limit: q.limit,
      offset: q.offset,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/users?limit=200 — user directory. */
router.get('/users', async (req, res, next) => {
  try {
    const q = parseQ(ListQuery, req.query ?? {});
    const { rows } = await query(
      `SELECT u.id, u.email, u.display_name, u.is_disabled, u.created_at, u.last_login_at,
              (SELECT count(*) FROM sessions s
                 WHERE s.user_id = u.id
                   AND s.revoked_at IS NULL
                   AND s.expires_at > now())::int AS active_sessions
         FROM users u
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2`,
      [q.limit, q.offset]
    );
    res.json({
      kind: 'admin.users',
      rows,
      limit: q.limit,
      offset: q.offset,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Audit helper -------------------------------------------------------
// Duplicated from routes/auth.js so admin.js stays self-contained. If this
// grows to a third caller, lift it into src/audit.js.
async function audit({ req, userId, event, details }) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, event, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId ?? null,
        event,
        req.ip ?? null,
        req.get('user-agent') ?? null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    req.log?.warn({ err, event }, 'audit write failed');
  }
}

// ---- Writes -------------------------------------------------------------

export const UuidParam = z.string().uuid();
function parseUuid(raw, label) {
  const r = UuidParam.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'bad_request', `${label} is not a valid uuid`);
  return r.data;
}

/** POST /api/admin/sessions/:id/revoke — mark one session revoked. */
router.post('/sessions/:id/revoke', async (req, res, next) => {
  try {
    const id = parseUuid(req.params.id, 'session id');
    // Conditional UPDATE so a second call returns 404 cleanly rather than
    // silently succeeding — makes the audit trail honest.
    const { rows } = await query(
      `UPDATE sessions
          SET revoked_at = now()
        WHERE id = $1
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING id, user_id`,
      [id]
    );
    if (rows.length === 0) {
      throw new HttpError(404, 'not_found', 'session not found or already revoked');
    }
    await audit({
      req,
      userId: req.user.id,
      event: 'admin_revoke_session',
      details: { sessionId: id, targetUserId: rows[0].user_id },
    });
    res.json({ kind: 'admin.sessions.revoke', ok: true, sessionId: id });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/users/:id/disable — lock a user out. */
router.post('/users/:id/disable', async (req, res, next) => {
  try {
    const id = parseUuid(req.params.id, 'user id');
    // Self-protection: an admin disabling themselves on a single-admin
    // deploy would lock the app permanently. Cheap guard, big payoff.
    if (id === req.user.id) {
      throw new HttpError(400, 'cannot_disable_self', 'you cannot disable your own account');
    }
    const u = await query(
      `UPDATE users SET is_disabled = TRUE, updated_at = now()
        WHERE id = $1 AND is_disabled = FALSE
        RETURNING id, email`,
      [id]
    );
    if (u.rows.length === 0) {
      // Either doesn't exist, or already disabled. Distinguish for the UI.
      const check = await query('SELECT is_disabled FROM users WHERE id = $1', [id]);
      if (check.rows.length === 0) throw new HttpError(404, 'not_found', 'user not found');
      throw new HttpError(409, 'already_disabled', 'user is already disabled');
    }
    // Yank every live session so they're kicked on next request, not only
    // at the next attachUser hop.
    const r = await query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [id]
    );
    await audit({
      req,
      userId: req.user.id,
      event: 'admin_disable_user',
      details: { targetUserId: id, targetEmail: u.rows[0].email, sessionsRevoked: r.rowCount },
    });
    res.json({
      kind: 'admin.users.disable',
      ok: true,
      userId: id,
      sessionsRevoked: r.rowCount,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/users/:id/enable — unlock a previously-disabled user. */
router.post('/users/:id/enable', async (req, res, next) => {
  try {
    const id = parseUuid(req.params.id, 'user id');
    const u = await query(
      `UPDATE users SET is_disabled = FALSE, updated_at = now()
        WHERE id = $1 AND is_disabled = TRUE
        RETURNING id, email`,
      [id]
    );
    if (u.rows.length === 0) {
      const check = await query('SELECT is_disabled FROM users WHERE id = $1', [id]);
      if (check.rows.length === 0) throw new HttpError(404, 'not_found', 'user not found');
      throw new HttpError(409, 'already_enabled', 'user is already enabled');
    }
    await audit({
      req,
      userId: req.user.id,
      event: 'admin_enable_user',
      details: { targetUserId: id, targetEmail: u.rows[0].email },
    });
    res.json({ kind: 'admin.users.enable', ok: true, userId: id });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/snapshot-status?limit=20 — recent snapshot_runs rows, newest
 * first. Lets the admin panel show "did last night's stats snapshot run, and
 * did it succeed?" Read-only; rows are written by scripts/snapshot-stats.js.
 */
// Tighter schema than ListQuery — the admin panel only ever wants a small
// tail of this table, and the 500-row ceiling from ListQuery would be wasted.
export const SnapshotStatusQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(14),
});

router.get('/snapshot-status', async (req, res, next) => {
  try {
    const q = parseQ(SnapshotStatusQuery, req.query ?? {});
    const { rows } = await query(
      `SELECT started_at, finished_at, status, artists_total, rows_upserted,
              error_msg, duration_ms
         FROM snapshot_runs
        ORDER BY started_at DESC
        LIMIT $1`,
      [q.limit]
    );
    res.json({ kind: 'admin.snapshot_status', rows, limit: q.limit });
  } catch (err) {
    next(err);
  }
});

// ---- Artist roster -------------------------------------------------------
// Admin CRUD for the `artists` table. Read path for signed-in users lives
// at /api/artists (src/routes/artists.js). Archives are soft-deletes so
// historical artist_stats_daily rows keep their referent.

export const NewArtist = z.object({
  name: z.string().trim().min(1).max(200),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
});

/** GET /api/admin/artists — includes archived so the admin UI can unarchive. */
router.get('/artists', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, sort_order, is_archived, created_at, updated_at
         FROM artists
        ORDER BY is_archived ASC, sort_order ASC, name ASC`
    );
    res.json({ kind: 'admin.artists', rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/artists — add a new tracked artist. Body: { name, sortOrder? } */
router.post('/artists', async (req, res, next) => {
  try {
    const r = NewArtist.safeParse(req.body ?? {});
    if (!r.success) {
      throw new HttpError(
        400,
        'bad_request',
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      );
    }
    // Default sort_order to "bottom of the list" if caller didn't pick one,
    // so new artists slot in after everyone who's already there.
    const sortOrder =
      r.data.sortOrder ??
      (await query('SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM artists')).rows[0].next;
    const ins = await query(
      `INSERT INTO artists (name, sort_order) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, sort_order, is_archived`,
      [r.data.name, sortOrder]
    );
    if (ins.rows.length === 0) {
      // Distinguish: did it already exist archived (caller probably wants
      // to unarchive it) or active (just a duplicate).
      const ex = await query(
        `SELECT id, is_archived FROM artists WHERE name = $1`,
        [r.data.name]
      );
      const existing = ex.rows[0];
      if (existing?.is_archived) {
        throw new HttpError(409, 'archived_exists', 'artist is archived; unarchive instead');
      }
      throw new HttpError(409, 'already_exists', 'artist with that name already exists');
    }
    await audit({
      req,
      userId: req.user.id,
      event: 'admin_add_artist',
      details: { name: r.data.name, sortOrder },
    });
    res.json({ kind: 'admin.artists.create', ok: true, artist: ins.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/artists/:id/archive — soft-delete. */
router.post('/artists/:id/archive', async (req, res, next) => {
  try {
    const id = parseUuid(req.params.id, 'artist id');
    const u = await query(
      `UPDATE artists SET is_archived = TRUE, updated_at = now()
        WHERE id = $1 AND is_archived = FALSE
        RETURNING id, name`,
      [id]
    );
    if (u.rows.length === 0) {
      const check = await query('SELECT is_archived FROM artists WHERE id = $1', [id]);
      if (check.rows.length === 0) throw new HttpError(404, 'not_found', 'artist not found');
      throw new HttpError(409, 'already_archived', 'artist is already archived');
    }
    await audit({
      req,
      userId: req.user.id,
      event: 'admin_archive_artist',
      details: { artistId: id, name: u.rows[0].name },
    });
    res.json({ kind: 'admin.artists.archive', ok: true, artistId: id });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/artists/:id/unarchive — bring one back. */
router.post('/artists/:id/unarchive', async (req, res, next) => {
  try {
    const id = parseUuid(req.params.id, 'artist id');
    const u = await query(
      `UPDATE artists SET is_archived = FALSE, updated_at = now()
        WHERE id = $1 AND is_archived = TRUE
        RETURNING id, name`,
      [id]
    );
    if (u.rows.length === 0) {
      const check = await query('SELECT is_archived FROM artists WHERE id = $1', [id]);
      if (check.rows.length === 0) throw new HttpError(404, 'not_found', 'artist not found');
      throw new HttpError(409, 'already_active', 'artist is already active');
    }
    await audit({
      req,
      userId: req.user.id,
      event: 'admin_unarchive_artist',
      details: { artistId: id, name: u.rows[0].name },
    });
    res.json({ kind: 'admin.artists.unarchive', ok: true, artistId: id });
  } catch (err) {
    next(err);
  }
});

// ---- Audio extraction jobs (Phase 2e.B) ----------------------------------
// The Python worker (scripts/extract-features.py) drains
// track_extraction_jobs row by row. Things go wrong: yt-dlp can fail on a
// removed/age-restricted video, ffmpeg can choke, librosa can OOM on a
// 90-minute mix the worker shouldn't have downloaded in the first place.
// When that happens the row goes status='failed' with last_error set, and
// the worker moves on. The admin UI surfaces those failures + lets ops
// retry one job, retry-all-failed for an artist, or wipe an artist's
// extracted features and re-enqueue from scratch.
//
// Status values come from migration 009's CHECK constraint:
//   pending | running | done | failed | skipped
//
// Why these are admin-only: rebuilding features is expensive (yt-dlp
// downloads + librosa CPU). Letting any signed-in user trigger it would be
// a free DoS vector. Same posture as the daily snapshot job.

export const ExtractionJobsQuery = z.object({
  artistId: z.string().uuid().optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/admin/extraction-jobs?artistId=&status=&limit=
 * List recent extraction jobs with the artist name joined in. Sorts most-
 * recently-touched first so failures from the latest worker pass surface
 * at the top.
 */
router.get('/extraction-jobs', async (req, res, next) => {
  try {
    const q = parseQ(ExtractionJobsQuery, req.query ?? {});
    const where = [];
    const params = [];
    if (q.artistId) {
      params.push(q.artistId);
      where.push(`j.artist_id = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`j.status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(q.limit, q.offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;
    const { rows } = await query(
      `SELECT j.id, j.artist_id, a.name AS artist_name, j.video_id, j.title,
              j.duration_sec, j.status, j.attempts, j.last_error,
              j.enqueued_at, j.claimed_at, j.finished_at
         FROM track_extraction_jobs j
         LEFT JOIN artists a ON a.id = j.artist_id
         ${whereSql}
        ORDER BY COALESCE(j.finished_at, j.claimed_at, j.enqueued_at) DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    res.json({
      kind: 'admin.extraction_jobs',
      rows,
      limit: q.limit,
      offset: q.offset,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/extraction-status — small counts widget for the admin
 * dashboard. Lets the operator see at a glance "how many jobs are stuck
 * pending / how many have failed in the last 24h" without paging through
 * the table. Single GROUP BY query, plus a 24h failure count.
 */
router.get('/extraction-status', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         (SELECT count(*) FROM track_extraction_jobs WHERE status = 'pending')::int  AS pending,
         (SELECT count(*) FROM track_extraction_jobs WHERE status = 'running')::int  AS running,
         (SELECT count(*) FROM track_extraction_jobs WHERE status = 'done')::int     AS done,
         (SELECT count(*) FROM track_extraction_jobs WHERE status = 'failed')::int   AS failed,
         (SELECT count(*) FROM track_extraction_jobs WHERE status = 'skipped')::int  AS skipped,
         (SELECT count(*) FROM track_extraction_jobs
            WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed_24h,
         (SELECT count(*) FROM track_features)::int                                  AS features_total`
    );
    res.json({ kind: 'admin.extraction_status', stats: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/extraction-jobs/:id/retry — flip ONE job (any status) back
 * to pending. Resets attempts so the worker doesn't immediately give up
 * (the worker bails after attempts >= 5). enqueued_at is bumped to now()
 * so the FIFO claim queue picks this up after newer rows.
 *
 * 409 if the job doesn't exist; 200 with the updated row otherwise.
 */
const NumericIdParam = z.coerce.number().int().min(1);
function parseNumericId(raw, label) {
  const r = NumericIdParam.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'bad_request', `${label} is not a positive integer`);
  return r.data;
}

router.post('/extraction-jobs/:id/retry', async (req, res, next) => {
  try {
    const id = parseNumericId(req.params.id, 'job id');
    const { rows } = await query(
      `UPDATE track_extraction_jobs
          SET status = 'pending',
              attempts = 0,
              last_error = NULL,
              claimed_at = NULL,
              finished_at = NULL,
              enqueued_at = now()
        WHERE id = $1
        RETURNING id, artist_id, video_id, status`,
      [id]
    );
    if (rows.length === 0) {
      throw new HttpError(404, 'not_found', 'extraction job not found');
    }
    await audit({
      req,
      userId: req.user.id,
      event: 'admin_retry_extraction',
      details: {
        jobId: rows[0].id,
        artistId: rows[0].artist_id,
        videoId: rows[0].video_id,
      },
    });
    res.json({ kind: 'admin.extraction_jobs.retry', ok: true, job: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/artists/:id/reextract — re-enqueue every track this
 * artist has a track_features row for. Used after the analyzer's algorithm
 * changes ("librosa upgrade") or when an operator wants to wipe the slate
 * and let the worker rebuild from scratch.
 *
 * Body: { dropFeatures?: boolean } — when true, also DELETEs the artist's
 * track_features rows. Default false so the OLD numbers are still readable
 * during the re-extraction window (worker upserts will replace them).
 *
 * Walks the features table → builds {artist_id, video_id} pairs → calls
 * requeueForReextraction(). If the artist has no features yet there's
 * nothing to do; we report 0 requeued (not an error).
 */
const ReextractBody = z.object({
  dropFeatures: z.boolean().optional(),
});

router.post('/artists/:id/reextract', async (req, res, next) => {
  try {
    const id = parseUuid(req.params.id, 'artist id');
    const body = ReextractBody.safeParse(req.body ?? {});
    if (!body.success) {
      throw new HttpError(400, 'bad_request', body.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }

    // Confirm the artist exists so we don't return ok:true for a typo'd UUID.
    const artist = await query(
      `SELECT id, name, is_archived FROM artists WHERE id = $1`,
      [id]
    );
    if (artist.rows.length === 0) {
      throw new HttpError(404, 'not_found', 'artist not found');
    }

    const feats = await query(
      `SELECT artist_id, video_id, title, duration_sec
         FROM track_features WHERE artist_id = $1`,
      [id]
    );
    const requeued = await requeueForReextraction(feats.rows);

    let dropped = 0;
    if (body.data.dropFeatures) {
      const del = await query(
        `DELETE FROM track_features WHERE artist_id = $1`,
        [id]
      );
      dropped = del.rowCount ?? 0;
    }

    await audit({
      req,
      userId: req.user.id,
      event: 'admin_reextract_artist',
      details: {
        artistId: id,
        artistName: artist.rows[0].name,
        requeued: requeued.requeued,
        droppedFeatures: dropped,
      },
    });
    res.json({
      kind: 'admin.artists.reextract',
      ok: true,
      artistId: id,
      requeued: requeued.requeued,
      droppedFeatures: dropped,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/stats — cheap counts for the dashboard top strip. */
router.get('/stats', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         (SELECT count(*) FROM users)::int                                         AS users,
         (SELECT count(*) FROM users WHERE is_disabled)::int                       AS users_disabled,
         (SELECT count(*) FROM sessions
            WHERE revoked_at IS NULL AND expires_at > now())::int                  AS sessions_active,
         (SELECT count(*) FROM audit_log)::int                                     AS audit_total,
         (SELECT count(*) FROM audit_log
            WHERE event = 'login_failed' AND at > now() - interval '24 hours')::int
                                                                                    AS failed_logins_24h,
         (SELECT count(*) FROM audit_log
            WHERE event IN ('signup_weak_password','change_password_weak')
              AND at > now() - interval '24 hours')::int                           AS weak_password_rejects_24h`
    );
    res.json({ kind: 'admin.stats', stats: rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
