/** Never log secrets (PRD §9). Redacts sensitive keys/values from anything we print. */
const SENSITIVE_KEY = /(priv|secret|seed|mnemonic|token|authorization|password|apikey|api_key|wif)/i;

export function redact(value, depth = 0) {
  if (depth > 5 || value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/cs_[A-Za-z0-9_-]{20,}/g, 'cs_[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
      .replace(/\b[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, '[redacted-wif]')
      .replace(/\b(xprv|tprv)[1-9A-HJ-NP-Za-km-z]{100,}\b/g, '[redacted-xprv]');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  }
  return value;
}

export function logError(prefix, err) {
  console.error(prefix, redact(err?.stack || String(err)));
}
