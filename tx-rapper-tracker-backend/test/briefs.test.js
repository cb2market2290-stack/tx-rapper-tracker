// test/briefs.test.js
// Phase 3b.3 — offline coverage for src/services/briefs.js.
//
// The DB-touching paths (readCache / writeCache / getOrGenerateBrief
// against real Postgres) are exercised by scripts/test-briefs.sh in
// 3b.5. What we protect here is the part most likely to regress on a
// careless refactor:
//
//   1. fingerprint() determinism — same inputs, same hash, every time.
//   2. fingerprint() sensitivity — every input field that's part of
//      the cache contract MUST flip the hash when changed.
//   3. canonicalize() key-order stability — JS object construction
//      order can't leak into the fingerprint.
//   4. evaluateBrief() — too_short, too_long, forbidden_pattern, ok.
//   5. wordCount() boundary cases.
//   6. buildUserMessage() — has the artist name + the snapshot JSON +
//      doesn't leak nulls.
//   7. stripNulls() — recursive, preserves arrays, drops only nulls.
//   8. _generateForTests() — first-pass success short-circuits the
//      retry; first-pass failure triggers the retry; both-pass-fail
//      returns the better of the two with shapingDegraded:true.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Required env BEFORE importing the service (transitively loads
// config.js). The pure helpers don't touch the DB but the import-time
// zod validation fires regardless.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY || 'AIzaTEST_KEY_FOR_SMOKE_ONLY_0000000';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const briefs = await import('../src/services/briefs.js');
const {
  PROMPT_VERSION,
  DEFAULT_MODEL,
  fingerprint,
  canonicalize,
  keyInputs,
  evaluateBrief,
  wordCount,
  buildUserMessage,
  stripNulls,
  _generateForTests,
} = briefs;

// ---------------------------------------------------------------------------
// fingerprint determinism + sensitivity
// ---------------------------------------------------------------------------

