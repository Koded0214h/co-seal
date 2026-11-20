#!/usr/bin/env node
/**
 * Narrated, full user-flow simulation of CoSeal against the REAL HTTP API (booted in-process
 * with a throwaway database). Every actor is a separate Nostr identity with its own session.
 *
 *   node scripts/simulate-flow.mjs                     # simulation mode (no Bitcoin node needed)
 *   node scripts/simulate-flow.mjs --mode regtest      # real escrow/PSBTs/broadcast on a local bitcoind
 *   node scripts/simulate-flow.mjs --mode signet       # PUBLIC Signet via Esplora; you fund the escrow from a faucet
 *   node scripts/simulate-flow.mjs --scenario split    # happy | accept | split | timeout | all (default)
 *
 * regtest mode needs a node:  npm run regtest -- start   (RPC http://127.0.0.1:18443 coseal/coseal)
 * AI runs for real if OPENAI_API_KEY (or ANTHROPIC_API_KEY + LLM_PROVIDER=anthropic) is set;
 * otherwise it reports "unavailable" and the flow proceeds — exactly as in production.
 * Exit code is non-zero if any step fails.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const MODE = opt('mode', 'sim');
const SCENARIO = opt('scenario', MODE === 'signet' ? 'happy' : 'all'); // faucet coins are scarce: signet defaults to one scenario
const SIGNET_SATS = Number(opt('sats', 4000));
if (!['sim', 'regtest', 'signet'].includes(MODE)) { console.error('--mode must be sim | regtest | signet'); process.exit(2); }
const LIVE = MODE !== 'sim';

/* ── environment (must precede importing src/) ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coseal-sim-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DEMO_MODE = 'true';
process.env.REVIEW_WINDOW_SECONDS = '1';
const RPC = { url: process.env.BITCOIN_RPC_URL || 'http://127.0.0.1:18443', user: process.env.BITCOIN_RPC_USER || 'coseal', pass: process.env.BITCOIN_RPC_PASSWORD || 'coseal' };

const { generateSecretKey, getPublicKey, finalizeEvent } = await import('nostr-tools/pure');
const { Jimp } = await import('jimp');
const bitcoin = (await import('bitcoinjs-lib')).default;
const ecc = await import('tiny-secp256k1');
const { ECPairFactory } = await import('ecpair');
const ECPair = ECPairFactory(ecc);
const NET = MODE === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet; // signet shares testnet address params
const newKey = () => { const kp = ECPair.makeRandom({ network: NET }); return { kp, pubkey: Buffer.from(kp.publicKey).toString('hex') }; };
const payout = () => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(newKey().kp.publicKey), network: NET }).address;

const adminSk = generateSecretKey();
const arbKey = newKey();
if (MODE === 'regtest') {
  process.env.BITCOIN_LIVE = 'true'; process.env.BITCOIN_NETWORK = 'regtest'; process.env.BITCOIN_CHAIN = 'rpc';
  process.env.BITCOIN_RPC_URL = RPC.url; process.env.BITCOIN_RPC_USER = RPC.user; process.env.BITCOIN_RPC_PASSWORD = RPC.pass;
  process.env.ARBITRATOR_PUBKEY = arbKey.pubkey;
}
if (MODE === 'signet') {
  process.env.BITCOIN_LIVE = 'true'; process.env.BITCOIN_NETWORK = 'signet'; process.env.BITCOIN_CHAIN = process.env.BITCOIN_CHAIN || 'esplora';
  process.env.ARBITRATOR_PUBKEY = arbKey.pubkey; // fresh throwaway keys: this script holds every party's key
}
process.env.ADMIN_PUBKEYS = getPublicKey(adminSk);

/* ── tiny presentation helpers ── */
const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s); const dim = (s) => c(2, s); const green = (s) => c(32, s); const red = (s) => c(31, s); const cyan = (s) => c(36, s); const yellow = (s) => c(33, s);
let steps = 0; let failed = 0;
const say = (actor, text) => console.log(`  ${cyan(actor.padEnd(10))} ${text}`);
const note = (text) => console.log(`  ${dim('·'.padEnd(10))} ${dim(text)}`);
const scenarioTitle = (t) => console.log(`\n${bold(c(35, `━━ ${t} ━━`))}`);
function check(ok, label, extra = '') {
  steps++;
  if (ok) console.log(`  ${green('✔')} ${label}${extra ? dim('  ' + extra) : ''}`);
  else { failed++; console.log(`  ${red('✘')} ${label}${extra ? '  ' + red(extra) : ''}`); }
  return ok;
}

