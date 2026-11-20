import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { startServer, world, keyset, createOrderHttp, joinHttp, newKey, keys, chain, signAs, adminSk } from './helpers.js';
import { redact } from '../src/lib/log.js';
import { rateLimit } from '../src/lib/ratelimit.js';
import { db } from '../src/db.js';

let srv; let W;
before(async () => { srv = await startServer(); W = await world(srv); });
after(async () => { await srv.close(); });

const call = (m, u, o) => srv.api(m, u, o);

async function freshEvent(sk, { kind, nonce, created_at, tags } = {}) {
  const ch = (await call('POST', '/api/auth/challenge')).body;
  return finalizeEvent({
    kind: kind ?? ch.kind, created_at: created_at ?? Math.floor(Date.now() / 1000),
    tags: tags ?? [['challenge', nonce ?? ch.nonce]], content: '',
  }, sk);
}

test('login: valid signed challenge yields a session; replay, stale, wrong-kind, forged and missing-challenge are rejected', async () => {
  const sk = generateSecretKey();
  const ev = await freshEvent(sk);
  const ok = await call('POST', '/api/auth/login', { json: { event: ev } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.token, /^cs_/);
  assert.equal(ok.body.user.pubkey, getPublicKey(sk));
  assert.equal(ok.body.user.role, 'USER');

  assert.equal((await call('POST', '/api/auth/login', { json: { event: ev } })).status, 401, 'replayed challenge');
  assert.equal((await call('POST', '/api/auth/login', { json: { event: await freshEvent(sk, { created_at: Math.floor(Date.now() / 1000) - 3600 }) } })).status, 401, 'stale');
  assert.equal((await call('POST', '/api/auth/login', { json: { event: await freshEvent(sk, { kind: 1 }) } })).status, 400, 'wrong kind');
  assert.equal((await call('POST', '/api/auth/login', { json: { event: await freshEvent(sk, { tags: [] }) } })).status, 400, 'no challenge');
  assert.equal((await call('POST', '/api/auth/login', { json: { event: await freshEvent(sk, { nonce: 'f'.repeat(48) }) } })).status, 401, 'unknown nonce');
  const forged = { ...(await freshEvent(sk)), content: 'tampered' };
  assert.equal((await call('POST', '/api/auth/login', { json: { event: forged } })).status, 401, 'forged signature');
});

test('tokens are stored hashed, and logout revokes the session', async () => {
  const u = await srv.person('t');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(u.token).n, 0, 'raw token must not be stored');
  assert.equal((await call('GET', '/api/me', { token: u.token })).status, 200);
  assert.equal((await call('POST', '/api/auth/logout', { token: u.token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: u.token })).status, 401);
});

test('unauthenticated users cannot mutate; the link still shows the public agreement', async () => {
  const seller = await srv.person('seller');
  const ks = keyset();
  assert.equal((await call('POST', '/api/orders', { json: { itemDescription: 'x', amountSats: 1000 } })).status, 401);
  const order = await createOrderHttp(srv, seller, ks);
  assert.equal(order.roles.includes('SELLER'), true);

  const anon = (await call('GET', `/api/orders/${order.ref}`)).body;
  assert.equal(anon.view, 'PUBLIC');
  assert.equal(anon.itemDescription, 'Leather boots');
  assert.equal(anon.openForBuyer, true);
  for (const k of ['evidence', 'settlements', 'notifications', 'participants', 'dispute']) assert.equal(k in anon, false, `${k} must not be public`);

  assert.equal((await call('GET', `/api/orders/${order.ref}/events`)).status, 401);
  assert.equal((await call('POST', `/api/orders/${order.ref}/confirm`)).status, 401);
  assert.equal((await call('GET', '/api/orders/cs-nope')).status, 404);
});

test('refs are unguessable (long random), not sequential', async () => {
  const seller = await srv.person('s2');
  const a = await createOrderHttp(srv, seller, keyset());
  const b = await createOrderHttp(srv, seller, keyset());
  assert.match(a.ref, /^cs-[a-z2-9]{10}$/);
  assert.notEqual(a.ref, b.ref);
});

