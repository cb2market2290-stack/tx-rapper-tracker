// src/services/youtube.js
// YouTube Data API v3 client. API key lives in env and never leaves the server.
// Keep this service "dumb" — it only speaks to YouTube and returns JSON.
// All caching, validation, and shaping happens in routes/youtube.js.

import { request } from 'undici';
import { config } from '../config.js';
import { HttpError } from '../middleware/errorHandler.js';

const BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', config.youtubeApiKey);

  const { statusCode, body } = await request(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  const json = await body.json().catch(() => ({}));

  if (statusCode >= 400) {
    // YouTube quota or key errors — surface a sanitized message.
    const upstreamMsg = json?.error?.message || 'YouTube API error';
    throw new HttpError(
      statusCode === 403 ? 502 : statusCode,
      'upstream_youtube_error',
      upstreamMsg
    );
  }

  return json;
}

/** Search across YouTube. `q` is the only required param. */
export function search({ q, maxResults = 10, type = 'video', order = 'relevance' }) {
  return ytGet('/search', {
    part: 'snippet',
    q,
    maxResults,
    type,
    order,
    safeSearch: 'none',
  });
}

/** List videos by ID (comma-separated). Useful for fetching stats after a search. */
export function videos({ ids, part = 'snippet,statistics,contentDetails' }) {
  return ytGet('/videos', {
    part,
    id: Array.isArray(ids) ? ids.join(',') : ids,
    maxResults: 50,
  });
}

/** Get channel info by ID or username. */
export function channels({ id, forUsername, part = 'snippet,statistics' }) {
  return ytGet('/channels', { part, id, forUsername, maxResults: 50 });
}

/** Latest uploads from a channel. */
export function channelUploads({ channelId, maxResults = 10 }) {
  return ytGet('/search', {
    part: 'snippet',
    channelId,
    maxResults,
    order: 'date',
    type: 'video',
  });
}
