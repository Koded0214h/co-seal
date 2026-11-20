// Shared test setup. Must be imported BEFORE any src/ module so config reads these env vars.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import bitcoin from 'bitcoinjs-lib';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { Jimp } from 'jimp';

export const ECPair = ECPairFactory(ecc);
export const REGTEST = process.env.COSEAL_TEST_CHAIN === 'rpc';
export const NET = REGTEST ? bitcoin.networks.regtest : bitcoin.networks.testnet;

export function newKey() {
  const kp = ECPair.makeRandom({ network: NET });
  return { kp, pubkey: Buffer.from(kp.publicKey).toString('hex') };
}

export const keys = { buyer: newKey(), seller: newKey(), arbitrator: newKey() };

process.env.BITCOIN_LIVE = 'true';
process.env.BITCOIN_NETWORK ??= REGTEST ? 'regtest' : 'signet';
process.env.BITCOIN_MIN_CONFIRMATIONS = '1';
process.env.ARBITRATOR_PUBKEY = keys.arbitrator.pubkey;
export const adminSk = generateSecretKey();
process.env.ADMIN_PUBKEYS = getPublicKey(adminSk); // bootstrap admin
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '100000';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `coseal-test-${randomBytes(4).toString('hex')}-`));
process.env.UPLOAD_DIR = path.join(process.env.DATA_DIR, 'uploads'); // never touch the real uploads folder

/* ── mock LLM server speaking BOTH OpenAI Chat Completions and Anthropic Messages ── */
export const llm = { mode: 'ok', calls: 0, requests: [] };

/** Prompt text / system text of a recorded request, whichever provider shape it has. */
export function llmPrompt(req) {
  const last = req.messages?.at(-1)?.content;
  const blocks = Array.isArray(last) ? last : [{ type: 'text', text: last }];
  return blocks.find((b) => b.type === 'text')?.text || '';
}
export function llmSystem(req) {
  if (typeof req.system === 'string') return req.system; // anthropic
  const m = req.messages?.find((x) => x.role === 'system');   // openai
  return typeof m?.content === 'string' ? m.content : '';
}

function modelAnswer(prompt) {
  if (llm.mode === 'malformed') return 'sorry I cannot do JSON <<<';
  if (prompt.includes('Two photos')) {
    const mismatch = llm.mode === 'mismatch';
    return JSON.stringify({
      buyerProof: { genuine: true, matchesOrder: !mismatch, problemVisible: mismatch, reusedOrStockImage: false, tampering: false, confidence: 0.85 },
      comparison: { dispatchVsDelivered: mismatch ? 'MISMATCH' : 'MATCH', confidence: 0.8, recommendation: mismatch ? 'REFUND' : 'RELEASE', notes: mismatch ? 'Different item.' : 'Same item.' },
    });
  }
  if (prompt.includes('proof of dispatch')) {
    const bad = llm.mode === 'flag';
    return JSON.stringify({ genuine: !bad, matchesOrder: !bad, reusedOrStockImage: bad, tampering: false, confidence: 0.9, notes: bad ? 'Looks like a stock photo.' : 'Looks fine.' });
  }
  return JSON.stringify({ genuine: true, matchesOrder: true, problemVisible: true, reusedOrStockImage: false, tampering: false, confidence: 0.7, notes: 'ok' });
}

const llmServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llm.calls++;
    const send = (status, obj) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    llm.requests.push({ ...parsed, _url: req.url, _auth: req.headers.authorization || req.headers['x-api-key'] });
    const openai = req.url === '/v1/chat/completions';
    const anthropic = req.url === '/v1/messages';
    if (!openai && !anthropic) return send(404, { error: { message: 'no such route' } });

    const fail = (status, type, message) => send(status, openai ? { error: { message, type, code: type } } : { type: 'error', error: { type, message } });
    if (llm.mode === 'ratelimit') return fail(429, 'rate_limit_error', 'Rate limit reached');
    if (llm.mode === 'down') return fail(openai ? 503 : 529, 'server_error', 'Service unavailable');
    if (llm.mode === 'autherr') return fail(401, 'authentication_error', 'invalid api key');
    if (llm.mode === 'slow') return; // never answers -> client timeout
    if (llm.mode === 'reject-params' && openai && (parsed.reasoning_effort || parsed.response_format)) {
      return fail(400, 'invalid_request_error', "Unsupported parameter: 'reasoning_effort' is not supported with this model.");
    }
    const out = modelAnswer(llmPrompt(parsed));
    if (openai) {
      if (llm.mode === 'refusal') return send(200, { id: 'c', object: 'chat.completion', created: 1, model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }], usage: {} });
      return send(200, { id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    }
    if (llm.mode === 'refusal') return send(200, { id: 'msg_x', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: 'refusal', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } });
    send(200, { id: 'msg_test', type: 'message', role: 'assistant', model: parsed.model, content: [{ type: 'text', text: out }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } });
  });
});
export const llmUrl = (port) => `http://127.0.0.1:${port}`;