/* ── bitcoin node helpers (regtest only) ── */
async function rpc(method, params = [], wallet) {
  const res = await fetch(`${RPC.url}${wallet ? `/wallet/${wallet}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${RPC.user}:${RPC.pass}`).toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 's', method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
let minerAddr;
if (MODE === 'regtest') {
  try { await rpc('getblockcount'); } catch { console.error(red(`No bitcoind at ${RPC.url}. Start one: npm run regtest -- start`)); process.exit(2); }
  try { await rpc('createwallet', ['miner']); } catch { try { await rpc('loadwallet', ['miner']); } catch { /* already loaded */ } }
  minerAddr = await rpc('getnewaddress', [], 'miner');
  if ((await rpc('getblockcount')) < 101) await rpc('generatetoaddress', [101, minerAddr]);
}
const mine = (n = 1) => rpc('generatetoaddress', [n, minerAddr]);

/* ── boot the real app on an ephemeral port ── */
const { createApp } = await import('../src/app.js');
const svc = await import('../src/services/orderService.js');
const server = await new Promise((r) => { const s = createApp().listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

async function api(method, url, { token, json, form, files } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let body;
  if (files || form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form || {})) fd.append(k, v);
    for (const f of files || []) fd.append('proof', new Blob([f.buf], { type: f.type }), f.name);
    body = fd;
  } else if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(BASE + url, { method, headers, body });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : null };
}

let imgSeed = 1;
async function photo(label) {
  let n = imgSeed++ * 7919;
  const rnd = () => { n = (n * 1103515245 + 12345) & 0x7fffffff; return n / 0x7fffffff; };
  const cells = Array.from({ length: 64 }, () => Math.floor(rnd() * 256));
  const img = new Jimp({ width: 96, height: 96, color: 0x000000ff });
  img.scan(0, 0, 96, 96, function (x, y, i) { const v = cells[Math.floor(y / 12) * 8 + Math.floor(x / 12)]; this.bitmap.data[i] = v; this.bitmap.data[i + 1] = v; this.bitmap.data[i + 2] = v; this.bitmap.data[i + 3] = 255; });
  return { name: `${label}.png`, buf: await img.getBuffer('image/png'), type: 'image/png' };
}

/** Log an existing identity in with a signed challenge (what NIP-07 `signEvent` does in a browser). */
async function login(me) {
  const ch = (await api('POST', '/api/auth/challenge')).body;
  const event = finalizeEvent({ kind: ch.kind, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', ch.nonce]], content: '' }, me.sk);
  const r = await api('POST', '/api/auth/login', { json: { event } });
  me.token = r.body.token; me.user = r.body.user;
  return me;
}

/** A person: a fresh Nostr identity with its own session. */
async function person(name) {
  const sk = name === 'Admin' ? adminSk : generateSecretKey();
  const me = await login({ name, sk, pubkey: getPublicKey(sk) });
  say(name, `logged in with Nostr key ${me.pubkey.slice(0, 12)}…  (${me.user.role})`);
  return me;
}

/** Sign the pending settlement as `who` with the escrow key for `role` (a wallet would do this). */
async function signSettlement(order, who, type, role, keyOf) {
  const cur = (await api('GET', `/api/orders/${order.ref}`, { token: who.token })).body;
  const stl = cur.settlements.find((s) => s.type === type);
  let body;
  if (LIVE) {
    const psbt = bitcoin.Psbt.fromBase64(stl.psbt, { network: NET });
    for (let i = 0; i < psbt.data.inputs.length; i++) psbt.signInput(i, keyOf[role].kp);
    body = { type, psbt: psbt.toBase64() };
  } else body = { type, signerPubkey: who.pubkey, signature: `sim-signature-by-${role.toLowerCase()}` };
  return api('POST', `/api/orders/${order.ref}/sign`, { token: who.token, json: body });
}

const sats = (n) => `${n.toLocaleString()} sats`;
const stateOf = async (order, who) => (await api('GET', `/api/orders/${order.ref}`, { token: who.token })).body.state;

/* ── world: admin + arbitrator ── */
console.log(bold(`\nCoSeal full user-flow simulation  ·  mode: ${{ sim: 'SIMULATION (fake escrow/txids)', regtest: 'REAL regtest bitcoind (real escrow, PSBTs, broadcast)', signet: 'PUBLIC SIGNET (real escrow, you fund it from a faucet)' }[MODE]}`));
console.log(dim(`API ${BASE}  ·  throwaway database ${tmp}\n`));
scenarioTitle('Setup: platform admin registers an arbitrator');
const admin = await person('Admin');
const arb = await person('Arbitrator');
const reg = await api('POST', '/api/admin/arbitrators', { token: admin.token, json: { nostrPubkey: arb.pubkey, btcPubkey: arbKey.pubkey, displayName: 'Ngozi (arbitrator)' } });
check(reg.status === 201, 'admin registered the arbitrator and their escrow key');
await login(arb); // log in again so the session carries the new role
check(arb.user.role === 'ARBITRATOR', 'arbitrator logged in again and now has the ARBITRATOR role');

/** Seller creates, buyer joins, buyer funds, escrow confirmed → FUNDED. */
async function openOrder({ item, amountSats }) {
  const seller = await person('Seller'); const buyer = await person('Buyer');
  const keyOf = { SELLER: newKey(), BUYER: newKey(), ARBITRATOR: arbKey };
  const created = await api('POST', '/api/orders', { token: seller.token, json: {
    itemDescription: item, amountSats, sellerPubkey: keyOf.SELLER.pubkey, sellerPayoutAddress: LIVE ? payout() : undefined,
    deliveryConditions: 'Courier delivery within 3 days', disputeTerms: 'Photo evidence required', arbitratorUserId: arb.user.id,
  } });
  check(created.status === 201, `seller created "${item}" for ${sats(amountSats)}`, `link ${created.body.transactionLink}`);
  const order = created.body;

  const stranger = await api('GET', `/api/orders/${order.ref}`);
  check(stranger.body.view === 'PUBLIC' && !stranger.body.evidence, 'anyone with the link sees only the public agreement', `openForBuyer=${stranger.body.openForBuyer}`);

  const joined = await api('POST', `/api/orders/${order.ref}/join`, { token: buyer.token, json: { buyerPubkey: keyOf.BUYER.pubkey, buyerPayoutAddress: LIVE ? payout() : undefined, agreementHash: order.agreementHash } });
  check(joined.status === 200, 'buyer opened the link, accepted the agreement hash and joined', `escrow ${joined.body.escrow?.address.slice(0, 22)}…`);
  const v = await api('GET', `/api/orders/${order.ref}/escrow/verify`);
  check(!LIVE ? v.body.simulated : v.body.valid, !LIVE ? 'escrow is simulated (switch to --mode regtest for the real one)' : 'anyone can recompute the 2-of-3 escrow from the three keys');

  if (MODE === 'regtest') {
    const txid = await rpc('sendtoaddress', [joined.body.escrow.address, (amountSats / 1e8).toFixed(8)], 'miner');
    say('Buyer', `sent ${sats(amountSats)} on-chain  tx ${txid.slice(0, 16)}…`);
    let chk = await api('POST', `/api/orders/${order.ref}/check-funding`, { token: buyer.token });
    check(chk.status === 202, 'unconfirmed payment does NOT fund the order (needs confirmations)');
    await mine(1);
    chk = await api('POST', `/api/orders/${order.ref}/check-funding`, { token: buyer.token });
    check(chk.body.state === 'FUNDED', 'after a block, funding verified from the chain → FUNDED');
  } else if (MODE === 'signet') {
    console.log(`\n  ${yellow('▶ ACTION NEEDED')}  send ${bold(sats(amountSats))} (or more) of Signet BTC to:\n\n      ${bold(joined.body.escrow.address)}\n`);
    console.log(dim('    Faucets: https://signet25.bublina.eu.org/ · https://alt.signetfaucet.com/ — then wait for 1 confirmation.'));
    console.log(dim('    Polling the chain every 15s (Ctrl-C to abort)…\n'));
    let funded = false;
    for (let i = 0; i < 120 && !funded; i++) {
      const chk = await api('POST', `/api/orders/${order.ref}/check-funding`, { token: buyer.token });
      funded = chk.body.state === 'FUNDED';
      if (!funded) { process.stdout.write(dim(`    …${chk.body.observed ? `seen ${chk.body.observed.amountSats} sats, ${chk.body.observed.confirmations} conf` : 'nothing yet'}\r`)); await new Promise((r) => setTimeout(r, 15_000)); }
    }
    check(funded, 'funding verified from the public Signet chain → FUNDED');
  } else {
    const f = await api('POST', `/api/orders/${order.ref}/simulate-funding`, { token: buyer.token });
    check(f.body.state === 'FUNDED', 'funding simulated → FUNDED');
  }
  return { order, seller, buyer, keyOf };
}

async function dispatchAndDeliver({ order, seller, buyer }) {
  const forbidden = await api('POST', `/api/orders/${order.ref}/dispatch`, { token: buyer.token, files: [await photo('x')] });
  check(forbidden.status === 403, 'buyer is NOT allowed to dispatch (role check)');
  const d = await api('POST', `/api/orders/${order.ref}/dispatch`, { token: seller.token, form: { dispatchReference: 'DHL-0042' }, files: [await photo('dispatch')] });
  const ai = d.body.assessment?.prd;
  check(d.status === 200 && d.body.state === 'DISPATCHED', 'seller dispatched with photo proof', ai ? `AI: ${ai.available ? ai.assessment : 'unavailable (' + ai.reason + ')'} · money_movement_authorized=${ai.money_movement_authorized}` : '');
  const dl = await api('POST', `/api/orders/${order.ref}/deliver`, { token: seller.token, json: {} });
  check(dl.body.state === 'REVIEW_PENDING', 'seller reported delivery → buyer review window open');
}

async function finishSettlement(ctx, type, signers) {
  const { order } = ctx;
  for (const [who, role] of signers) {
    const r = await signSettlement(order, who, type, role, ctx.keyOf);
    say(who.name, `signed the ${type.toLowerCase()} as ${role}  → ${r.body.state}`);
  }
  const final = (await api('GET', `/api/orders/${order.ref}`, { token: ctx.seller.token })).body;
  const stl = final.settlements.find((s) => s.type === type);
  check(['RELEASED', 'REFUNDED', 'SPLIT'].includes(final.state), `order settled: ${final.state}`, `txid ${String(stl.txid).slice(0, 18)}…`);
  const ev = (await api('GET', `/api/orders/${order.ref}/events`, { token: ctx.seller.token })).body;
  check(ev.valid, `audit trail is intact: ${ev.events.length} hash-chained events`, `head ${ev.headHash.slice(0, 12)}…`);
  if (MODE === 'signet') {
    check(true, 'settlement broadcast to public Signet', `https://mempool.space/signet/tx/${stl.txid}`);
  }
  if (MODE === 'regtest') {
    await mine(1);
    const raw = await rpc('getrawtransaction', [stl.txid, true]);
    const outs = raw.vout.map((o) => `${Math.round(o.value * 1e8)} → ${o.scriptPubKey.address.slice(0, 14)}…`).join(' | ');
    check(raw.confirmations >= 1, 'Bitcoin Core confirmed the settlement transaction', outs);
  }
  return { final, stl };
}