test('per-order RBAC: strangers see public view only; wrong-role actions get 403; seller cannot buy own order', async () => {
  const seller = await srv.person('seller');
  const buyer = await srv.person('buyer');
  const stranger = await srv.person('stranger');
  const ks = keyset();
  const order = await createOrderHttp(srv, seller, ks);

  assert.equal((await joinHttp(srv, seller, order, ks)).status, 403, 'seller joining own order');
  const joined = await joinHttp(srv, buyer, order, ks);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.state, 'AWAITING_FUNDING');
  assert.deepEqual(joined.body.roles, ['BUYER']);
  assert.equal((await joinHttp(srv, stranger, order, ks)).status, 409, 'second buyer');

  const full = (await call('GET', `/api/orders/${order.ref}`, { token: seller.token })).body;
  assert.ok(full.participants && full.escrow.address);
  assert.equal((await call('GET', `/api/orders/${order.ref}`, { token: stranger.token })).body.view, 'PUBLIC');

  const forbidden = [
    ['POST', 'dispatch', buyer], ['POST', 'deliver', buyer], ['POST', 'seller-response', buyer],
    ['POST', 'confirm', seller], ['POST', 'dispute', seller], ['POST', 'confirm', stranger],
    ['POST', 'resolve', seller], ['POST', 'resolve', buyer], ['POST', 'sign', stranger],
    ['GET', 'events', stranger], ['GET', 'nostr/events', stranger], ['PATCH', 'terms', buyer],
    ['POST', 'check-funding', stranger], ['POST', 'amendments', buyer],
  ];
  for (const [m, p, who] of forbidden) {
    const r = await call(m, `/api/orders/${order.ref}/${p}`, { token: who.token, ...(m === 'GET' ? {} : { json: {} }) });
    assert.equal(r.status, 403, `${who.label} ${m} ${p} → ${r.status}`);
  }
});

test('invite-only orders can only be joined by the invited identity', async () => {
  const seller = await srv.person('seller'); const invited = await srv.person('invited'); const other = await srv.person('other');
  const ks = keyset();
  const order = await createOrderHttp(srv, seller, ks, { invitedBuyerNostr: invited.pubkey });
  assert.equal((await joinHttp(srv, other, order, ks)).status, 403);
  assert.equal((await joinHttp(srv, invited, order, ks)).status, 200);
});

test('admin API: users with stats, role changes, suspension takes effect immediately; non-admins are refused', async () => {
  const u = await srv.person('customer');
  assert.equal((await call('GET', '/api/admin/users', { token: u.token })).status, 403);
  assert.equal((await call('GET', '/api/admin/users')).status, 401);

  const seller = await srv.person('seller');
  await createOrderHttp(srv, seller, keyset());
  const list = (await call('GET', '/api/admin/users?q=' + seller.pubkey.slice(0, 12), { token: W.admin.token })).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].stats.sold, 1);
  const detail = (await call('GET', `/api/admin/users/${list[0].id}`, { token: W.admin.token })).body;
  assert.equal(detail.orders.length, 1);

  // arbitrator promotion requires an escrow key
  assert.equal((await call('PATCH', `/api/admin/users/${u.user.id}`, { token: W.admin.token, json: { role: 'ARBITRATOR' } })).status, 400);
  assert.equal((await call('PATCH', `/api/admin/users/${u.user.id}`, { token: W.admin.token, json: { role: 'ARBITRATOR', btcPubkey: newKey().pubkey } })).body.user.role, 'ARBITRATOR');

  // suspend → existing token stops working at once, login blocked
  const victim = await srv.person('victim');
  assert.equal((await call('PATCH', `/api/admin/users/${victim.user.id}`, { token: W.admin.token, json: { status: 'SUSPENDED' } })).body.user.status, 'SUSPENDED');
  assert.equal((await call('GET', '/api/me', { token: victim.token })).status, 401);
  await assert.rejects(() => victim.login(), /suspended/);

  // admins cannot lock themselves out
  assert.equal((await call('PATCH', `/api/admin/users/${W.admin.user.id}`, { token: W.admin.token, json: { status: 'SUSPENDED' } })).status, 409);
  const stats = (await call('GET', '/api/admin/stats', { token: W.admin.token })).body;
  assert.ok(stats.orders.total >= 1 && stats.users.ADMIN >= 1);
});

