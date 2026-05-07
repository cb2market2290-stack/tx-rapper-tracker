import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let cachedToken = null;
let tokenExpiry = 0;

export function isEnabled() {
  return !!(config.spotify?.clientId && config.spotify?.clientSecret);
}

export async function getToken() {
  if (!isEnabled()) throw new Error('Spotify credentials not configured');
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = Buffer.from(config.spotify.clientId + ':' + config.spotify.clientSecret).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Spotify token fetch failed: ' + await res.text());
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  logger.info({ expiresIn: data.expires_in }, 'spotify: token refreshed');
  return cachedToken;
}

export function getTokenExpiry() {
  return tokenExpiry ? new Date(tokenExpiry).toISOString() : null;
}