/* ── scenarios ── */
const want = (n) => SCENARIO === 'all' || SCENARIO === n;

if (want('happy')) {
  scenarioTitle('Scenario 1 — Happy path: buyer confirms, funds released to seller');
  const ctx = await openOrder({ item: 'Leather boots (size 42)', amountSats: MODE === 'signet' ? SIGNET_SATS : 120_000 });
  await dispatchAndDeliver(ctx);
  const wrong = await api('POST', `/api/orders/${ctx.order.ref}/confirm`, { token: ctx.seller.token, json: {} });
  check(wrong.status === 403, 'seller cannot confirm on the buyer\'s behalf (role check)');
  const c1 = await api('POST', `/api/orders/${ctx.order.ref}/confirm`, { token: ctx.buyer.token, json: {} });
  check(c1.body.state === 'AWAITING_SIGNATURES', 'buyer confirmed receipt → release proposed', `pays seller ${sats(c1.body.settlements?.[0]?.outputs?.[0]?.amountSats ?? 120_000)}`);
  const arbTry = await signSettlement(ctx.order, arb, 'RELEASE', 'ARBITRATOR', ctx.keyOf);
  check(arbTry.status === 403, 'arbitrator cannot sign an undisputed release');
  await finishSettlement(ctx, 'RELEASE', [[ctx.buyer, 'BUYER'], [ctx.seller, 'SELLER']]);
  // An attacker (or a retry) replays the seller's signature on the ORIGINAL proposal.
  let replayBody = { type: 'RELEASE', signerPubkey: ctx.seller.pubkey, signature: 'sim-signature-by-seller' };
  if (LIVE) {
    const p = bitcoin.Psbt.fromBase64(c1.body.settlements[0].psbt, { network: NET });
    for (let i = 0; i < p.data.inputs.length; i++) p.signInput(i, ctx.keyOf.SELLER.kp);
    replayBody = { type: 'RELEASE', psbt: p.toBase64() };
  }
  const replay = await api('POST', `/api/orders/${ctx.order.ref}/sign`, { token: ctx.seller.token, json: replayBody });
  check(replay.status === 409, 'replaying a signature cannot pay twice');
}

