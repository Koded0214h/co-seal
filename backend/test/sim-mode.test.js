// Simulation mode (BITCOIN_LIVE unset): the demo path the current UI uses — still authenticated + RBAC'd.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coseal-sim-'));
process.env.UPLOAD_DIR = path.join(process.env.DATA_DIR, 'uploads');
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DEMO_MODE = 'true';
delete process.env.BITCOIN_LIVE;
delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.LLM_API_KEY; // AI unavailable

let srv; let base;
before(async () => {
  const { createApp } = await import('../src/app.js');
  srv = await new Promise((r) => { const s = createApp().listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

async function api(method, url, { token, json } = {}) {
  const res = await fetch(base + url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, body: await res.json() };
}
async function person() {
  const sk = generateSecretKey();
  const ch = (await api('POST', '/api/auth/challenge')).body;
  const event = finalizeEvent({ kind: ch.kind, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', ch.nonce]], content: '' }, sk);
  const r = await api('POST', '/api/auth/login', { json: { event } });
  return { token: r.body.token, pubkey: getPublicKey(sk), user: r.body.user };
}

test('simulation mode end to end over HTTP: create → join → simulate funding → dispatch → deliver → confirm → sign×2 → RELEASED (auth + roles enforced)', async () => {
  assert.equal((await api('GET', '/api/status')).body.bitcoinMode.startsWith('SIMULATION'), true);
  const seller = await person(); const buyer = await person(); const stranger = await person();
  const created = await api('POST', '/api/orders', { token: seller.token, json: { itemDescription: 'Radio', amountSats: 50_000 } });
  assert.equal(created.status, 201);
  const ref = created.body.ref;
  assert.equal(created.body.state, 'AWAITING_FUNDING', 'sim mode mints a placeholder escrow immediately');
  assert.match(created.body.escrow.address, /^tb1q-sim-/);
  assert.equal((await api('GET', `/api/orders/${ref}`)).body.openForBuyer, true);

  assert.equal((await api('POST', `/api/orders/${ref}/simulate-funding`, { token: stranger.token })).status, 403, 'only the buyer may simulate funding');
  assert.equal((await api('POST', `/api/orders/${ref}/join`, { token: seller.token, json: { buyerPubkey: seller.pubkey } })).status, 403, 'seller cannot join own order');
  const joined = await api('POST', `/api/orders/${ref}/join`, { token: buyer.token, json: { buyerPubkey: buyer.pubkey } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body.roles, ['BUYER']);
  assert.equal((await api('POST', `/api/orders/${ref}/join`, { token: stranger.token, json: { buyerPubkey: stranger.pubkey } })).status, 409);
  assert.equal((await api('GET', `/api/orders/${ref}`)).body.openForBuyer, false);

  assert.equal((await api('POST', `/api/orders/${ref}/simulate-funding`, { token: buyer.token })).body.state, 'FUNDED');
  const svc = await import('../src/services/orderService.js');
  svc.markDispatched(svc.getOrderByRef(ref), { dispatchReference: 'x' }); // dispatch route needs an image; covered in flows.test.js
  assert.equal((await api('POST', `/api/orders/${ref}/deliver`, { token: seller.token, json: {} })).body.state, 'REVIEW_PENDING');
  assert.equal((await api('POST', `/api/orders/${ref}/confirm`, { token: seller.token, json: {} })).status, 403);
  assert.equal((await api('POST', `/api/orders/${ref}/confirm`, { token: buyer.token, json: {} })).body.state, 'AWAITING_SIGNATURES');
  assert.equal((await api('POST', `/api/orders/${ref}/sign`, { token: stranger.token, json: { type: 'RELEASE', signerPubkey: 'x', signature: 'y' } })).status, 403);
  assert.equal((await api('POST', `/api/orders/${ref}/sign`, { token: buyer.token, json: { type: 'RELEASE', signerPubkey: buyer.pubkey, signature: 'sig' } })).body.state, 'AWAITING_SIGNATURES');
  const done = await api('POST', `/api/orders/${ref}/sign`, { token: seller.token, json: { type: 'RELEASE', signerPubkey: seller.pubkey, signature: 'sig' } });
  assert.equal(done.body.state, 'RELEASED');
  assert.match(done.body.settlements[0].txid, /^sim-txid-/);
});

test('simulation mode: seller ACCEPT yields a refund proposal; AI unavailable never blocks', async () => {
  const seller = await person(); const buyer = await person();
  const o = (await api('POST', '/api/orders', { token: seller.token, json: { itemDescription: 'Fan', amountSats: 20_000 } })).body;
  await api('POST', `/api/orders/${o.ref}/join`, { token: buyer.token, json: { buyerPubkey: buyer.pubkey } });
  await api('POST', `/api/orders/${o.ref}/simulate-funding`, { token: buyer.token });
  const svc = await import('../src/services/orderService.js');
  svc.markDispatched(svc.getOrderByRef(o.ref), { dispatchReference: 'x' });
  await api('POST', `/api/orders/${o.ref}/deliver`, { token: seller.token, json: {} });
  const d = await api('POST', `/api/orders/${o.ref}/dispute`, { token: buyer.token, json: { reason: 'broken' } });
  assert.equal(d.body.order.state, 'DISPUTED');
  const a = await api('POST', `/api/orders/${o.ref}/seller-response`, { token: seller.token, json: { response: 'ACCEPT' } });
  assert.equal(a.body.state, 'AWAITING_SIGNATURES');
  assert.equal(a.body.settlements[0].type, 'REFUND');
});

test('simulation mode enforces the same signer policy as live mode', async () => {
  const seller = await person(); const buyer = await person(); const arbUser = await person();
  const o = (await api('POST', '/api/orders', { token: seller.token, json: { itemDescription: 'Kettle', amountSats: 60_000 } })).body;
  await api('POST', `/api/orders/${o.ref}/join`, { token: buyer.token, json: { buyerPubkey: buyer.pubkey } });
  await api('POST', `/api/orders/${o.ref}/simulate-funding`, { token: buyer.token });
  const svc = await import('../src/services/orderService.js');
  const { db } = await import('../src/db.js');
  svc.markDispatched(svc.getOrderByRef(o.ref), { dispatchReference: 'x' });
  await api('POST', `/api/orders/${o.ref}/deliver`, { token: seller.token, json: {} });
  await api('POST', `/api/orders/${o.ref}/confirm`, { token: buyer.token, json: {} });
  const sign = (who) => api('POST', `/api/orders/${o.ref}/sign`, { token: who.token, json: { type: 'RELEASE', signerPubkey: who.pubkey, signature: 's' } });

  assert.equal((await sign(arbUser)).status, 403, 'non-participant');
  db.prepare('UPDATE orders SET arbitrator_user_id = ? WHERE ref = ?').run(arbUser.user.id, o.ref); // assigned arbitrator
  assert.equal((await sign(arbUser)).status, 403, 'arbitrator may not sign an undisputed (buyer-confirmed) release');
  assert.equal((await sign(buyer)).body.state, 'AWAITING_SIGNATURES');
  assert.equal((await sign(buyer)).body.state, 'AWAITING_SIGNATURES', 'the same role signing twice does not count twice');
  assert.equal((await sign(seller)).body.state, 'RELEASED');
});

test('simulation mode: a split needs the arbitrator even if buyer and seller both sign', async () => {
  const seller = await person(); const buyer = await person(); const arbUser = await person();
  const o = (await api('POST', '/api/orders', { token: seller.token, json: { itemDescription: 'Mixer', amountSats: 90_000 } })).body;
  const { db } = await import('../src/db.js');
  db.prepare('UPDATE orders SET arbitrator_user_id = ? WHERE ref = ?').run(arbUser.user.id, o.ref);
  await api('POST', `/api/orders/${o.ref}/join`, { token: buyer.token, json: { buyerPubkey: buyer.pubkey } });
  await api('POST', `/api/orders/${o.ref}/simulate-funding`, { token: buyer.token });
  const svc = await import('../src/services/orderService.js');
  svc.markDispatched(svc.getOrderByRef(o.ref), { dispatchReference: 'x' });
  await api('POST', `/api/orders/${o.ref}/deliver`, { token: seller.token, json: {} });
  await api('POST', `/api/orders/${o.ref}/dispute`, { token: buyer.token, json: { reason: 'x' } });
  await api('POST', `/api/orders/${o.ref}/seller-response`, { token: seller.token, json: { response: 'CONTEST' } });
  assert.equal((await api('POST', `/api/orders/${o.ref}/resolve`, { token: arbUser.token, json: { decision: 'SPLIT', sellerShareBps: 6000 } })).body.state, 'AWAITING_SIGNATURES');
  const sign = (who) => api('POST', `/api/orders/${o.ref}/sign`, { token: who.token, json: { type: 'SPLIT', signerPubkey: who.pubkey, signature: 's' } });
  await sign(buyer);
  assert.equal((await sign(seller)).body.state, 'AWAITING_SIGNATURES', 'buyer+seller cannot split alone');
  assert.equal((await sign(arbUser)).body.state, 'SPLIT');
});
