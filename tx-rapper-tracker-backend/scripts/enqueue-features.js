#!/usr/bin/env node
// scripts/enqueue-features.js
//
// Phase 2c: discovers each active artist's recent uploads via the YouTube
// API and inserts a row into track_extraction_jobs for any (artist_id,
// video_id) pair that doesn't already have one.
//
// Pairs with scripts/extract-features.py (the worker that drains the
// queue). Designed to run on its own launchd schedule, lighter and far
// less frequent than the worker (one daily pass is plenty — the YouTube
// quota cost is one search call per artist).
//
// Idempotency: ON CONFLICT (artist_id, video_id) DO NOTHING. Re-running
// the same day is a near-no-op (a few queries, zero inserts).
//
// CLI:
//   node scripts/enqueue-features.js               # all active artists
//   node scripts/enqueue-features.js --artist NAME # one artist
//   node scripts/enqueue-features.js --max 5       # up to N videos per artist
//   node scripts/enqueue-features.js --reextract librosa-0.11
//                                                  # re-enqueue all tracks
//                                                  # whose analyzer_version
//                                                  # != the value passed.
//                                                  # Combine with --artist
//                                                  # to scope to one roster
//                                                  # entry; --limit caps it.
//
// We don't try to be smart about "is this video a music video?" — the
// worker handles unavailable / removed / age-restricted streams cleanly
// and marks them 'skipped'. Better to fail fast on a bad row than build
// a fragile classifier here.