if (want('accept')) {
  scenarioTitle('Scenario 2 — Dispute, seller concedes: refund to buyer');
  const ctx = await openOrder({ item: 'Wireless speaker', amountSats: MODE === 'signet' ? SIGNET_SATS : 80_000 });
  await dispatchAndDeliver(ctx);
  const d = await api('POST', `/api/orders/${ctx.order.ref}/dispute`, { token: ctx.buyer.token, form: { category: 'DAMAGED', reason: 'Arrived with a cracked casing' }, files: [await photo('damage')] });
  check(d.body.order.state === 'DISPUTED', 'buyer disputed → settlement frozen immediately (before any AI)', d.body.assessment ? `AI: ${d.body.assessment.prd.available ? d.body.assessment.prd.assessment : 'unavailable'}` : '');
  const accept = await api('POST', `/api/orders/${ctx.order.ref}/seller-response`, { token: ctx.seller.token, json: { response: 'ACCEPT' } });
  check(accept.body.state === 'AWAITING_SIGNATURES' && accept.body.settlements[0].type === 'REFUND', 'seller accepted the claim → refund proposed');
  const bad = await signSettlement(ctx.order, arb, 'REFUND', 'ARBITRATOR', ctx.keyOf);
  check(bad.status === 403, 'arbitrator is not part of a conceded refund');
  await finishSettlement(ctx, 'REFUND', [[ctx.buyer, 'BUYER'], [ctx.seller, 'SELLER']]);
}

