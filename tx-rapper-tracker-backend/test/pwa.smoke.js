// test/pwa.smoke.js
// Phase D — PWA smoke tests (live server, node:test + built-in fetch)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

describe('PWA smokes', () => {
  it('56: manifest_reachable', async () => {
    const res = await fetch(BASE + '/manifest.json');
    assert.equal(res.ok, true);
    const json = await res.json();
    assert.ok(json.start_url, 'manifest missing start_url');
  });

  it('57: sw_served', async () => {
    const res = await fetch(BASE + '/sw.js');
    assert.equal(res.ok, true);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('javascript'), 'sw.js wrong content-type');
  });

  it('58: pwa_status_route', async () => {
    const res = await fetch(BASE + '/api/pwa/status');
    assert.equal(res.ok, true);
    const json = await res.json();
    assert.ok(json.cacheVersion, 'missing cacheVersion');
  });
});
