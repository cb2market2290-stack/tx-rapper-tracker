import { collectAll } from './tiktokCollector.js';
import { isEnabled } from './tiktokClient.js';
import { logger } from '../lib/logger.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function startTikTokScheduler() {
  if (!isEnabled()) { logger.info('tiktok: scheduler not started (no credentials)'); return; }
  collectAll().catch(err => logger.error({ err }, 'tiktok: initial collection failed'));
  setInterval(() => { collectAll().catch(err => logger.error({ err }, 'tiktok: scheduled collection failed')); }, SIX_HOURS);
  logger.info({ intervalHours: 6 }, 'tiktok: scheduler started');
}
