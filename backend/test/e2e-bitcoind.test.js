/**
 * END-TO-END against a REAL Bitcoin Core node (regtest) through the real HTTP API.
 * Proves what mocks can't: Core's consensus rules accept our escrow scripts, PSBT signatures,
 * multi-input spends, trimmed 3→2 signatures, and chain reorgs are handled for real.
 *
 * Skipped automatically if no bitcoind binary is found (set BITCOIND_BIN to point at one).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [process.env.BITCOIND_BIN, path.join(os.homedir(), '.local/opt/bitcoin-32.1/bin/bitcoind'), '/usr/local/bin/bitcoind', '/opt/homebrew/bin/bitcoind'].filter(Boolean);
const BITCOIND = CANDIDATES.find((p) => fs.existsSync(p));
const skip = BITCOIND ? false : 'bitcoind binary not found (set BITCOIND_BIN)';

const RPC_PORT = 30000 + Math.floor(Math.random() * 10000);
const RPC_USER = 'coseal'; const RPC_PASS = 'coseal-test-pass';
let node; let h; let srv; let W; let miner;
const datadir = fs.mkdtempSync(path.join(os.tmpdir(), 'coseal-bitcoind-'));

async function rpc(method, params = [], wallet) {
  const res = await fetch(`http://127.0.0.1:${RPC_PORT}${wallet ? `/wallet/${wallet}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 't', method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const btcStr = (sats) => (sats / 1e8).toFixed(8);
const mine = (n = 1) => rpc('generatetoaddress', [n, miner]);

before(async () => {
  if (skip) return;
  node = spawn(BITCOIND, ['-regtest', `-datadir=${datadir}`, `-rpcuser=${RPC_USER}`, `-rpcpassword=${RPC_PASS}`, `-rpcport=${RPC_PORT}`,
    '-listen=0', '-server=1', '-txindex=1', '-fallbackfee=0.0002', '-dnsseed=0', '-discover=0', '-printtoconsole=0'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await rpc('getblockcount'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  await rpc('createwallet', ['miner']);
  miner = await rpc('getnewaddress', [], 'miner');
  await rpc('generatetoaddress', [101, miner]);

  process.env.COSEAL_TEST_CHAIN = 'rpc';
  process.env.BITCOIN_CHAIN = 'rpc';
  process.env.BITCOIN_NETWORK = 'regtest';
  process.env.BITCOIN_RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
  process.env.BITCOIN_RPC_USER = RPC_USER;
  process.env.BITCOIN_RPC_PASSWORD = RPC_PASS;
  h = await import('./helpers.js');
  srv = await h.startServer();
  W = await h.world(srv);
});

after(async () => {
  if (srv) await srv.close();
  if (node) { try { await rpc('stop'); } catch { /* ignore */ } node.kill(); }
  fs.rmSync(datadir, { recursive: true, force: true });
});

const call = (m, u, o) => srv.api(m, u, o);
let seed = 5000;
const img = async () => ({ name: 'p.png', buf: await h.makePng(seed++), type: 'image/png' });

/** Seller+buyer, joined; funds the REAL escrow address on regtest. */
async function order({ amountSats = 100_000, parts = [amountSats], confirm = true } = {}) {
  const seller = await srv.person('seller'); const buyer = await srv.person('buyer');
  const ks = h.keyset(); h.keys.seller = ks.s; h.keys.buyer = ks.b;
  const created = await h.createOrderHttp(srv, seller, ks, { amountSats, arbitratorUserId: W.arb.user.id });
  const j = await h.joinHttp(srv, buyer, created, ks);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.match(j.body.escrow.address, /^bcrt1q/, 'real regtest bech32 address');
  const o = { seller, buyer, ref: created.ref, address: j.body.escrow.address, fundTxids: [] };
  for (const p of parts) o.fundTxids.push(await rpc('sendtoaddress', [o.address, btcStr(p)], 'miner'));
  if (confirm) {
    await mine(1);
    const chk = await call('POST', `/api/orders/${o.ref}/check-funding`, { token: buyer.token });
    assert.equal(chk.body.state, 'FUNDED', JSON.stringify(chk.body));
  }
  o.get = async (who = seller) => (await call('GET', `/api/orders/${o.ref}`, { token: who.token })).body;
  return o;
}