import { search, channelUploads } from '../src/services/youtube.js';
import { query, closePool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { getStaleVideoIds, requeueForReextraction } from '../src/services/features.js';

const DEFAULT_PER_ARTIST = 5;

// Pull the active roster, resolving an artist_id we can use for FKs in
// track_extraction_jobs.
async function loadRoster({ name } = {}) {
  if (name) {
    const { rows } = await query(
      `SELECT id, name FROM artists WHERE name = $1 AND NOT is_archived`,
      [name]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT id, name
       FROM artists
      WHERE NOT is_archived
      ORDER BY sort_order ASC, name ASC`
  );
  return rows;
}

// We try to reuse a previously-resolved channel id from artist_stats_daily
// before paying a search quota unit. Snapshot-stats.js writes channel_id
// on every successful run, so post-snapshot we should always have a fresh
// row to read from.
async function resolveChannelId(artistName) {
  const cached = await query(
    `SELECT channel_id
       FROM artist_stats_daily
      WHERE artist_name = $1 AND channel_id IS NOT NULL
      ORDER BY captured_on DESC
      LIMIT 1`,
    [artistName]
  );
  if (cached.rows[0]?.channel_id) return cached.rows[0].channel_id;
  // Cold path: hit YouTube search.
  const sr = await search({ q: `${artistName} rapper`, maxResults: 1, type: 'channel' });
  return sr?.items?.[0]?.id?.channelId ?? null;
}

// ISO 8601 PT1M30S → seconds. We rarely need this since channelUploads
// only returns snippet (no contentDetails.duration), but if a future caller
// passes us the full /videos response we'll be ready.
function isoDurationToSeconds(iso) {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, h, mn, s] = m;
  return (Number(h || 0) * 3600) + (Number(mn || 0) * 60) + Number(s || 0);
}

async function enqueueForArtist(artist, perArtist) {
  const channelId = await resolveChannelId(artist.name);
  if (!channelId) {
    return { name: artist.name, ok: false, reason: 'no_channel_found', inserted: 0 };
  }
  const ur = await channelUploads({ channelId, maxResults: perArtist });
  const items = Array.isArray(ur?.items) ? ur.items : [];
  if (items.length === 0) {
    return { name: artist.name, ok: true, channelId, inserted: 0 };
  }

  // Bulk insert with ON CONFLICT DO NOTHING. Idempotent and atomic.
  const values = [];
  const params = [];
  let i = 1;
  for (const it of items) {
    const videoId = it?.id?.videoId;
    if (!videoId) continue;
    const title = it?.snippet?.title ?? null;
    // duration is not in /search results; the worker can re-fetch if it
    // ever wants it. Leave duration_sec NULL on enqueue.
    values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(artist.id, videoId, title, null);
  }
  if (values.length === 0) {
    return { name: artist.name, ok: true, channelId, inserted: 0 };
  }
  const result = await query(
    `INSERT INTO track_extraction_jobs (artist_id, video_id, title, duration_sec)
     VALUES ${values.join(', ')}
     ON CONFLICT (artist_id, video_id) DO NOTHING`,
    params
  );
  return { name: artist.name, ok: true, channelId, inserted: result.rowCount ?? 0 };
}

function parseArgs(argv) {
  const out = {
    artist: null,
    max: DEFAULT_PER_ARTIST,
    reextract: null,   // when set, switches into re-extraction mode
    limit: 1000,       // cap for re-extraction so a misconfigured run doesn't
                       // requeue ten thousand tracks at once.
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--artist') out.artist = argv[++i];
    else if (a === '--max') out.max = Math.max(1, Number(argv[++i]) || DEFAULT_PER_ARTIST);
    else if (a === '--reextract') out.reextract = argv[++i];
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 1000);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/enqueue-features.js [--artist NAME] [--max N]');
      console.log('       node scripts/enqueue-features.js --reextract VERSION [--artist NAME] [--limit N]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// --- Re-extraction path -----------------------------------------------------
// When --reextract is set, skip the YouTube discovery loop entirely. We
// already know which (artist, video) pairs need re-analysis — they're the
// rows in track_features whose analyzer_version != currentAnalyzerVersion.
// Flip those job rows back to 'pending' and exit.
async function runReextract(args) {
  // Resolve the artist filter (if any) to a UUID up front.
  let artistId = null;
  if (args.artist) {
    const { rows } = await query(
      `SELECT id FROM artists WHERE name = $1 AND NOT is_archived`,
      [args.artist]
    );
    if (rows.length === 0) {
      logger.warn({ artist: args.artist }, 'reextract: artist not found');
      return 0;
    }
    artistId = rows[0].id;
  }

  const stale = await getStaleVideoIds({
    currentAnalyzerVersion: args.reextract,
    artistId,
    limit: args.limit,
  });
  logger.info(
    { currentAnalyzerVersion: args.reextract, artistId, stale: stale.length, limit: args.limit },
    'reextract: scanned'
  );
  if (stale.length === 0) return 0;

  // Group-log the unique stale versions so the operator knows what we're
  // sweeping (e.g. "found 80 from librosa-0.10.2, 4 from <NULL>").
  const byVer = stale.reduce((acc, r) => {
    const v = r.analyzer_version ?? '<null>';
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});
  logger.info({ byVer }, 'reextract: stale versions');

  const { requeued } = await requeueForReextraction(stale);
  logger.info({ requeued, scanned: stale.length }, 'reextract: finished');
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.reextract) {
    return await runReextract(args);
  }

  const roster = await loadRoster({ name: args.artist });
  if (roster.length === 0) {
    logger.warn(args, 'no matching artists');
    return 0;
  }
  logger.info({ count: roster.length, perArtist: args.max }, 'enqueue: starting');
  let totalInserted = 0;
  let failures = 0;
  for (const artist of roster) {
    try {
      const result = await enqueueForArtist(artist, args.max);
      if (!result.ok) {
        failures++;
        logger.warn(result, 'enqueue: artist failed');
      } else {
        totalInserted += result.inserted;
        logger.info(result, 'enqueue: artist done');
      }
    } catch (err) {
      failures++;
      logger.error({ err, artist: artist.name }, 'enqueue: artist threw');
    }
  }
  logger.info({ totalInserted, failures }, 'enqueue: finished');
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => closePool().finally(() => process.exit(code)))
  .catch((err) => {
    logger.error({ err }, 'enqueue: top-level failure');
    closePool().finally(() => process.exit(1));
  });
