// src/services/briefs.js
// Phase 3b.3 — AI artist briefs.
//
// Premium-only Claude-generated paragraph that interprets an artist's
// recent snapshot history + audio features in plain prose.
//
// Three responsibilities:
//
//   1. Fingerprint the cache key. Pure function over the inputs the
//      prompt sees (PROMPT_VERSION, model, latest_snapshot_at,
//      latest_features_extracted_at, artist_id). Deterministic — same
//      inputs, same fingerprint, no exceptions.
//
//   2. Lazy-init a single Anthropic client. Same posture as
//      services/stripe.js: dynamic import so the SDK is optional in
//      dev, no client constructed at module load, throws on cache-miss
//      generation when the API key is unset.
//
//   3. Provide getOrGenerateBrief(artistId) — checks the cache first,
//      generates + persists on miss. Returns the brief plus billing
//      telemetry the route surfaces back to the caller.
//
// The prompt + parameters are LOCKED at PROMPT_VERSION='v1' (see
// PHASE_3B_DESIGN.md). Bumping PROMPT_VERSION invalidates every cached
// row in one move — that's the whole point of having it in the
// fingerprint. Any change to the system or user message text requires
// a version bump in this file AND a follow-up commit.

import crypto from 'node:crypto';

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { aggregate } from './features.js';
import { shapeRow as shapeBreakoutRow } from './breakout.js';

// ── locked constants ────────────────────────────────────────────────────
//
// Bumping PROMPT_VERSION rolls the cache cleanly. Bumping any of the
// system/user template, max_tokens, or temperature without bumping
// PROMPT_VERSION is a bug — we'd serve stale cached briefs against
// new prompt parameters. Every constant below is part of the cache
// contract.

export const PROMPT_VERSION = 'v1';
export const DEFAULT_MODEL = config.briefs.model;
export const MAX_TOKENS = 320;
export const TEMPERATURE = 0.3;
export const RETRY_TEMPERATURE = 0.1;

// Output-shaping bounds. Below the lower bound we re-call once at
// RETRY_TEMPERATURE; above the upper bound we trim before insert.
const MIN_WORDS = 50;
const MAX_WORDS = 180;

