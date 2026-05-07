import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db/pool.js';

const BASE = process.env.BASE_URL || 'http://localhost:8787';

describe('TikTok smokes', () => {
  it('69: tiktok_status_route', async () => {
    const res = await fetch(BASE + '/api/tiktok/status');
    assert.equal(res.ok, true);
    const json = await res.json();
    assert.ok('enabled' in json);
  });

  it('70: tiktok_disabled_safe', async () => {
    const res = await fetch(BASE + '/api/tiktok/status');
    assert.equal(res.ok, true);
    const json = await res.json();
    assert.equal(typeof json.enabled, 'boolean');
  });

  it('71: tiktok_artist_requires_auth', async () => {
    const res = await fetch(BASE + '/api/tiktok/artist/1');
    assert.ok(res.status === 401 || res.status === 403, 'expected 401/403 got ' + res.status);
  });

  it('72: tiktok_handle_column_exists', async () => {
    const { rows } = await query('SELECT tiktok_handle FROM artists LIMIT 1');
    assert.ok(Array.isArray(rows));
  });

  it('73: tiktok_stats_table_exists', async () => {
    const { rows } = await query('SELECT id FROM tiktok_stats LIMIT 1');
    assert.ok(Array.isArray(rows));
  });
});