if (want('split')) {
  scenarioTitle('Scenario 3 — Contested dispute: arbitrator decides a 70/30 split');
  const ctx = await openOrder({ item: 'Phone (refurbished)', amountSats: MODE === 'signet' ? Math.max(SIGNET_SATS, 6000) : 250_000 });
  await dispatchAndDeliver(ctx);
  await api('POST', `/api/orders/${ctx.order.ref}/dispute`, { token: ctx.buyer.token, form: { category: 'NOT_AS_DESCRIBED', reason: 'Battery health far below what was advertised' }, files: [await photo('buyer-claim')] });
  const contest = await api('POST', `/api/orders/${ctx.order.ref}/seller-response`, { token: ctx.seller.token, json: { response: 'CONTEST' } });
  check(contest.body.state === 'UNDER_REVIEW', 'seller contested → escalated to arbitration');
  const q = await api('GET', '/api/arbitrator/queue', { token: arb.token });
  check(q.body.some((o) => o.ref === ctx.order.ref), 'case appears in the assigned arbitrator\'s queue');
  const other = await person('Outsider');
  check((await api('POST', `/api/orders/${ctx.order.ref}/resolve`, { token: other.token, json: { decision: 'REFUND' } })).status === 403, 'a random user cannot resolve the case');
  check((await api('POST', `/api/orders/${ctx.order.ref}/resolve`, { token: ctx.seller.token, json: { decision: 'RELEASE' } })).status === 403, 'the seller cannot resolve their own case');
  const res = await api('POST', `/api/orders/${ctx.order.ref}/resolve`, { token: arb.token, json: { decision: 'SPLIT', sellerShareBps: 7000, note: 'Battery wear partly disclosed; 70/30' } });
  check(res.body.state === 'AWAITING_SIGNATURES', 'arbitrator proposed a 70/30 split', (res.body.settlements[0].outputs || []).map((o) => sats(o.amountSats)).join(' / '));
  const r1 = await signSettlement(ctx.order, ctx.buyer, 'SPLIT', 'BUYER', ctx.keyOf); say('Buyer', `signed split → ${r1.body.state}`);
  const r2 = await signSettlement(ctx.order, ctx.seller, 'SPLIT', 'SELLER', ctx.keyOf); say('Seller', `signed split → ${r2.body.state}`);
  check(r2.body.state === 'AWAITING_SIGNATURES', 'buyer + seller alone cannot execute a split — arbitrator signature required');
  await finishSettlement(ctx, 'SPLIT', [[arb, 'ARBITRATOR']]);
}

