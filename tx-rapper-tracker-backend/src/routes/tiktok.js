import express from 'express';
import { requireUser } from '../middleware/authenticate.js';
import { isEnabled } from '../services/tiktokClient.js';
import { query } from '../db/pool.js';

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT count(*)::int AS cnt FROM artists WHERE tiktok_handle IS NOT NULL');
    res.json({ enabled: isEnabled(), artistsTracked: rows[0].cnt });
  } catch (e) { next(e); }
});

router.get('/artist/:id', requireUser(), async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM tiktok_stats WHERE artist_id = $1 ORDER BY collected_at DESC LIMIT 1',
      [Number(req.params.id)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'no tiktok data for artist' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default router;
