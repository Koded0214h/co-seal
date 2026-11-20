export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