test('fingerprint() is deterministic for identical inputs', () => {
  const inputs = {
    artistId: '00000000-0000-0000-0000-000000000001',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: '2026-04-15T12:00:00.000Z',
    promptVersion: PROMPT_VERSION,
    model: DEFAULT_MODEL,
  };
  const a = fingerprint(inputs);
  const b = fingerprint(inputs);
  assert.equal(a, b);
  assert.equal(a.length, 64); // sha256 hex
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('fingerprint() flips when artistId changes', () => {
  const base = {
    artistId: '00000000-0000-0000-0000-000000000001',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: '2026-04-15T12:00:00.000Z',
  };
  const a = fingerprint(base);
  const b = fingerprint({ ...base, artistId: '00000000-0000-0000-0000-000000000002' });
  assert.notEqual(a, b);
});

test('fingerprint() flips when latestSnapshotAt changes by a day', () => {
  const base = {
    artistId: '00000000-0000-0000-0000-000000000001',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: '2026-04-15T12:00:00.000Z',
  };
  const a = fingerprint(base);
  const b = fingerprint({ ...base, latestSnapshotAt: '2026-04-21' });
  assert.notEqual(a, b);
});

test('fingerprint() flips when latestFeaturesExtractedAt changes by a millisecond', () => {
  const base = {
    artistId: '00000000-0000-0000-0000-000000000001',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: '2026-04-15T12:00:00.000Z',
  };
  const a = fingerprint(base);
  const b = fingerprint({ ...base, latestFeaturesExtractedAt: '2026-04-15T12:00:00.001Z' });
  assert.notEqual(a, b);
});

test('fingerprint() flips when promptVersion changes', () => {
  const base = {
    artistId: '00000000-0000-0000-0000-000000000001',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: '2026-04-15T12:00:00.000Z',
  };
  const a = fingerprint({ ...base, promptVersion: 'v1' });
  const b = fingerprint({ ...base, promptVersion: 'v2' });
  assert.notEqual(a, b);
});

test('fingerprint() flips when model changes', () => {
  const base = {
    artistId: '00000000-0000-0000-0000-000000000001',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: '2026-04-15T12:00:00.000Z',
  };
  const a = fingerprint({ ...base, model: 'claude-haiku-4-5-20251001' });
  const b = fingerprint({ ...base, model: 'claude-sonnet-4-6-20251010' });
  assert.notEqual(a, b);
});

test('fingerprint() tolerates a NULL latestFeaturesExtractedAt', () => {
  const a = fingerprint({
    artistId: 'a',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: null,
  });
  const b = fingerprint({
    artistId: 'a',
    latestSnapshotAt: '2026-04-20',
    latestFeaturesExtractedAt: undefined,
  });
  // null and undefined both canonicalize to "no features yet" — same hash.
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// keyInputs — date normalization
// ---------------------------------------------------------------------------

test('keyInputs() normalizes latestSnapshotAt to YYYY-MM-DD', () => {
  const a = keyInputs({
    artistId: 'a',
    latestSnapshotAt: new Date('2026-04-20T15:30:00Z'),
    latestFeaturesExtractedAt: null,
  });
  assert.equal(a.latestSnapshotAt, '2026-04-20');
});

test('keyInputs() normalizes latestFeaturesExtractedAt to ISO', () => {
  const a = keyInputs({
    artistId: 'a',
    latestSnapshotAt: null,
    latestFeaturesExtractedAt: new Date('2026-04-15T12:00:00Z'),
  });
  assert.equal(a.latestFeaturesExtractedAt, '2026-04-15T12:00:00.000Z');
});

// ---------------------------------------------------------------------------
// canonicalize — key order stability
// ---------------------------------------------------------------------------

test('canonicalize() emits keys in sorted order regardless of construction', () => {
  const a = canonicalize({ b: 2, a: 1, c: 3 });
  const b = canonicalize({ c: 3, a: 1, b: 2 });
  const c = canonicalize({ a: 1, b: 2, c: 3 });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, '{"a":1,"b":2,"c":3}');
});

test('canonicalize() handles nested objects + arrays', () => {
  const out = canonicalize({ z: [1, { y: 'hi', x: null }], a: true });
  // Keys sorted at every level; arrays preserve order.
  assert.equal(out, '{"a":true,"z":[1,{"x":null,"y":"hi"}]}');
});

test('canonicalize() handles primitives correctly', () => {
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(0), '0');
  assert.equal(canonicalize('x'), '"x"');
  assert.equal(canonicalize(false), 'false');
});

// ---------------------------------------------------------------------------
// evaluateBrief
// ---------------------------------------------------------------------------

function fakeBriefOfWords(n) {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ') + '.';
}

test('evaluateBrief() accepts a 100-word paragraph with no forbidden patterns', () => {
  const brief = fakeBriefOfWords(100);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('evaluateBrief() rejects a 30-word paragraph as too_short', () => {
  const brief = fakeBriefOfWords(30);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_short');
});

test('evaluateBrief() rejects a 200-word paragraph as too_long', () => {
  const brief = fakeBriefOfWords(200);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_long');
});

test('evaluateBrief() rejects markdown bullet markers', () => {
  const brief =
    fakeBriefOfWords(80) + '\n- one\n- two\n' + fakeBriefOfWords(20);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden_pattern');
});

test('evaluateBrief() rejects numbered lists', () => {
  const brief =
    fakeBriefOfWords(80) + '\n1. first\n2. second\n' + fakeBriefOfWords(20);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden_pattern');
});

test('evaluateBrief() rejects markdown headers', () => {
  const brief = '# Header\n' + fakeBriefOfWords(80);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden_pattern');
});

test('evaluateBrief() rejects code fences', () => {
  const brief = fakeBriefOfWords(80) + '\n```js\ncode\n```\n' + fakeBriefOfWords(20);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden_pattern');
});

test('evaluateBrief() rejects URLs', () => {
  const brief = fakeBriefOfWords(80) + ' https://example.com ' + fakeBriefOfWords(20);
  const r = evaluateBrief(brief);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden_pattern');
});

// ---------------------------------------------------------------------------
// wordCount
// ---------------------------------------------------------------------------

test('wordCount() handles trim + multi-space + tabs', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount('one'), 1);
  assert.equal(wordCount('one two'), 2);
  assert.equal(wordCount('one   two\tthree\n\nfour'), 4);
  assert.equal(wordCount('   leading and trailing   '), 3);
});

// ---------------------------------------------------------------------------
// stripNulls
// ---------------------------------------------------------------------------

test('stripNulls() drops null + undefined keys recursively', () => {
  const out = stripNulls({
    a: 1,
    b: null,
    c: undefined,
    nested: { x: 'keep', y: null },
    arr: [1, null, 3],
  });
  assert.deepEqual(out, {
    a: 1,
    nested: { x: 'keep' },
    arr: [1, null, 3], // arrays preserve nulls (positional meaning)
  });
});

test('stripNulls() preserves zero / false / empty string', () => {
  const out = stripNulls({ a: 0, b: false, c: '' });
  assert.deepEqual(out, { a: 0, b: false, c: '' });
});

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

test('buildUserMessage() includes artist name + the snapshot payload', () => {
  const msg = buildUserMessage({
    artistName: 'Megan Thee Stallion',
    snapshots: [
      { d: '2026-04-20', v: 39000000, s: 1280000 },
      { d: '2026-04-21', v: 39200000, s: 1281000 },
    ],
    breakout: {
      viewGrowth7d: 1400000,
      pctGrowth7d: 0.036,
      hasFullWindow: true,
    },
    features: {
      trackCount: 12,
      tempoBpmAvg: 132,
      energyAvg: 0.78,
      dominantKey: { key: 'A', mode: 'minor', camelot: '8A' },
    },
  });
  assert.match(msg, /Megan Thee Stallion/);
  assert.match(msg, /Last 14 daily snapshots/);
  assert.match(msg, /"d":"2026-04-20"/);
  assert.match(msg, /Breakout-window signals/);
  assert.match(msg, /"viewGrowth7d":1400000/);
  assert.match(msg, /Aggregated audio features/);
  assert.match(msg, /"dominantKey":\{/);
  assert.match(msg, /Write the briefing\./);
});

test('buildUserMessage() handles missing breakout + features gracefully', () => {
  const msg = buildUserMessage({
    artistName: 'New Artist',
    snapshots: [],
    breakout: null,
    features: null,
  });
  assert.match(msg, /no breakout row yet/);
  assert.match(msg, /no audio features extracted yet/);
});

test('buildUserMessage() drops null fields from breakout + features', () => {
  const msg = buildUserMessage({
    artistName: 'A',
    snapshots: [],
    breakout: { viewGrowth7d: 100, acceleration7d: null, hasFullWindow: false },
    features: { trackCount: 0, tempoBpmAvg: null, energyAvg: null, dominantKey: null },
  });
  assert.doesNotMatch(msg, /"acceleration7d":null/);
  assert.doesNotMatch(msg, /"tempoBpmAvg":null/);
  assert.doesNotMatch(msg, /"dominantKey":null/);
  // hasFullWindow:false is NOT null and must be preserved.
  assert.match(msg, /"hasFullWindow":false/);
});

// ---------------------------------------------------------------------------
// _generateForTests — the retry orchestration
// ---------------------------------------------------------------------------

const META_FIXTURE = {
  name: 'Megan Thee Stallion',
  latestSnapshotAt: '2026-04-20',
  latestFeaturesExtractedAt: '2026-04-15T12:00:00Z',
};

const PROMPT_INPUT_FIXTURE = {
  artistId: '00000000-0000-0000-0000-000000000001',
  meta: META_FIXTURE,
  snapshots: [{ d: '2026-04-20', v: 39000000, s: 1280000 }],
  breakout: { viewGrowth7d: 1400000, hasFullWindow: true },
  features: { trackCount: 5, tempoBpmAvg: 130 },
};

test('_generateForTests: first-pass success skips the retry', async () => {
  const goodBrief = fakeBriefOfWords(100);
  let calls = 0;
  const fakeClaude = async () => {
    calls += 1;
    return { brief: goodBrief, tokensIn: 800, tokensOut: 130, model: DEFAULT_MODEL };
  };
  const r = await _generateForTests({ ...PROMPT_INPUT_FIXTURE, fakeClaude });
  assert.equal(calls, 1);
  assert.equal(r.brief, goodBrief);
  assert.equal(r.shapingDegraded, false);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
});

test('_generateForTests: first-pass fail triggers retry; retry succeeds', async () => {
  const badBrief = fakeBriefOfWords(20);    // too short
  const goodBrief = fakeBriefOfWords(100);
  let calls = 0;
  const fakeClaude = async ({ temperature }) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(temperature, 0.3);
      return { brief: badBrief, tokensIn: 800, tokensOut: 30, model: DEFAULT_MODEL };
    }
    assert.equal(temperature, 0.1);
    return { brief: goodBrief, tokensIn: 800, tokensOut: 130, model: DEFAULT_MODEL };
  };
  const r = await _generateForTests({ ...PROMPT_INPUT_FIXTURE, fakeClaude });
  assert.equal(calls, 2);
  assert.equal(r.brief, goodBrief);
  assert.equal(r.shapingDegraded, false);
});

test('_generateForTests: both passes fail → shapingDegraded=true', async () => {
  const badBrief = fakeBriefOfWords(20);
  let calls = 0;
  const fakeClaude = async () => {
    calls += 1;
    return { brief: badBrief, tokensIn: 800, tokensOut: 30, model: DEFAULT_MODEL };
  };
  const r = await _generateForTests({ ...PROMPT_INPUT_FIXTURE, fakeClaude });
  assert.equal(calls, 2);
  assert.equal(r.shapingDegraded, true);
});
