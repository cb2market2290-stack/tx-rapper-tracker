export function pwaHeaders(req, res, next) {
  if (req.path === '/sw.js') {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
  } else if (req.path === '/manifest.json') {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
}