async function toReview(o) {
  const d = await call('POST', `/api/orders/${o.ref}/dispatch`, { token: o.seller.token, form: { dispatchReference: 'E2E-1' }, files: [await img()] });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await call('POST', `/api/orders/${o.ref}/deliver`, { token: o.seller.token, json: {} })).body.state, 'REVIEW_PENDING');
}

async function sign(o, who, type, as) {
  const cur = (await o.get(who)).settlements.find((s) => s.type === type);
  return call('POST', `/api/orders/${o.ref}/sign`, { token: who.token, json: { type, psbt: h.signAs(cur.psbt, as) } });
}

test('REAL NODE: unconfirmed deposit does not fund; confirmed deposit does; escrow verifies; Core sees the P2WSH 2-of-3', { skip }, async () => {
  const o = await order({ confirm: false });
  let chk = await call('POST', `/api/orders/${o.ref}/check-funding`, { token: o.buyer.token });
  assert.equal(chk.status, 202, 'in mempool only → not funded');
  assert.equal(chk.body.observed.confirmations, 0);
  await mine(1);
  chk = await call('POST', `/api/orders/${o.ref}/check-funding`, { token: o.buyer.token });
  assert.equal(chk.status, 200);
  assert.equal(chk.body.state, 'FUNDED');
  assert.equal((await call('GET', `/api/orders/${o.ref}/escrow/verify`)).body.valid, true);

  const desc = await rpc('getdescriptorinfo', [`addr(${o.address})`]);
  assert.ok(desc.descriptor.startsWith('addr('));
  const fundTx = await rpc('getrawtransaction', [o.fundTxids[0], true]);
  const paid = fundTx.vout.find((v) => v.scriptPubKey.address === o.address);
  assert.equal(Math.round(paid.value * 1e8), 100_000);
  assert.equal(paid.scriptPubKey.type, 'witness_v0_scripthash', 'Core sees a P2WSH output');
});

test('REAL NODE happy path: buyer+seller sign → Core accepts & confirms the release; funds land at the seller payout address', async () => {
  const o = await order({ amountSats: 150_000 });
  await toReview(o);
  const c = await call('POST', `/api/orders/${o.ref}/confirm`, { token: o.buyer.token, json: {} });
  assert.equal(c.body.state, 'AWAITING_SIGNATURES');
  const stl = c.body.settlements[0];
  const sellerAddr = stl.outputs[0].address;

  assert.equal((await sign(o, o.buyer, 'RELEASE', 'buyer')).body.state, 'AWAITING_SIGNATURES');
  const done = await sign(o, o.seller, 'RELEASE', 'seller');
  assert.equal(done.body.state, 'RELEASED', JSON.stringify(done.body));
  const txid = done.body.settlements[0].txid;

  // Core has it in the mempool (i.e. consensus + policy accepted our PSBT/witness)…
  const inPool = await rpc('getmempoolentry', [txid]);
  assert.ok(inPool.vsize > 0);
  const feeRate = (inPool.fees.base * 1e8) / inPool.vsize;
  assert.ok(feeRate >= 1, `fee rate ${feeRate.toFixed(2)} sat/vB must meet relay minimum`);
  console.log(`      release tx ${txid.slice(0, 12)}…  vsize=${inPool.vsize}  fee=${Math.round(inPool.fees.base * 1e8)} sats  (${feeRate.toFixed(2)} sat/vB; estimate ${stl.feeSats})`);

  // …and the money goes exactly where the agreement said.
  await mine(1);
  const raw = await rpc('getrawtransaction', [txid, true]);
  assert.equal(raw.confirmations, 1);
  assert.equal(raw.vout.length, 1);
  assert.equal(raw.vout[0].scriptPubKey.address, sellerAddr);
  assert.equal(Math.round(raw.vout[0].value * 1e8), stl.outputs[0].amountSats);
  assert.equal(raw.vin[0].txid, o.fundTxids[0]);

  const sweep = await (await import('../src/services/orderService.js')).runChainSweep();
  assert.ok(sweep.confirmed.includes(txid));
  assert.equal((await call('GET', `/api/orders/${o.ref}/events`, { token: o.seller.token })).body.events.some((e) => e.type === 'SETTLEMENT_CONFIRMED'), true);

  // replaying the signature cannot pay twice; the node confirms there is no second spend
  const replay = await call('POST', `/api/orders/${o.ref}/sign`, { token: o.seller.token, json: { type: 'RELEASE', psbt: h.signAs(stl.psbt, 'seller') } });
  assert.equal(replay.status, 409);
  assert.equal((await rpc('scantxoutset', ['start', [`addr(${o.address})`]])).total_amount, 0, 'escrow fully drained');
});

