// src/routes/health.js
// Cheap, unauthenticated health/ready endpoints for uptime checks.
// /health = process is up. /ready = app can serve traffic.

import { Router } from 'express';
import { cacheStats } from '../lib/cache.js';

const router = Router();
const startedAt = Date.now();

router.get('/health', (_req, res) => {
  res.json({ ok: true, uptimeMs: Date.now() - startedAt });
});

router.get('/ready', (_req, res) => {
  res.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    cache: cacheStats(),
  });
});

export default router;
