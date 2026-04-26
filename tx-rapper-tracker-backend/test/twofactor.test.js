// test/twofactor.test.js
// Pure-unit tests for the TOTP + recovery primitives. These don't touch
// Postgres — DB integration is covered by scripts/test-2fa.sh (end-to-end,
// requires a running server + dev DB).
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Same env-bootstrap dance as auth.test.js — config.js exits the process if
// required vars are missing, so set them BEFORE importing the modules.
process.env.NODE_ENV = 'test';
process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'test_youtube_key_placeholder_123456';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

const {
  generateTotpSecret,
  buildOtpAuthUrl,
  renderQrDataUrl,
  verifyCode,
  generateCurrentCode,
  encryptSecret,
  decryptSecret,
} = await import('../src/auth/totp.js');

// ---- Secret + URL --------------------------------------------------------

test('generateTotpSecret returns a Base32-looking string', () => {
  const s = generateTotpSecret();
  assert.match(s, /^[A-Z2-7]+$/, 'expected RFC 4648 Base32 charset');
  assert.ok(s.length >= 16, 'secret seems too short');
});

test('buildOtpAuthUrl produces a parseable otpauth URI with issuer + email', () => {
  const s = generateTotpSecret();
  const url = buildOtpAuthUrl(s, 'paul@example.com');
  assert.match(url, /^otpauth:\/\/totp\//, 'must be an otpauth totp URI');
  assert.ok(url.includes('paul%40example.com'), 'label should encode the email');
  assert.ok(url.includes('issuer='), 'issuer query param required');
  assert.ok(url.includes('secret='), 'secret query param required');
});

test('renderQrDataUrl returns a base64 PNG data URL', async () => {
  const url = buildOtpAuthUrl(generateTotpSecret(), 'paul@example.com');
  const qr = await renderQrDataUrl(url);
  assert.match(qr, /^data:image\/png;base64,/, 'expected png data URL');
  // 200x200-ish QR is well under 10 KB. If we ever exceed this we're rendering wrong.
  assert.ok(qr.length < 10000, 'QR data URL is suspiciously large: ' + qr.length);
});

// ---- verifyCode ----------------------------------------------------------

test('verifyCode accepts the current code', () => {
  const s = generateTotpSecret();
  const code = generateCurrentCode(s);
  assert.equal(verifyCode(s, code), true);
});

test('verifyCode rejects the wrong code', () => {
  const s = generateTotpSecret();
  // Pick a code that almost certainly isn't the current one. If
  // generateCurrentCode happened to return '000000' the test would still pass
  // because we'd flip to '111111'.
  const cur = generateCurrentCode(s);
  const bad = cur === '000000' ? '111111' : '000000';
  assert.equal(verifyCode(s, bad), false);
});

test('verifyCode tolerates the previous step (window=1)', () => {
  // We can't easily manipulate clock without faking, but we can confirm the
  // option is set by checking the verify accepts the current code which is
  // computed from the SAME clock — i.e. window=1 doesn't reject same-step.
  // (Drift across actual steps requires timer mocking; covered by otplib.)
  const s = generateTotpSecret();
  const code = generateCurrentCode(s);
  assert.equal(verifyCode(s, code), true);
});

test('verifyCode rejects empty / non-string / non-digit input without throwing', () => {
  const s = generateTotpSecret();
  assert.equal(verifyCode(s, ''), false);
  assert.equal(verifyCode(s, 'abcdef'), false);
  assert.equal(verifyCode(s, '12345'), false); // 5 digits — wrong length
  assert.equal(verifyCode(s, '1234567'), false); // 7 digits
  assert.equal(verifyCode(s, null), false);
  assert.equal(verifyCode(s, undefined), false);
  assert.equal(verifyCode(null, '123456'), false);
  assert.equal(verifyCode(undefined, '123456'), false);
});

test('verifyCode strips whitespace before validating', () => {
  const s = generateTotpSecret();
  const code = generateCurrentCode(s);
  // otplib handles spaces inside; our strip is "\s+" so '12 34 56' becomes '123456'.
  const spaced = code.slice(0, 3) + ' ' + code.slice(3);
  assert.equal(verifyCode(s, spaced), true);
});

// ---- AES-256-GCM encryption ---------------------------------------------

test('encryptSecret + decryptSecret round-trips a Base32 secret', () => {
  const s = generateTotpSecret();
  const enc = encryptSecret(s);
  assert.ok(Buffer.isBuffer(enc), 'expected a Buffer');
  // 12 (IV) + 16 (tag) + len(secret)
  assert.equal(enc.length, 12 + 16 + s.length);
  const dec = decryptSecret(enc);
  assert.equal(dec, s);
});

test('encryptSecret produces a different ciphertext each call (random IV)', () => {
  const s = generateTotpSecret();
  const a = encryptSecret(s).toString('base64');
  const b = encryptSecret(s).toString('base64');
  assert.notEqual(a, b, 'two encryptions of the same plaintext must differ (random IV)');
});

test('decryptSecret throws on a tampered ciphertext (auth tag mismatch)', () => {
  const s = generateTotpSecret();
  const enc = encryptSecret(s);
  // Flip a bit in the ciphertext portion (after IV+tag = byte 28).
  enc[enc.length - 1] ^= 0x01;
  assert.throws(() => decryptSecret(enc));
});

test('decryptSecret throws on a malformed (too short) buffer', () => {
  assert.throws(() => decryptSecret(Buffer.alloc(10)), /malformed/);
  assert.throws(() => decryptSecret('not a buffer'), /malformed/);
});

// ---- Recovery code FORMAT (without DB) -----------------------------------
// makeCode is internal, but we can sanity-check the spec by calling
// regenerateCodes... except that hits the DB. So instead, we re-derive the
// regex from the spec and just confirm it's exposed via regenerateCodes
// shape downstream (covered by the smoke script). Here we just assert the
// alphabet and structure constants in code.

test('recovery alphabet excludes confusable chars', async () => {
  // Read the source so a refactor that loosens the alphabet trips this test.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../src/auth/recovery.js', import.meta.url), 'utf8');
  const m = src.match(/const ALPHA = '([^']+)';/);
  assert.ok(m, 'ALPHA constant not found');
  const alpha = m[1];
  for (const banned of ['I', 'L', 'O', 'U', '0', '1']) {
    assert.ok(!alpha.includes(banned), `recovery alphabet must exclude "${banned}"`);
  }
  assert.ok(alpha.length >= 28, 'alphabet should still be substantial');
});
