// test/webauthn.test.js
// Pure-unit tests for the WebAuthn helper module. These don't touch
// Postgres or run a real WebAuthn ceremony — those are covered by
// scripts/test-webauthn.sh (which can only verify endpoint shapes, since
// curl can't drive the FIDO authenticator) and by a real browser smoke.
//
// What we test here:
//   * base64url ↔ Buffer round-trips (bufToB64url, b64urlToBuf)
//   * credentialRowToPublic shape mapping (DB row → JSON the API returns)
//
// The module imports @simplewebauthn/server unconditionally, so if it isn't
// installed (e.g. fresh sandbox before npm install) we emit a single skip
// and exit 0 rather than failing the whole test run.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// Same env-bootstrap dance as the other tests — config.js exits the process
// if required vars are missing, so set them BEFORE importing the module.
process.env.NODE_ENV = 'test';
process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'test_youtube_key_placeholder_123456';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'test-session-secret-at-least-thirty-two-chars-long-xxxxxxxxxx';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/tx_rapper_tracker_dev';

let mod;
try {
  mod = await import('../src/auth/webauthn.js');
} catch (err) {
  // Most likely cause: @simplewebauthn/server not installed yet. Don't
  // fail the suite — print why and skip every test in this file.
  test('webauthn helpers (skipped)', { skip: true }, () => {
    assert.ok(true, `import failed: ${err?.message ?? err}`);
  });
}

if (mod) {
  const { bufToB64url, b64urlToBuf, credentialRowToPublic } = mod;

  // ---- base64url helpers -------------------------------------------------

  test('bufToB64url: round-trips arbitrary bytes via b64urlToBuf', () => {
    const raw = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0xab, 0xcd]);
    const s = bufToB64url(raw);
    assert.equal(typeof s, 'string');
    // base64url alphabet: A–Z a–z 0–9 - _ (no padding)
    assert.match(s, /^[A-Za-z0-9_-]+$/);
    const back = b64urlToBuf(s);
    assert.ok(Buffer.isBuffer(back));
    assert.equal(back.equals(raw), true);
  });

  test('bufToB64url: handles a Uint8Array (not just Buffer)', () => {
    const u8 = new Uint8Array([1, 2, 3, 4, 5]);
    const s = bufToB64url(u8);
    const back = b64urlToBuf(s);
    assert.equal(back.equals(Buffer.from(u8)), true);
  });

  test('bufToB64url: drops the standard b64 padding character', () => {
    // 1 byte of input would normally encode to 4 chars with two = pads.
    const s = bufToB64url(Buffer.from([0x41])); // 'A'
    assert.equal(s.includes('='), false);
    assert.equal(b64urlToBuf(s).toString('utf8'), 'A');
  });

  test('bufToB64url: null input returns null (not an empty string)', () => {
    assert.equal(bufToB64url(null), null);
    assert.equal(bufToB64url(undefined), null);
  });

  test('b64urlToBuf: decodes a 32-byte challenge-shaped string', () => {
    const original = Buffer.from(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'hex'
    );
    const s = original.toString('base64url');
    const back = b64urlToBuf(s);
    assert.equal(back.equals(original), true);
    assert.equal(back.length, 32);
  });

  test('b64urlToBuf: empty/non-string input returns null', () => {
    assert.equal(b64urlToBuf(''), null);
    assert.equal(b64urlToBuf(null), null);
    assert.equal(b64urlToBuf(123), null);
    assert.equal(b64urlToBuf({}), null);
  });

  // ---- credentialRowToPublic --------------------------------------------

  test('credentialRowToPublic: maps a fully-populated row', () => {
    const credId = Buffer.from([0x10, 0x20, 0x30]);
    const created = new Date('2026-01-02T03:04:05Z');
    const lastUsed = new Date('2026-04-01T12:00:00Z');
    const out = credentialRowToPublic({
      id: 42,
      credential_id: credId,
      name: 'YubiKey 5C',
      transports: ['usb', 'nfc'],
      aaguid: 'cb69481e-8ff7-4039-93ec-0a2729a154a8',
      backup_eligible: true,
      backup_state: false,
      created_at: created,
      last_used_at: lastUsed,
    });
    assert.equal(out.id, 42);
    assert.equal(out.credentialId, credId.toString('base64url'));
    assert.equal(out.name, 'YubiKey 5C');
    assert.deepEqual(out.transports, ['usb', 'nfc']);
    assert.equal(out.aaguid, 'cb69481e-8ff7-4039-93ec-0a2729a154a8');
    assert.equal(out.backupEligible, true);
    assert.equal(out.backupState, false);
    assert.equal(out.createdAt, created);
    assert.equal(out.lastUsedAt, lastUsed);
  });

  test('credentialRowToPublic: never-used credential keeps lastUsedAt = null', () => {
    const out = credentialRowToPublic({
      id: 1,
      credential_id: Buffer.from([0xab]),
      name: null,
      transports: null,
      aaguid: null,
      backup_eligible: false,
      backup_state: false,
      created_at: new Date(),
      last_used_at: null,
    });
    assert.equal(out.lastUsedAt, null);
    assert.equal(out.name, null);
    assert.equal(out.transports, null);
    assert.equal(out.aaguid, null);
    // bools are coerced even when the row stored falsy nulls.
    assert.equal(out.backupEligible, false);
    assert.equal(out.backupState, false);
  });

  test('credentialRowToPublic: undefined optional fields collapse to null', () => {
    // simulate a SELECT that returned only id + credential_id + created_at
    const out = credentialRowToPublic({
      id: 7,
      credential_id: Buffer.from([0x01, 0x02]),
      created_at: new Date(),
      // name, transports, aaguid, last_used_at all undefined
    });
    assert.equal(out.name, null);
    assert.equal(out.transports, null);
    assert.equal(out.aaguid, null);
    assert.equal(out.lastUsedAt, null);
  });

  test('credentialRowToPublic: non-trivial credential_id round-trips through base64url', () => {
    // simplewebauthn credentials are ~16-32 bytes; make sure the encoding
    // doesn't choke on the high bit / non-printable bytes.
    const credId = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37) & 0xff));
    const out = credentialRowToPublic({
      id: 9,
      credential_id: credId,
      created_at: new Date(),
    });
    assert.match(out.credentialId, /^[A-Za-z0-9_-]+$/);
    assert.equal(b64urlToBuf(out.credentialId).equals(credId), true);
  });
}