test('REAL NODE: arbitrated SPLIT 70/30 — three signatures collected, trimmed to two, accepted by Core', async () => {
  llmOk();
  const o = await order({ amountSats: 300_000 });
  await toReview(o);
  await call('POST', `/api/orders/${o.ref}/dispute`, { token: o.buyer.token, form: { reason: 'Not as described' }, files: [await img()] });
  await call('POST', `/api/orders/${o.ref}/seller-response`, { token: o.seller.token, json: { response: 'CONTEST' } });
  const r = await call('POST', `/api/orders/${o.ref}/resolve`, { token: W.arb.token, json: { decision: 'SPLIT', sellerShareBps: 7000, note: '70/30' } });
  assert.equal(r.body.state, 'AWAITING_SIGNATURES');
  const [sOut, bOut] = r.body.settlements[0].outputs;

  await sign(o, o.buyer, 'SPLIT', 'buyer');
  const two = await sign(o, o.seller, 'SPLIT', 'seller');
  assert.equal(two.body.state, 'AWAITING_SIGNATURES', 'buyer+seller alone cannot split');
  const fin = await sign(o, W.arb, 'SPLIT', 'arbitrator');
  assert.equal(fin.body.state, 'SPLIT', JSON.stringify(fin.body));

  await mine(1);
  const raw = await rpc('getrawtransaction', [fin.body.settlements[0].txid, true]);
  const byAddr = Object.fromEntries(raw.vout.map((v) => [v.scriptPubKey.address, Math.round(v.value * 1e8)]));
  assert.equal(byAddr[sOut.address], sOut.amountSats);
  assert.equal(byAddr[bOut.address], bOut.amountSats);
  assert.equal(raw.vin[0].txinwitness.length, 4, 'witness = [empty, sig, sig, script]: exactly two signatures');
});

test('REAL NODE: seller ACCEPT → refund signed by buyer+seller reaches the buyer payout address', async () => {
  const o = await order({ amountSats: 90_000 });
  await toReview(o);
  await call('POST', `/api/orders/${o.ref}/dispute`, { token: o.buyer.token, json: { reason: 'Broken' } });
  const acc = await call('POST', `/api/orders/${o.ref}/seller-response`, { token: o.seller.token, json: { response: 'ACCEPT' } });
  assert.equal(acc.body.settlements[0].type, 'REFUND');
  const buyerAddr = acc.body.settlements[0].outputs[0].address;
  await sign(o, o.buyer, 'REFUND', 'buyer');
  const fin = await sign(o, o.seller, 'REFUND', 'seller');
  assert.equal(fin.body.state, 'REFUNDED');
  await mine(1);
  const raw = await rpc('getrawtransaction', [fin.body.settlements[0].txid, true]);
  assert.equal(raw.vout[0].scriptPubKey.address, buyerAddr);
});

test('REAL NODE: escrow funded by two separate transactions → one 2-input settlement, nothing stranded', async () => {
  const o = await order({ amountSats: 100_000, parts: [60_000, 55_000] });
  await toReview(o);
  const c = await call('POST', `/api/orders/${o.ref}/confirm`, { token: o.buyer.token, json: {} });
  const stl = c.body.settlements[0];
  assert.equal(stl.outputs[0].amountSats + stl.feeSats, 115_000);
  await sign(o, o.buyer, 'RELEASE', 'buyer');
  const fin = await sign(o, o.seller, 'RELEASE', 'seller');
  assert.equal(fin.body.state, 'RELEASED', JSON.stringify(fin.body));
  await mine(1);
  const raw = await rpc('getrawtransaction', [fin.body.settlements[0].txid, true]);
  assert.equal(raw.vin.length, 2);
  assert.deepEqual(raw.vin.map((v) => v.txid).sort(), [...o.fundTxids].sort());
  assert.equal((await rpc('scantxoutset', ['start', [`addr(${o.address})`]])).total_amount, 0);
});