// Sentinel patterns we reject in the response — the prompt forbids
// these explicitly, and shipping them anyway would erode trust in the
// brief surface. If any match: re-call once. If the second response
// also matches: insert anyway, the route returns `shapingDegraded:true`
// so the frontend can render a small note.
const FORBIDDEN_PATTERNS = [
  /^\s*[-*•]\s/m,      // bullet markers at line start
  /^\s*\d+\.\s/m,      // numbered list at line start
  /^#{1,6}\s/m,        // markdown headers
  /```/,               // code fences
  /https?:\/\//i,      // URLs (the prompt forbids inventing references)
];

const SYSTEM_PROMPT = [
  'You are a music industry analyst writing a one-paragraph briefing for',
  'a label A&R team. The team is looking at a dashboard that tracks Texas',
  'female rappers via YouTube channel stats and audio features. They have',
  'the numbers in front of them — your job is to interpret what the',
  'numbers say in plain prose, the way a knowledgeable colleague would',
  'narrate it over the analyst\'s shoulder.',
  '',
  'Write 80 to 120 words, one paragraph, no bullet points, no headers, no',
  'markdown formatting. Lead with the most interesting signal in the',
  'data. If 7-day growth or acceleration is positive, say so concretely',
  '("up roughly 1.4M views in the last week"). If audio features show a',
  'distinct profile (a dominant key, a tight tempo range, unusually high',
  'or low energy), weave it in as one short clause. End with a forward',
  'look — what an A&R team should do or watch for, given the data.',
  '',
  'Do not invent facts that are not in the input. Do not name songs,',
  'collaborators, labels, or events that are not in the input. Do not',
  'speculate about chart positions, streaming numbers on platforms not',
  'shown, or industry rumors. The only ground truth is the JSON below.',
  'If a field is null, treat it as unknown and skip it rather than',
  'guessing.',
  '',
  'Write in present tense. Write in declarative sentences. Do not start',
  'with "This artist" or the artist\'s name — start with the most',
  'interesting fact and let the subject emerge naturally. Do not use the',
  'words "data" or "metrics" — talk about views, growth, tempo, energy,',
  'the music itself.',
].join('\n');

// ── fingerprint / canonicalization (pure) ───────────────────────────────

/**
 * Compose the canonical key_inputs object. Used by both the
 * fingerprint and a debug endpoint that wants to introspect "why is
 * this brief considered fresh".
 *
 * Note: artistId is used as the partition (we ALSO filter on it in
 * the SELECT), and folding it into the fingerprint defends against
 * a future bug where two artists somehow collide on the rest of the
 * key — better to be paranoid here.
 */
export function keyInputs({
  artistId,
  latestSnapshotAt,
  latestFeaturesExtractedAt,
  promptVersion = PROMPT_VERSION,
  model = DEFAULT_MODEL,
}) {
  return {
    artistId: artistId || null,
    latestSnapshotAt: latestSnapshotAt
      ? new Date(latestSnapshotAt).toISOString().slice(0, 10) // YYYY-MM-DD
      : null,
    latestFeaturesExtractedAt: latestFeaturesExtractedAt
      ? new Date(latestFeaturesExtractedAt).toISOString()
      : null,
    promptVersion,
    model,
  };
}

/**
 * Stable JSON canonicalization — keys always emitted in the SAME
 * order regardless of object construction order, so the fingerprint
 * survives JS engine quirks. Recursive over plain objects + arrays.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
    '}'
  );
}

/**
 * sha256 hex of canonicalize(keyInputs(...)).
 * 64 chars; matches the CHECK on artist_briefs.fingerprint.
 */
export function fingerprint(inputs) {
  const json = canonicalize(keyInputs(inputs));
  return crypto.createHash('sha256').update(json).digest('hex');
}

// ── DB getters ──────────────────────────────────────────────────────────

/**
 * Returns { artistId, name, latestSnapshotAt, latestFeaturesExtractedAt }
 * — everything the cache key + the prompt user-message needs about the
 * artist that we DON'T pull from the per-artist queries below.
 */
async function getArtistMetaForBrief(artistId) {
  const { rows } = await query(
    `SELECT a.id, a.name,
            (SELECT MAX(s.captured_on)
               FROM artist_stats_daily s
              WHERE s.artist_name = a.name) AS latest_snapshot_at,
            (SELECT MAX(f.extracted_at)
               FROM track_features f
              WHERE f.artist_id = a.id)    AS latest_features_extracted_at
       FROM artists a
      WHERE a.id = $1
        AND NOT a.is_archived`,
    [artistId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    artistId: r.id,
    name: r.name,
    latestSnapshotAt: r.latest_snapshot_at,
    latestFeaturesExtractedAt: r.latest_features_extracted_at,
  };
}

/**
 * The most recent 14 snapshots for the artist, oldest-first. Compact
 * shape ({d, v, s}) to keep prompt token count down — Claude doesn't
 * need verbose keys.
 */
async function getRecentSnapshots(artistName, limit = 14) {
  const { rows } = await query(
    `SELECT captured_on, lifetime_views, subs
       FROM artist_stats_daily
      WHERE artist_name = $1
      ORDER BY captured_on DESC
      LIMIT $2`,
    [artistName, limit]
  );
  // ORDER BY DESC then reverse → oldest-first compact array.
  return rows.reverse().map((r) => ({
    d: r.captured_on instanceof Date
      ? r.captured_on.toISOString().slice(0, 10)
      : String(r.captured_on),
    v: r.lifetime_views == null ? null : Number(r.lifetime_views),
    s: r.subs == null ? null : Number(r.subs),
  }));
}

/**
 * One row from breakout_signals for this artist (or null). Reuses
 * services/breakout's shapeRow so the keys match what the rest of
 * the codebase already knows.
 */
async function getBreakoutRow(artistId) {
  const { rows } = await query(
    `SELECT artist_id, artist_name, as_of,
            views_now, views_7d_ago, views_14d_ago,
            view_growth_7d, pct_growth_7d, acceleration_7d,
            has_full_window, computed_at
       FROM breakout_signals
      WHERE artist_id = $1
      LIMIT 1`,
    [artistId]
  );
  if (rows.length === 0) return null;
  return shapeBreakoutRow(rows[0]);
}

/**
 * The features-aggregate is the same one the detail page already shows.
 * We import aggregate() from services/features and feed it the raw rows.
 */
async function getFeaturesAggregate(artistId) {
  const { rows } = await query(
    `SELECT video_id, title, duration_sec,
            tempo_bpm, key_index, mode, camelot,
            energy, rms_db, spectral_centroid, spectral_rolloff,
            zero_crossing_rate, extracted_at, analyzer_version
       FROM track_features
      WHERE artist_id = $1
      ORDER BY extracted_at DESC`,
    [artistId]
  );
  return aggregate(rows);
}

// ── prompt assembly ─────────────────────────────────────────────────────

/**
 * Strip null fields recursively so the prompt JSON has minimum
 * surface for Claude to "see" missing data and start hallucinating.
 * Pure function — exported for tests.
 */
export function stripNulls(value) {
  if (Array.isArray(value)) {
    return value.map(stripNulls);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Build the user message Claude sees. Pure — exposed for tests so we
 * can assert "the prompt contains the artist name + the snapshot
 * payload" without mocking the DB.
 */
export function buildUserMessage({ artistName, snapshots, breakout, features }) {
  const snapshotsClean = stripNulls(snapshots);
  const breakoutClean = breakout ? stripNulls(breakout) : null;
  const featuresClean = features ? stripNulls(features) : null;
  const lines = [
    `Artist: ${artistName}`,
    '',
    'Last 14 daily snapshots (most recent last):',
    JSON.stringify(snapshotsClean),
    '',
    'Breakout-window signals (computed from the snapshots):',
    breakoutClean ? JSON.stringify(breakoutClean) : '(no breakout row yet)',
    '',
    'Aggregated audio features:',
    featuresClean ? JSON.stringify(featuresClean) : '(no audio features extracted yet)',
    '',
    'Write the briefing.',
  ];
  return lines.join('\n');
}

// ── output shaping (pure) ───────────────────────────────────────────────

export function wordCount(s) {
  if (!s) return 0;
  const trimmed = String(s).trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Returns {ok, reason} where reason is null on success or one of:
 *   'too_short' | 'too_long' | 'forbidden_pattern'.
 * Used to decide whether to retry once at RETRY_TEMPERATURE.
 */
export function evaluateBrief(brief) {
  const wc = wordCount(brief);
  if (wc < MIN_WORDS) return { ok: false, reason: 'too_short' };
  if (wc > MAX_WORDS) return { ok: false, reason: 'too_long' };
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(brief)) return { ok: false, reason: 'forbidden_pattern' };
  }
  return { ok: true, reason: null };
}

// ── Anthropic client (lazy, optional dep) ───────────────────────────────

let _client = null;

/**
 * Returns a configured Anthropic client. Throws if ANTHROPIC_API_KEY
 * isn't set or the SDK isn't installed. Callers that should
 * gracefully degrade (cache hits) should check `config.briefs.enabled`
 * first.
 */
export async function getAnthropic() {
  if (_client) return _client;
  if (!config.briefs.apiKey) {
    throw new Error('Briefs not configured: ANTHROPIC_API_KEY is empty');
  }
  let SdkMod;
  try {
    SdkMod = await import('@anthropic-ai/sdk');
  } catch (err) {
    throw new Error(
      'Anthropic SDK not installed. Run `npm install @anthropic-ai/sdk` in the backend directory.'
    );
  }
  const Anthropic = SdkMod.default || SdkMod.Anthropic || SdkMod;
  _client = new Anthropic({ apiKey: config.briefs.apiKey });
  return _client;
}

// Test seam — drop the cached client so tests can swap env or
// re-import without process restart.
export function _resetAnthropicClientForTests() {
  _client = null;
}

/**
 * Single Claude call. Returns { brief, tokensIn, tokensOut, model }.
 * Pure I/O — no DB, no caching, no retry. The retry-on-shape-failure
 * loop lives in generateAndStore where it can decide based on
 * evaluateBrief().
 */
export async function callClaude({ userMessage, model, temperature, signal }) {
  const client = await getAnthropic();
  const resp = await client.messages.create(
    {
      model,
      max_tokens: MAX_TOKENS,
      temperature,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    },
    signal ? { signal } : undefined
  );
  // The SDK returns content as an array of blocks; for text-only
  // responses (which is what we ask for) we concatenate the text
  // blocks. If Claude ever returns tool_use blocks for this prompt
  // something has gone wrong upstream — log + treat as empty.
  const text = (resp.content || [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  return {
    brief: text,
    tokensIn: resp.usage?.input_tokens ?? null,
    tokensOut: resp.usage?.output_tokens ?? null,
    model: resp.model || model,
  };
}

// ── cache reads/writes ──────────────────────────────────────────────────

async function readCache(artistId, fp) {
  const { rows } = await query(
    `SELECT brief, generated_at, model, tokens_in, tokens_out, prompt_version
       FROM artist_briefs
      WHERE artist_id = $1 AND fingerprint = $2
      LIMIT 1`,
    [artistId, fp]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    brief: r.brief,
    generatedAt: r.generated_at,
    model: r.model,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    promptVersion: r.prompt_version,
  };
}

async function writeCache({ artistId, fingerprint: fp, brief, tokensIn, tokensOut, model }) {
  // ON CONFLICT no-op so a race between two simultaneous misses on
  // the same key doesn't double-insert. Returns the row that exists
  // (which may be the loser of the race — either is fine, both are
  // valid briefs against the same fingerprint).
  const { rows } = await query(
    `INSERT INTO artist_briefs (
       artist_id, fingerprint, prompt_version, model,
       brief, tokens_in, tokens_out
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (artist_id, fingerprint) DO NOTHING
     RETURNING brief, generated_at, model, tokens_in, tokens_out, prompt_version`,
    [artistId, fp, PROMPT_VERSION, model, brief, tokensIn, tokensOut]
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      brief: r.brief,
      generatedAt: r.generated_at,
      model: r.model,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      promptVersion: r.prompt_version,
    };
  }
  // We lost the race — read the winner.
  return readCache(artistId, fp);
}

// ── main entry point ────────────────────────────────────────────────────

/**
 * Read-through cache for an artist's brief.
 *
 * Flow:
 *   1. Look up artist meta (snapshot/features freshness signals).
 *   2. Compute fingerprint over those + PROMPT_VERSION + model.
 *   3. Try the cache. Hit → return immediately.
 *   4. Miss → ensure SDK is configured (else throw briefs_unconfigured),
 *      assemble prompt inputs, call Claude, evaluate response. Re-call
 *      once at RETRY_TEMPERATURE if shape evaluation fails. Insert.
 *   5. Return { ...cached, cacheHit }.
 *
 * Throws:
 *   * Error('artist_not_found')     — artist missing or archived
 *   * Error('insufficient_data')    — 0 snapshots; nothing meaningful
 *                                     for Claude to summarize
 *   * Error('briefs_unconfigured')  — cache miss + ANTHROPIC_API_KEY unset
 *   * Anthropic SDK errors          — propagated; the route maps them
 *                                     to 504 (timeout) / 502 (upstream)
 */
export async function getOrGenerateBrief(artistId, opts = {}) {
  const { signal } = opts;
  const meta = await getArtistMetaForBrief(artistId);
  if (!meta) {
    const err = new Error('artist_not_found');
    err.code = 'artist_not_found';
    throw err;
  }
  if (!meta.latestSnapshotAt) {
    // No snapshots → nothing for Claude to summarize that's not
    // hallucination. The route surfaces this as a friendly 200 with
    // an empty brief + a kind code; we don't burn API credits on it.
    const err = new Error('insufficient_data');
    err.code = 'insufficient_data';
    throw err;
  }

  const fp = fingerprint({
    artistId: meta.artistId,
    latestSnapshotAt: meta.latestSnapshotAt,
    latestFeaturesExtractedAt: meta.latestFeaturesExtractedAt,
    promptVersion: PROMPT_VERSION,
    model: DEFAULT_MODEL,
  });

  const hit = await readCache(meta.artistId, fp);
  if (hit) {
    return { ...hit, cacheHit: true, fingerprint: fp };
  }

  // Cache miss — must be able to talk to Claude.
  if (!config.briefs.enabled) {
    const err = new Error('briefs_unconfigured');
    err.code = 'briefs_unconfigured';
    throw err;
  }

  // Build the prompt payload.
  const [snapshots, breakout, features] = await Promise.all([
    getRecentSnapshots(meta.name),
    getBreakoutRow(meta.artistId),
    getFeaturesAggregate(meta.artistId),
  ]);
  const userMessage = buildUserMessage({
    artistName: meta.name,
    snapshots,
    breakout,
    features,
  });

  // First attempt at TEMPERATURE.
  let result = await callClaude({
    userMessage,
    model: DEFAULT_MODEL,
    temperature: TEMPERATURE,
    signal,
  });
  let evalResult = evaluateBrief(result.brief);

  // One-shot retry at RETRY_TEMPERATURE if the first response failed
  // shaping. We do NOT loop further — the prompt is locked, and
  // chasing the response into compliance burns budget for marginal
  // returns. After the retry we accept whatever we got, but record
  // the degraded flag so callers can render a small note.
  let shapingDegraded = false;
  if (!evalResult.ok) {
    const retry = await callClaude({
      userMessage,
      model: DEFAULT_MODEL,
      temperature: RETRY_TEMPERATURE,
      signal,
    });
    const retryEval = evaluateBrief(retry.brief);
    if (retryEval.ok) {
      result = retry;
      evalResult = retryEval;
    } else {
      // Pick whichever looked more like a brief — prefer one that
      // passes word count even if it has a forbidden pattern, since
      // pattern hits are recoverable on the frontend (we render as
      // pre-wrap; bullets become awkward but readable) but length
      // failures are not.
      const firstWc = wordCount(result.brief);
      const retryWc = wordCount(retry.brief);
      const firstWindowed = firstWc >= MIN_WORDS && firstWc <= MAX_WORDS;
      const retryWindowed = retryWc >= MIN_WORDS && retryWc <= MAX_WORDS;
      if (retryWindowed && !firstWindowed) {
        result = retry;
      }
      shapingDegraded = true;
    }
  }

  // Hard upper trim — if the model massively overshot, clip to ~180
  // words at a sentence boundary. Better than serving a wall of text.
  let brief = result.brief;
  if (wordCount(brief) > MAX_WORDS) {
    const sentences = brief.split(/(?<=[.!?])\s+/);
    let acc = '';
    for (const s of sentences) {
      if (wordCount(acc + ' ' + s) > MAX_WORDS) break;
      acc = acc ? acc + ' ' + s : s;
    }
    brief = acc || brief.split(/\s+/).slice(0, MAX_WORDS).join(' ');
  }

  const stored = await writeCache({
    artistId: meta.artistId,
    fingerprint: fp,
    brief,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    model: result.model,
  });

  return { ...stored, cacheHit: false, fingerprint: fp, shapingDegraded };
}

// ── test seam ───────────────────────────────────────────────────────────

/**
 * Like getOrGenerateBrief but you provide the Claude client (or any
 * shape with a compatible callClaude). Used by the unit tests so we
 * don't hit the network. NOT exported via index — internal.
 */
export async function _generateForTests({
  artistId,
  meta,
  snapshots,
  breakout,
  features,
  fakeClaude, // async ({ temperature }) => ({ brief, tokensIn, tokensOut, model })
}) {
  const fp = fingerprint({
    artistId,
    latestSnapshotAt: meta?.latestSnapshotAt,
    latestFeaturesExtractedAt: meta?.latestFeaturesExtractedAt,
    promptVersion: PROMPT_VERSION,
    model: DEFAULT_MODEL,
  });
  const userMessage = buildUserMessage({
    artistName: meta.name,
    snapshots,
    breakout,
    features,
  });
  let result = await fakeClaude({ temperature: TEMPERATURE, userMessage });
  let evalResult = evaluateBrief(result.brief);
  let shapingDegraded = false;
  if (!evalResult.ok) {
    const retry = await fakeClaude({ temperature: RETRY_TEMPERATURE, userMessage });
    const retryEval = evaluateBrief(retry.brief);
    if (retryEval.ok) {
      result = retry;
    } else {
      shapingDegraded = true;
    }
  }
  return { ...result, fingerprint: fp, shapingDegraded };
}
