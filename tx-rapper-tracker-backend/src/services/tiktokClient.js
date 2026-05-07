import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export function isEnabled() {
  return !!(config.tiktok?.rapidApiKey && config.tiktok?.rapidApiHost);
}

export async function fetchProfile(handle) {
  if (!isEnabled()) throw new Error('TikTok credentials not configured');
  const username = handle.replace(/^@/, '');
  const url = 'https://' + config.tiktok.rapidApiHost + '/user/info?uniqueId=' + encodeURIComponent(username);
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-key': config.tiktok.rapidApiKey,
      'x-rapidapi-host': config.tiktok.rapidApiHost,
    },
  });
  if (!res.ok) { logger.warn({ handle, status: res.status }, 'tiktok: fetch failed'); return null; }
  const data = await res.json();
  const user = data?.userInfo?.user;
  const stats = data?.userInfo?.stats;
  if (!user || !stats) { logger.warn({ handle }, 'tiktok: unexpected shape'); return null; }
  return {
    followers: stats.followerCount ?? null,
    following: stats.followingCount ?? null,
    total_likes: stats.heartCount ?? null,
    video_count: stats.videoCount ?? null,
    verified: user.verified ?? false,
  };
}
