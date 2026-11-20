// Tiny fetch wrapper around the CoSeal API (proxied to :4000 in dev).
// In production, set VITE_API_URL to the deployed backend's origin.
const BASE = `${import.meta.env.VITE_API_URL || ''}/api`;

async function req(path, { method = 'GET', body, form, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form; // FormData — let the browser set the boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  status: () => req('/status'),
  network: () => req('/network'),

  createOrder: (body) => req('/orders', { method: 'POST', body }),
  getOrder: (ref) => req(`/orders/${ref}`),
  simulateFunding: (ref) => req(`/orders/${ref}/simulate-funding`, { method: 'POST' }),
  checkFunding: (ref) => req(`/orders/${ref}/check-funding`, { method: 'POST' }),
  dispatch: (ref, form) => req(`/orders/${ref}/dispatch`, { method: 'POST', form }),
  inTransit: (ref) => req(`/orders/${ref}/in-transit`, { method: 'POST' }),
  deliver: (ref) => req(`/orders/${ref}/deliver`, { method: 'POST' }),
  confirm: (ref) => req(`/orders/${ref}/confirm`, { method: 'POST' }),
  dispute: (ref, form) => req(`/orders/${ref}/dispute`, { method: 'POST', form }),
  sellerResponse: (ref, response) => req(`/orders/${ref}/seller-response`, { method: 'POST', body: { response } }),
  sign: (ref, type, signerPubkey, signature) =>
    req(`/orders/${ref}/sign`, { method: 'POST', body: { type, signerPubkey, signature } }),

  admin: {
    orders: (token) => req('/admin/orders', { token }),
    reviewQueue: (token) => req('/admin/review-queue', { token }),
    recompare: (token, ref) => req(`/admin/orders/${ref}/recompare`, { method: 'POST', token }),
    resolve: (token, ref, decision, note) =>
      req(`/admin/orders/${ref}/resolve`, { method: 'POST', token, body: { decision, note } }),
  },
};
