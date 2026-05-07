import { verifyToken } from '../services/apiTokens.js';
import { query } from '../db/pool.js';

export function apiKeyAuth() {
  return async (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key) return next();
    try {
      const token = await verifyToken(key);
      if (!token) return next();
      const { rows: urows } = await query('SELECT * FROM users WHERE id = $1', [token.user_id]); const user = urows[0];
      if (user) req.user = user;
    } catch {
      // Don't block request on token lookup failure
    }
    next();
  };
}
