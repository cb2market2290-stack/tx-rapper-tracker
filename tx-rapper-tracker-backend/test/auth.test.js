// test/auth.test.js
// Pure-unit smoke tests for the auth primitives. These don't touch Postgres —
// we keep DB integration out of CI-safe tests so they stay fast and hermetic.
// End-to-end /signup + /login verification happens via the curl script in
// scripts/auth-smoke.sh (manual, requires a running server).
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Set required env BEFORE importing anything that touches config.js —
// config.js calls z.safeParse(process.env) at module load and exits the
// process on failure.
process.env.NODE_ENV = 'test';
process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'test_youtube_key_placeholder_123456';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const { hashPassword, verifyPassword, needsRehash } = await import('../src/auth/password.js');
const {
  generateToken,
  hashToken,
  signCookieValue,
  unsignCookieValue,
  constantTimeEqual,
} = await import('../src/auth/sessions.js');

// ---- Password hashing ----------------------------------------------------

test('hashPassword returns a PHC-format argon2id string', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^\$argon2id\$/, 'expected argon2id prefix');
  assert.ok(hash.length > 50, 'hash looks too short');
});

test('verifyPassword accepts the right password and rejects the wrong one', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(hash, 'wrong password entirely'), false);
});

test('verifyPassword returns false for malformed hashes without throwing', async () => {
  assert.equal(await verifyPassword('not-a-hash', 'anything'), false);
  assert.equal(await verifyPassword('', 'anything'), false);
  assert.equal(await verifyPassword(null, 'anything'), false);
});

test('hashPassword rejects empty passwords', async () => {
  await assert.rejects(() => hashPassword(''), /password required/);
});

test('needsRehash is false for a freshly made hash', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(needsRehash(hash), false);
});

// ---- Session tokens ------------------------------------------------------

test('generateToken returns 43-char base64url (256 bits of entropy)', () => {
  const t = generateToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  // 32 bytes base64url with no padding == 43 chars
  assert.equal(t.length, 43);
});

test('two tokens are never equal', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
});

test('hashToken is deterministic sha256 hex', () => {
  const t = 'some-fake-token';
  const h1 = hashToken(t);
  const h2 = hashToken(t);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64); // 32 bytes hex
  assert.match(h1, /^[0-9a-f]+$/);
});

// ---- Signed cookies ------------------------------------------------------

test('signed cookie roundtrips cleanly', () => {
  const raw = generateToken();
  const signed = signCookieValue(raw);
  assert.ok(signed.startsWith('s:'));
  const recovered = unsignCookieValue(signed);
  assert.equal(recovered, raw);
});

test('tampered cookie fails to unsign', () => {
  const raw = generateToken();
  const signed = signCookieValue(raw);
  // Flip the first body character (between "s:" and the "." before the sig)
  // to something guaranteed different. Using a fixed 'A' would produce the
  // original bytes ~1/64 of the time (tokens are base64url), so pick a
  // replacement based on what's there.
  const dotIdx = signed.indexOf('.');
  const first = signed[2];
  const replacement = first === 'A' ? 'B' : 'A';
  const tampered = 's:' + replacement + signed.slice(3, dotIdx) + signed.slice(dotIdx);
  assert.equal(unsignCookieValue(tampered), null);
});

test('unsignCookieValue returns null for garbage input', () => {
  assert.equal(unsignCookieValue(''), null);
  assert.equal(unsignCookieValue(null), null);
  assert.equal(unsignCookieValue('not-signed'), null);
  assert.equal(unsignCookieValue('s:missing-signature'), null);
});

// ---- Constant-time equality ---------------------------------------------

test('constantTimeEqual agrees with === for equal strings', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false); // length mismatch
});
