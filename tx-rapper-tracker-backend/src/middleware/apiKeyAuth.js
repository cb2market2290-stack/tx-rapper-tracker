import { verifyToken } from '../services/apiTokens.js';
import { sql } from '../db/pool.js';

export function apiKeyAuth() {
  return async (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key) return next();
    try {
      const token = await verifyToken(key);
      if (!token) return next();
      const [user] = await sql`SELECT * FROM users WHERE id = ${token.user_id}`;
      if (user) req.user = user;
    } catch {
      // Don't block request on token lookup failure
    }
    next();
  };
}