// NOTE: env vars are set synchronously, before the first await — sibling modules (config.js)
// can evaluate while this module is suspended on top-level await.
const llmPort = 41000 + Math.floor(Math.random() * 20000);
process.env.LLM_PROVIDER ??= 'openai';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${llmPort}/v1`;
process.env.OPENAI_API_KEY = 'test-key';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${llmPort}`;
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.LLM_TIMEOUT_MS = '1500';
await new Promise((r) => llmServer.listen(llmPort, '127.0.0.1', r));
llmServer.unref();

const btc = await import('../src/lib/bitcoin.js');
const { MemoryChain } = await import('../src/lib/chain.js');
export const chain = REGTEST ? null : new MemoryChain();
if (chain) btc.setChain(chain);

export function payoutAddress() {
  const { kp } = newKey();
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: NET }).address;
}

/** Sign a PSBT (base64) as `who` ('buyer'|'seller'|'arbitrator' or a key object), as a wallet would. */
export function signAs(psbtBase64, who) {
  const kp = typeof who === 'string' ? keys[who].kp : who.kp;
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: NET });
  for (let i = 0; i < psbt.data.inputs.length; i++) psbt.signInput(i, kp);
  return psbt.toBase64();
}

/* ── images ── */
/** Deterministic PRNG so the same seed always yields the same image. */
function prng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A real 64×64 PNG of an 8×8 random-brightness grid. Same seed → identical image; different seeds → different perceptual hash. */
export async function makePng(seed = 0) {
  const rnd = prng(seed + 1);
  const cells = Array.from({ length: 64 }, () => Math.floor(rnd() * 256));
  const img = new Jimp({ width: 64, height: 64, color: 0x000000ff });
  img.scan(0, 0, 64, 64, function (x, y, idx) { const v = cells[Math.floor(y / 8) * 8 + Math.floor(x / 8)]; this.bitmap.data[idx] = v; this.bitmap.data[idx + 1] = v; this.bitmap.data[idx + 2] = v; this.bitmap.data[idx + 3] = 255; });
  return img.getBuffer('image/png');
}
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

/* ── HTTP harness ── */
export async function startServer() {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** api('POST', '/api/orders', { token, json, files:[{name,buf,type}], form:{...} }) -> { status, body } */
  async function api(method, url, { token, json, form, files } = {}) {
    const headers = {};
    let body;
    if (token) headers.authorization = `Bearer ${token}`;
    if (files || form) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form || {})) fd.append(k, v);
      for (const f of files || []) fd.append('proof', new Blob([f.buf], { type: f.type || 'image/png' }), f.name || 'f.png');
      body = fd;
    } else if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + url, { method, headers, body });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }

  /** A person: Nostr identity + session. */
  async function person(label = 'user', sk = generateSecretKey()) {
    const pubkey = getPublicKey(sk);
    const me = { label, sk, pubkey, token: null, user: null };
    me.login = async () => {
      const ch = (await api('POST', '/api/auth/challenge')).body;
      const event = finalizeEvent({ kind: ch.kind, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', ch.nonce]], content: '' }, sk);
      const r = await api('POST', '/api/auth/login', { json: { event } });
      if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
      me.token = r.body.token; me.user = r.body.user;
      return r.body;
    };
    await me.login();
    return me;
  }
  return { base, api, person, close: () => new Promise((r) => server.close(r)) };
}

/* ── scenario builders ── */
export const keyset = () => ({ b: newKey(), s: newKey() });

/** Admin + an arbitrator registered with the configured arbitrator key. */
export async function world(srv) {
  const admin = await srv.person('admin', adminSk);
  const arb = await srv.person('arbitrator');
  const r = await srv.api('POST', '/api/admin/arbitrators', { token: admin.token, json: { nostrPubkey: arb.pubkey, btcPubkey: keys.arbitrator.pubkey, displayName: 'Arb One' } });
  if (r.status !== 201) throw new Error(`register arbitrator: ${JSON.stringify(r.body)}`);
  await arb.login(); // refresh role in session user
  return { admin, arb };
}

export async function createOrderHttp(srv, seller, ks, extra = {}) {
  const r = await srv.api('POST', '/api/orders', {
    token: seller.token,
    json: {
      itemDescription: 'Leather boots', amountSats: 100_000, sellerPubkey: ks.s.pubkey, sellerPayoutAddress: payoutAddress(),
      deliveryConditions: 'Courier, 3 days', disputeTerms: 'Photo evidence required', ...extra,
    },
  });
  if (r.status !== 201) throw new Error(`create order: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function joinHttp(srv, buyer, order, ks) {
  return srv.api('POST', `/api/orders/${order.ref}/join`, {
    token: buyer.token,
    json: { buyerPubkey: ks.b.pubkey, buyerPayoutAddress: payoutAddress(), agreementHash: order.agreementHash },
  });
}

export const llmPort_ = llmPort;
