import express from 'express';
import { requireUser } from '../middleware/authenticate.js';
import { isEnabled, getTokenExpiry } from '../services/spotifyAuth.js';
import { query } from '../db/pool.js';

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT count(*)::int AS cnt FROM artists WHERE spotify_id IS NOT NULL');
    res.json({ enabled: isEnabled(), tokenExpiry: getTokenExpiry(), artistsTracked: rows[0].cnt });
  } catch (e) { next(e); }
});

router.get('/artist/:id', requireUser(), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM spotify_stats WHERE artist_id = $1 ORDER BY collected_at DESC LIMIT 1', [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'no spotify data' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default router;
