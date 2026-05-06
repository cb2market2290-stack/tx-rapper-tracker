import { verifyToken } from '../services/apiTokens.js';
import { getUserById } from '../services/users.js';

export function apiKeyAuth() {
  return async (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key) return next();
    try {
      const token = await verifyToken(key);
      if (!token) return next();
      const user = await getUserById(token.user_id);
      if (user) req.user = user;
    } catch {
      // Don't block request on token lookup failure
    }
    next();
  };
}
