import { getToken, isEnabled } from './spotifyAuth.js';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

async function fetchArtist(spotifyId, token) {
  const res = await fetch('https://api.spotify.com/v1/artists/' + spotifyId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) { logger.warn({ spotifyId, status: res.status }, 'spotify: fetch failed'); return null; }
  return res.json();
}

export async function collectAll() {
  if (!isEnabled()) return { skipped: true };
  const { rows: artists } = await query('SELECT id, spotify_id FROM artists WHERE spotify_id IS NOT NULL AND is_public = true');
  if (!artists.length) { logger.info('spotify: no artists configured'); return { collected: 0 }; }
  const token = await getToken();
  let collected = 0;
  for (const artist of artists) {
    try {
      const data = await fetchArtist(artist.spotify_id, token);
      if (!data) continue;
      await query('INSERT INTO spotify_stats (artist_id, followers, popularity, genres) VALUES ($1, $2, $3, $4)',
        [artist.id, data.followers?.total ?? null, data.popularity ?? null, JSON.stringify(data.genres ?? [])]);
      collected++;
    } catch (err) { logger.error({ artistId: artist.id, err }, 'spotify: error'); }
    await new Promise(r => setTimeout(r, 100));
  }
  logger.info({ collected }, 'spotify: run complete');
  return { collected };
}