test('REAL NODE: a funding block that gets re-orged out is detected (FUNDING_LOST) and recovery is detected (FUNDING_RESTORED)', async () => {
  const svc = await import('../src/services/orderService.js');
  const o = await order({ amountSats: 80_000 });
  const tip = await rpc('getbestblockhash');
  await rpc('invalidateblock', [tip]); // the block holding the funding tx is disconnected
  const s1 = await svc.runChainSweep();
  assert.ok(s1.lost.includes(o.ref), 'reorg detected');
  assert.equal((await svc.runChainSweep()).lost.length, 0, 'flagged once');
  await rpc('reconsiderblock', [tip]);
  await svc.runChainSweep();
  const ev = (await call('GET', `/api/orders/${o.ref}/events`, { token: o.seller.token })).body;
  assert.equal(ev.valid, true);
  assert.deepEqual(ev.events.map((e) => e.type).filter((t) => t.startsWith('FUNDING_')), ['FUNDING_DETECTED', 'FUNDING_LOST', 'FUNDING_RESTORED']);
  assert.equal((await o.get()).state, 'FUNDED', 'a reorg never silently un-funds or moves money');
});

test('REAL NODE: a settlement cannot be built from a funding output that was re-orged away', async () => {
  const svc = await import('../src/services/orderService.js');
  const o = await order({ amountSats: 70_000 });
  await toReview(o);
  const tip = await rpc('getbestblockhash');
  await rpc('invalidateblock', [tip]);
  // the order block holding funding is gone: confirmed funds are below the agreed amount
  const c = await call('POST', `/api/orders/${o.ref}/confirm`, { token: o.buyer.token, json: {} });
  assert.equal(c.status, 409);
  assert.match(c.body.error, /no longer holds the agreed amount/);
  assert.equal((await o.get()).state, 'REVIEW_PENDING', 'state untouched, retry is possible');
  await rpc('reconsiderblock', [tip]);
  const ok = await call('POST', `/api/orders/${o.ref}/confirm`, { token: o.buyer.token, json: {} });
  assert.equal(ok.status, 200);
  assert.ok(svc);
});

test('REAL NODE: broadcasting the same finalized settlement twice is idempotent (no double spend, same txid)', async () => {
  const btc = await import('../src/lib/bitcoin.js');
  const o = await order({ amountSats: 60_000 });
  await toReview(o);
  const c = await call('POST', `/api/orders/${o.ref}/confirm`, { token: o.buyer.token, json: {} });
  const psbt1 = h.signAs(c.body.settlements[0].psbt, 'buyer');
  const both = h.signAs(psbt1, 'seller');
  const a = await btc.broadcastSettlement({ psbt: both });
  const b = await btc.broadcastSettlement({ psbt: both });
  assert.equal(a.txid, b.txid, 're-sending a mempool tx is harmless and yields the same txid');
  await mine(1);
  const again = await btc.broadcastSettlement({ psbt: both });
  assert.equal(again.alreadyKnown, true, 'still idempotent once confirmed');
});

test('REAL NODE: deposits arriving after settlement are flagged as orphans', async () => {
  const svc = await import('../src/services/orderService.js');
  const o = await order({ amountSats: 50_000 });
  await toReview(o);
  await call('POST', `/api/orders/${o.ref}/confirm`, { token: o.buyer.token, json: {} });
  await sign(o, o.buyer, 'RELEASE', 'buyer'); await sign(o, o.seller, 'RELEASE', 'seller');
  await mine(1);
  await svc.runChainSweep();
  const late = await rpc('sendtoaddress', [o.address, btcStr(7_000)], 'miner');
  await mine(1);
  const sweep = await svc.runChainSweep();
  assert.deepEqual(sweep.orphans, [late]);
});

function llmOk() { h.llm.mode = 'ok'; }
