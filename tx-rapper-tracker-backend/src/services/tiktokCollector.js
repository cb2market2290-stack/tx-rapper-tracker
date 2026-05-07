import { fetchProfile, isEnabled } from './tiktokClient.js';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export async function collectAll() {
  if (!isEnabled()) return { skipped: true };
  const { rows: artists } = await query('SELECT id, tiktok_handle FROM artists WHERE tiktok_handle IS NOT NULL AND is_public = true');
  if (!artists.length) { logger.info('tiktok: no artists configured'); return { collected: 0 }; }
  let collected = 0;
  for (const artist of artists) {
    try {
      const profile = await fetchProfile(artist.tiktok_handle);
      if (!profile) continue;
      await query(
        'INSERT INTO tiktok_stats (artist_id, followers, following, total_likes, video_count, verified) VALUES ($1, $2, $3, $4, $5, $6)',
        [artist.id, profile.followers, profile.following, profile.total_likes, profile.video_count, profile.verified]
      );
      collected++;
    } catch (err) { logger.error({ artistId: artist.id, err }, 'tiktok: error'); }
    await new Promise(r => setTimeout(r, 200));
  }
  logger.info({ collected }, 'tiktok: run complete');
  return { collected };
}
