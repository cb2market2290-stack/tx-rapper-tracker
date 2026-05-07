import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db/pool.js';

const BASE = process.env.BASE_URL || 'http://localhost:8787';

describe('Spotify smokes', () => {
  it('64: spotify_status_route', async () => {
    const res = await fetch(BASE + '/api/spotify/status');
    assert.equal(res.ok, true);
    const json = await res.json();
    assert.ok('enabled' in json);
  });

  it('65: spotify_disabled_safe', async () => {
    const res = await fetch(BASE + '/api/spotify/status');
    assert.equal(res.ok, true);
    const json = await res.json();
    assert.equal(typeof json.enabled, 'boolean');
  });

  it('66: spotify_artist_requires_auth', async () => {
    const res = await fetch(BASE + '/api/spotify/artist/1');
    assert.ok(res.status === 401 || res.status === 403, 'expected 401/403 got ' + res.status);
  });

  it('67: spotify_id_column_exists', async () => {
    const { rows } = await query('SELECT spotify_id FROM artists LIMIT 1');
    assert.ok(Array.isArray(rows));
  });

  it('68: spotify_stats_table_exists', async () => {
    const { rows } = await query('SELECT id FROM spotify_stats LIMIT 1');
    assert.ok(Array.isArray(rows));
  });
});
