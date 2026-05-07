import express from 'express';
import { requireUser } from '../middleware/authenticate.js';
import { query } from '../db/pool.js';

const router = express.Router();

router.get('/artist/:id/csv', requireUser(), async (req, res, next) => {
  try {
    const artistId = Number(req.params.id);
    if (!artistId) return res.status(400).json({ error: 'invalid artist id' });

    const rows = await sql`
      SELECT
        s.collected_at::date AS date,
        s.platform,
        a.slug AS artist_slug,
        a.name AS artist_name,
        s.view_count AS views,
        s.rank
      FROM stats s
      JOIN artists a ON a.id = s.artist_id
      WHERE s.artist_id = ${artistId}
        AND s.collected_at >= now() - interval '90 days'
      ORDER BY s.collected_at DESC, s.platform ASC
    `;

    const slug = rows[0]?.artist_slug ?? String(artistId);
    const date = new Date().toISOString().slice(0, 10);
    const filename = 'txrt-' + slug + '-' + date + '.csv';

    const header = 'date,platform,artist_slug,artist_name,views,rank\n';
    const body = rows.map(r =>
      [r.date, r.platform, r.artist_slug, r.artist_name, r.views ?? '', r.rank ?? ''].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(header + body);
  } catch (e) { next(e); }
});

export default router;
