import { collectAll } from './spotifyCollector.js';
import { isEnabled } from './spotifyAuth.js';
import { logger } from '../lib/logger.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function startSpotifyScheduler() {
  if (!isEnabled()) { logger.info('spotify: scheduler not started (no credentials)'); return; }
  collectAll().catch(err => logger.error({ err }, 'spotify: initial collection failed'));
  setInterval(() => { collectAll().catch(err => logger.error({ err }, 'spotify: scheduled collection failed')); }, SIX_HOURS);
  logger.info({ intervalHours: 6 }, 'spotify: scheduler started');
}
