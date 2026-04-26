// src/routes/youtube.js
// Public-facing YouTube proxy. These endpoints are what app.html calls.
// The API key stays on the server — nothing sensitive goes back to the browser.

import { Router } from 'express';
import { z } from 'zod';
import * as yt from '../services/youtube.js';
import { getOrFetch } from '../lib/cache.js';
import { HttpError } from '../middleware/errorHandler.js';

const router = Router();

// ---- Input schemas -----------------------------------------------------
const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  maxResults: z.coerce.number().int().min(1).max(25).default(10),
  order: z.enum(['relevance', 'date', 'rating', 'viewCount', 'title']).default('relevance'),
  type: z.enum(['video', 'channel', 'playlist']).default('video'),
});

const ChannelQuery = z.object({
  id: z.string().min(1).max(200).optional(),
  username: z.string().min(1).max(200).optional(),
});

const ChannelUploadsQuery = z.object({
  channelId: z.string().min(1).max(200),
  maxResults: z.coerce.number().int().min(1).max(25).default(10),
});

const VideoStatsQuery = z.object({
  ids: z
    .string()
    .min(1)
    .max(1000)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
});

// ---- Helpers -----------------------------------------------------------
function parse(schema, input) {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(400, 'bad_request', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return r.data;
}

// ---- Routes ------------------------------------------------------------

/**
 * GET /api/youtube/search?q=megan+thee+stallion&maxResults=10&order=date
 * Used by app.html's "Latest YouTube videos" feed and the custom-artist search.
 */
router.get('/search', async (req, res, next) => {
  try {
    const q = parse(SearchQuery, req.query);
    const key = `yt:search:${q.q}:${q.maxResults}:${q.order}:${q.type}`;
    const data = await getOrFetch(key, () => yt.search(q));
    res.json({
      kind: 'youtube.search',
      query: q,
      items: data.items ?? [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/youtube/channel?id=UCxxx  OR  ?username=meganthestallion
 * Returns channel metadata + subscriber / view counts.
 */
router.get('/channel', async (req, res, next) => {
  try {
    const q = parse(ChannelQuery, req.query);
    if (!q.id && !q.username) {
      throw new HttpError(400, 'bad_request', 'id or username is required');
    }
    const key = `yt:channel:${q.id ?? ''}:${q.username ?? ''}`;
    const data = await getOrFetch(key, () =>
      yt.channels({ id: q.id, forUsername: q.username })
    );
    res.json({ kind: 'youtube.channel', items: data.items ?? [] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/youtube/channel/uploads?channelId=UCxxx&maxResults=10
 * Latest videos posted by a given channel. Use for artist "recent drops" feeds.
 */
router.get('/channel/uploads', async (req, res, next) => {
  try {
    const q = parse(ChannelUploadsQuery, req.query);
    const key = `yt:uploads:${q.channelId}:${q.maxResults}`;
    const data = await getOrFetch(key, () => yt.channelUploads(q));
    res.json({ kind: 'youtube.uploads', channelId: q.channelId, items: data.items ?? [] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/youtube/videos?ids=id1,id2,id3
 * Fetch stats/snippet for a batch of video IDs (max 50).
 */
router.get('/videos', async (req, res, next) => {
  try {
    const q = parse(VideoStatsQuery, req.query);
    if (q.ids.length === 0) throw new HttpError(400, 'bad_request', 'ids is required');
    if (q.ids.length > 50) throw new HttpError(400, 'bad_request', 'max 50 ids per call');
    const key = `yt:videos:${q.ids.join(',')}`;
    const data = await getOrFetch(key, () => yt.videos({ ids: q.ids }));
    res.json({ kind: 'youtube.videos', items: data.items ?? [] });
  } catch (err) {
    next(err);
  }
});

export default router;