if (want('timeout')) {
  scenarioTitle('Scenario 4 — Buyer goes silent: review window expires, escalates (never auto-releases)');
  const ctx = await openOrder({ item: 'Desk lamp', amountSats: MODE === 'signet' ? SIGNET_SATS : 40_000 });
  await dispatchAndDeliver(ctx);
  note('waiting for the (demo, 1-second) review window to lapse…');
  await new Promise((r) => setTimeout(r, 1300));
  const escalated = await svc.runReviewWindowSweep();
  check(escalated.includes(ctx.order.ref), 'review window expired → escalated to arbitration');
  const cur = (await api('GET', `/api/orders/${ctx.order.ref}`, { token: ctx.seller.token })).body;
  check(cur.state === 'UNDER_REVIEW' && cur.settlements.length === 0, 'no settlement was created by the timer — funds stay locked until humans sign');
  const res = await api('POST', `/api/orders/${ctx.order.ref}/resolve`, { token: arb.token, json: { decision: 'RELEASE', note: 'Delivery confirmed by courier; buyer unresponsive' } });
  check(res.body.state === 'AWAITING_SIGNATURES', 'arbitrator released in the seller\'s favour');
  await finishSettlement(ctx, 'RELEASE', [[ctx.seller, 'SELLER'], [arb, 'ARBITRATOR']]);
}

/* ── customer tracking view (what the admin sees) ── */
scenarioTitle('Admin view: customers and platform activity');
const stats = (await api('GET', '/api/admin/stats', { token: admin.token })).body;
const users = (await api('GET', '/api/admin/users', { token: admin.token })).body;
console.log(`  orders: ${stats.orders.total}  ${JSON.stringify(stats.orders.byState)}   settled volume: ${sats(stats.settledVolumeSats)}`);
for (const u of users.filter((x) => x.stats.sold || x.stats.bought || x.stats.arbitrated)) {
  console.log(`  ${dim('·')} ${u.pubkey.slice(0, 10)}…  ${u.role.padEnd(10)} sold ${u.stats.sold} · bought ${u.stats.bought} · arbitrated ${u.stats.arbitrated}`);
}
check(users.length >= 4, `admin can see and track ${users.length} users`);

console.log(`\n${failed === 0 ? green(bold(`ALL ${steps} CHECKS PASSED`)) : red(bold(`${failed} OF ${steps} CHECKS FAILED`))}\n`);
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