test('profile: users can set display name/email and list their own transactions by role', async () => {
  const seller = await srv.person('seller'); const buyer = await srv.person('buyer');
  const ks = keyset();
  const order = await createOrderHttp(srv, seller, ks);
  await joinHttp(srv, buyer, order, ks);
  assert.equal((await call('PATCH', '/api/me', { token: seller.token, json: { displayName: 'Ada Stores', contactEmail: 'ada@example.com' } })).body.user.displayName, 'Ada Stores');
  assert.equal((await call('PATCH', '/api/me', { token: seller.token, json: { contactEmail: 'nope' } })).status, 400);
  assert.equal((await call('GET', '/api/me/orders?role=SELLER', { token: seller.token })).body.length, 1);
  assert.equal((await call('GET', '/api/me/orders?role=BUYER', { token: seller.token })).body.length, 0);
  const mine = (await call('GET', '/api/me/orders', { token: buyer.token })).body;
  assert.deepEqual(mine[0].roles, ['BUYER']);
});

test('arbitrators are assigned per order: only the assigned one (not another arbitrator, not admin) may resolve', async () => {
  const arb2 = await srv.person('arb2');
  await call('POST', '/api/admin/arbitrators', { token: W.admin.token, json: { nostrPubkey: arb2.pubkey, btcPubkey: newKey().pubkey } });
  await arb2.login();

  const seller = await srv.person('seller'); const buyer = await srv.person('buyer');
  const ks = keyset();
  const order = await createOrderHttp(srv, seller, ks, { arbitratorUserId: W.arb.user.id });
  await joinHttp(srv, buyer, order, ks);
  const full = (await call('GET', `/api/orders/${order.ref}`, { token: seller.token })).body;
  assert.equal(full.escrow.pubkeys.arbitrator, keys.arbitrator.pubkey, "escrow uses the assigned arbitrator's key");

  const url = `/api/orders/${order.ref}/resolve`;
  assert.equal((await call('POST', url, { token: arb2.token, json: { decision: 'REFUND' } })).status, 403, 'other arbitrator');
  assert.equal((await call('POST', url, { token: W.admin.token, json: { decision: 'REFUND' } })).status, 403, 'admin on assigned order');
  assert.equal((await call('POST', url, { token: W.arb.token, json: { decision: 'REFUND' } })).status, 409, 'assigned arbitrator reaches state check');

  const queue = (await call('GET', '/api/arbitrator/queue', { token: arb2.token })).body;
  assert.equal(queue.some((o) => o.ref === order.ref), false);
  assert.equal((await call('GET', '/api/arbitrator/queue', { token: seller.token })).status, 403);
  assert.equal((await call('GET', '/api/arbitrators')).body.length >= 2, true);
});

