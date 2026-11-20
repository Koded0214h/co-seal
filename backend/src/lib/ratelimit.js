import { config } from '../config.js';

/** Small in-memory fixed-window limiter (per IP + bucket). Fine for a single-node MVP. */
export function rateLimit({ bucket, limit }) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref?.();
  return (req, res, next) => {
    if (!config.rateLimit.enabled) return next();
    const key = `${bucket}:${req.ip}`;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > limit) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'Too many requests, slow down' });
    }
    next();
  };
}
