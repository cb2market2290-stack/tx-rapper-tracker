// test/export.smoke.js
// Phase C — CSV export + API token smokes (live server, node:test)
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:8787';

// These smokes test unauthenticated rejection + endpoint existence.
// Full auth flow tested in integration; here we just verify shape + 401 behavior.

describe('B2B smokes', () => {
  it('59: token_create_requires_auth', async () => {
    const res = await fetch(BASE + '/api/tokens', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // Must reject unauthenticated — 401 or 403
    assert.ok(res.status === 401 || res.status === 403, 'expected 401/403 got ' + res.status);
  });

  it('60: token_list_requires_auth', async () => {
    const res = await fetch(BASE + '/api/tokens');
    assert.ok(res.status === 401 || res.status === 403, 'expected 401/403 got ' + res.status);
  });

  it('61: token_revoke_requires_auth', async () => {
    const res = await fetch(BASE + '/api/tokens/1', { method: 'DELETE' });
    assert.ok(res.status === 401 || res.status === 403, 'expected 401/403 got ' + res.status);
  });

  it('62: csv_export_requires_auth', async () => {
    const res = await fetch(BASE + '/api/export/artist/1/csv');
    assert.ok(res.status === 401 || res.status === 403, 'expected 401/403 got ' + res.status);
  });

  it('63: csv_export_bad_apikey_rejected', async () => {
    const res = await fetch(BASE + '/api/export/artist/1/csv', {
      headers: { 'X-API-Key': 'txrt_fakefakefake' }
    });
    assert.ok(res.status === 401 || res.status === 403, 'expected 401/403 got ' + res.status);
  });
});