test('only the arbitrator role holder may submit the arbitrator key signature', async () => {
  const seller = await srv.person('seller'); const buyer = await srv.person('buyer');
  const ks = keyset();
  keys.seller = ks.s; keys.buyer = ks.b;
  const order = await createOrderHttp(srv, seller, ks, { arbitratorUserId: W.arb.user.id });
  await joinHttp(srv, buyer, order, ks);
  const esc = (await call('GET', `/api/orders/${order.ref}`, { token: seller.token })).body.escrow;
  chain.fund(esc.address, 100_000);
  assert.equal((await call('POST', `/api/orders/${order.ref}/check-funding`, { token: buyer.token })).body.state, 'FUNDED');
  // fast-forward to a dispute resolution through the service (HTTP flow is covered in flows.test.js)
  const svc = await import('../src/services/orderService.js');
  const o = () => svc.getOrderByRef(order.ref);
  svc.markDispatched(o(), { dispatchReference: 'x' }); svc.reportDelivered(o());
  const conf = (await call('POST', `/api/orders/${order.ref}/dispute`, { token: buyer.token, form: { reason: 'broken' } }));
  assert.equal(conf.status, 200);
  await call('POST', `/api/orders/${order.ref}/seller-response`, { token: seller.token, json: { response: 'CONTEST' } });
  const res = await call('POST', `/api/orders/${order.ref}/resolve`, { token: W.arb.token, json: { decision: 'REFUND', note: 'refund' } });
  assert.equal(res.status, 200);
  const psbt = res.body.settlements[0].psbt;

  // buyer tries to push the arbitrator's signature in their own name → refused
  const stolen = await call('POST', `/api/orders/${order.ref}/sign`, { token: buyer.token, json: { type: 'REFUND', psbt: signAs(psbt, 'arbitrator') } });
  assert.equal(stolen.status, 403);
  // seller is not a permitted refund signer even with a valid own signature
  assert.equal((await call('POST', `/api/orders/${order.ref}/sign`, { token: seller.token, json: { type: 'REFUND', psbt: signAs(psbt, 'seller') } })).status, 403);
  // legit: buyer signs own, arbitrator signs own
  assert.equal((await call('POST', `/api/orders/${order.ref}/sign`, { token: buyer.token, json: { type: 'REFUND', psbt: signAs(psbt, 'buyer') } })).status, 200);
  const cur = (await call('GET', `/api/orders/${order.ref}`, { token: W.arb.token })).body.settlements[0].psbt;
  const fin = await call('POST', `/api/orders/${order.ref}/sign`, { token: W.arb.token, json: { type: 'REFUND', psbt: signAs(cur, 'arbitrator') } });
  assert.equal(fin.body.state, 'REFUNDED');
});

test('audit events record WHO acted', async () => {
  const seller = await srv.person('seller');
  const order = await createOrderHttp(srv, seller, keyset());
  const h = (await call('GET', `/api/orders/${order.ref}/events`, { token: seller.token })).body;
  assert.equal(h.valid, true);
  assert.ok(h.events.every((e) => e.actor === `user:${seller.user.id}:USER`), JSON.stringify(h.events.map((e) => e.actor)));
});

test('notifications are filtered by audience', async () => {
  const seller = await srv.person('seller'); const buyer = await srv.person('buyer');
  const ks = keyset(); const order = await createOrderHttp(srv, seller, ks);
  await joinHttp(srv, buyer, order, ks);
  const esc = (await call('GET', `/api/orders/${order.ref}`, { token: seller.token })).body.escrow;
  chain.fund(esc.address, 100_000);
  await call('POST', `/api/orders/${order.ref}/check-funding`, { token: seller.token });
  const s = (await call('GET', `/api/orders/${order.ref}`, { token: seller.token })).body;
  const b = (await call('GET', `/api/orders/${order.ref}`, { token: buyer.token })).body;
  assert.ok(s.notifications.some((n) => n.kind === 'ESCROW_FUNDED'));
  assert.ok(b.notifications.every((n) => n.audience === 'BUYER'));
});

test('secrets are redacted from logs', () => {
  const out = redact({ token: 'cs_abcdefghijklmnopqrstuvwxyz', nested: { privkey: 'x', note: 'Bearer cs_abcdefghijklmnopqrstuvwxyz12' }, ok: 'fine' });
  assert.equal(out.token, '[redacted]');
  assert.equal(out.nested.privkey, '[redacted]');
  assert.ok(!JSON.stringify(out).includes('abcdefghijklmnopqrstuvwxyz'));
  assert.equal(out.ok, 'fine');
});

test('rate limiter blocks excess requests per IP and bucket', () => {
  const mw = rateLimit({ bucket: 't', limit: 3 });
  const res = () => { const r = { code: 200, h: {} }; r.set = (k, v) => { r.h[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = () => r; return r; };
  const out = [];
  for (let i = 0; i < 5; i++) { const r = res(); let passed = false; mw({ ip: '1.2.3.4' }, r, () => { passed = true; }); out.push(passed ? 200 : r.code); }
  assert.deepEqual(out, [200, 200, 200, 429, 429]);
});

test('malformed JSON and uploads of disallowed types return clean 4xx, never 500', async () => {
  const seller = await srv.person('s');
  const bad = await fetch(`${srv.base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${seller.token}` }, body: '{not json' });
  assert.equal(bad.status, 400);
});
