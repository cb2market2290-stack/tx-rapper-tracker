import express from 'express';
const router = express.Router();

router.get('/status', (req, res) => {
  res.json({ cacheVersion: 'txrt-v1', swEnabled: true, manifestUrl: '/manifest.json' });
});

export default router;
