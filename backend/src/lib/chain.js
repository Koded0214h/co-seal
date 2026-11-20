/**
 * Chain access backends (PRD §11 / FR-03). The rest of the app talks to the `chain`
 * interface only, so Esplora can be swapped for bitcoind RPC without touching the lifecycle:
 *
 *   getTipHeight()            -> number
 *   getUtxos(address)         -> [{ txid, vout, value, confirmed, blockHeight }]
 *   getTxStatus(txid)         -> { found, confirmed, blockHeight }
 *   broadcast(rawHex)         -> txid
 *
 * `EsploraChain` talks to an Esplora-compatible REST API (mempool.space/signet/api, or a
 * self-hosted electrs). `MemoryChain` is an in-process fake used by tests and demos.
 */

export class EsploraChain {
  constructor(baseUrl, { timeoutMs = 10_000 } = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async #req(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, { ...opts, signal: AbortSignal.timeout(this.timeoutMs) });
    return res;
  }

  async getTipHeight() {
    const res = await this.#req('/blocks/tip/height');
    if (!res.ok) throw new Error(`esplora tip height: HTTP ${res.status}`);
    return Number(await res.text());
  }

  async getUtxos(address) {
    const res = await this.#req(`/address/${address}/utxo`);
    if (!res.ok) throw new Error(`esplora utxo: HTTP ${res.status}`);
    const list = await res.json();
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: Boolean(u.status?.confirmed),
      blockHeight: u.status?.block_height ?? null,
    }));
  }

  async getTxStatus(txid) {
    const res = await this.#req(`/tx/${txid}/status`);
    if (res.status === 404) return { found: false, confirmed: false, blockHeight: null };
    if (!res.ok) throw new Error(`esplora tx status: HTTP ${res.status}`);
    const s = await res.json();
    return { found: true, confirmed: Boolean(s.confirmed), blockHeight: s.block_height ?? null };
  }

  async broadcast(rawHex) {
    const res = await this.#req('/tx', { method: 'POST', body: rawHex, headers: { 'content-type': 'text/plain' } });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`broadcast rejected: ${text}`);
      e.status = 502;
      e.broadcastRejection = text;
      throw e;
    }
    return text.trim();
  }
}

/**
 * Bitcoin Core JSON-RPC adapter (PRD §11: "Bitcoin Core RPC and descriptor wallets").
 *
 * Funding detection needs *unconfirmed* visibility and per-address UTXOs, which Core only gives
 * through a wallet. So we keep a dedicated **watch-only, key-less** descriptor wallet and import
 * each escrow address into it as `addr(...)`. It holds no private keys — spending is still done
 * entirely by participants' PSBT signatures.
 */
export class BitcoindChain {
  constructor({ url, user, password, wallet = 'coseal_watch', timeoutMs = 15_000 }) {
    this.url = url.replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.wallet = wallet;
    this.timeoutMs = timeoutMs;
    this.imported = new Set();
    this.walletReady = null;
  }

  async #call(method, params = [], { wallet = false } = {}) {
    const res = await fetch(wallet ? `${this.url}/wallet/${this.wallet}` : this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.auth },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'coseal', method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body;
    try { body = await res.json(); } catch { throw new Error(`bitcoind ${method}: HTTP ${res.status}`); }
    if (body.error) {
      const e = new Error(`bitcoind ${method}: ${body.error.message}`);
      e.rpcCode = body.error.code;
      e.broadcastRejection = body.error.message;
      throw e;
    }
    return body.result;
  }

  async ensureWallet() {
    this.walletReady ??= (async () => {
      try {
        await this.#call('loadwallet', [this.wallet]);
      } catch (err) {
        if (err.rpcCode === -35) return; // already loaded
        if (err.rpcCode === -18 || err.rpcCode === -4 || /not found|does not exist/i.test(err.message)) {
          // name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors, load_on_startup
          await this.#call('createwallet', [this.wallet, true, true, '', false, true, true]);
          return;
        }
        throw err;
      }
    })().catch((e) => { this.walletReady = null; throw e; });
    return this.walletReady;
  }

  /**
   * Start watching an escrow address (idempotent). Bitcoin Core allows only one import/rescan at a
   * time per wallet ("Wallet is currently rescanning"), so imports are serialized through a queue,
   * de-duplicated per address, and retried briefly if the wallet is busy. timestamp:'now' means no
   * history is scanned — a freshly generated escrow has none.
   */
  watch(address) {
    if (this.imported.has(address)) return Promise.resolve();
    if (!this.inflight) this.inflight = new Map();
    if (this.inflight.has(address)) return this.inflight.get(address);
    this.queue ??= Promise.resolve();
    const job = this.queue.then(async () => {
      if (this.imported.has(address)) return;
      await this.ensureWallet();
      const info = await this.#call('getdescriptorinfo', [`addr(${address})`]);
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await this.#call('importdescriptors', [[{ desc: info.descriptor, timestamp: 'now', label: 'coseal-escrow' }]], { wallet: true });
          if (!out?.[0]?.success) throw new Error(`bitcoind importdescriptors failed: ${JSON.stringify(out?.[0]?.error)}`);
          this.imported.add(address);
          return;
        } catch (err) {
          if (/rescanning/i.test(err.message) && attempt < 40) { await new Promise((r) => setTimeout(r, 150)); continue; }
          throw err;
        }
      }
    }).finally(() => this.inflight.delete(address));
    this.queue = job.catch(() => {}); // a failed import must not wedge the queue
    this.inflight.set(address, job);
    return job;
  }

  async getTipHeight() { return this.#call('getblockcount'); }

  async getUtxos(address) {
    await this.watch(address);
    const [list, tip] = await Promise.all([
      this.#call('listunspent', [0, 9999999, [address], true], { wallet: true }),
      this.getTipHeight(),
    ]);
    return list.map((u) => ({
      txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8),
      confirmed: u.confirmations > 0, blockHeight: u.confirmations > 0 ? tip - u.confirmations + 1 : null,
    }));
  }

  async getTxStatus(txid) {
    await this.ensureWallet();
    const tip = await this.getTipHeight();
    try {
      const t = await this.#call('gettransaction', [txid, true], { wallet: true });
      const c = t.confirmations || 0;
      return { found: c >= 0, confirmed: c > 0, blockHeight: c > 0 ? tip - c + 1 : null };
    } catch (err) {
      if (err.rpcCode !== -5) throw err;
    }
    try { // not in the wallet: maybe in the mempool / txindex
      const t = await this.#call('getrawtransaction', [txid, true]);
      const c = t.confirmations || 0;
      return { found: true, confirmed: c > 0, blockHeight: c > 0 ? tip - c + 1 : null };
    } catch (err) {
      if (err.rpcCode === -5) return { found: false, confirmed: false, blockHeight: null };
      throw err;
    }
  }

  async broadcast(rawHex) {
    try {
      return await this.#call('sendrawtransaction', [rawHex]);
    } catch (err) {
      err.status = 502;
      throw err;
    }
  }
}

/** In-memory chain for tests/demos. Mirrors the Esplora semantics we depend on. */
export class MemoryChain {
  constructor() {
    this.height = 100;
    this.utxos = new Map(); // address -> [{txid, vout, value, height|null}]
    this.txs = new Map(); // txid -> { hex, height|null }
    this.nextId = 1;
    this.broadcasts = [];
  }

  fund(address, value, { confirmations = 1 } = {}) {
    const txid = (this.nextId++).toString(16).padStart(64, '0');
    const height = confirmations > 0 ? this.height - confirmations + 1 : null;
    const list = this.utxos.get(address) || [];
    list.push({ txid, vout: 0, value, height });
    this.utxos.set(address, list);
    this.txs.set(txid, { hex: null, height });
    return { txid, vout: 0 };
  }

  mine(n = 1) {
    this.height += n;
    for (const t of this.txs.values()) if (t.height == null && t.hex) t.height = this.height;
  }

  /** Simulate a reorg dropping an unspent output. */
  drop(address, txid) {
    this.utxos.set(address, (this.utxos.get(address) || []).filter((u) => u.txid !== txid));
    this.txs.delete(txid);
  }

  async getTipHeight() { return this.height; }

  async getUtxos(address) {
    return (this.utxos.get(address) || []).map((u) => ({
      txid: u.txid, vout: u.vout, value: u.value, confirmed: u.height != null, blockHeight: u.height,
    }));
  }

  async getTxStatus(txid) {
    const t = this.txs.get(txid);
    if (!t) return { found: false, confirmed: false, blockHeight: null };
    return { found: true, confirmed: t.height != null, blockHeight: t.height };
  }

  async broadcast(rawHex, txid) {
    // Caller (tests) cannot compute txid without bitcoinjs; derive it here lazily.
    const { Transaction } = await import('bitcoinjs-lib');
    const tx = Transaction.fromHex(rawHex);
    const id = txid || tx.getId();
    // Like a real node: spent outputs leave the UTXO set; double-spends are rejected.
    const spends = tx.ins.map((i) => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`);
    for (const key of spends) {
      const found = [...this.utxos.values()].some((l) => l.some((u) => `${u.txid}:${u.vout}` === key));
      if (!found && !this.txs.has(id)) {
        const e = new Error('bad-txns-inputs-missingorspent'); e.broadcastRejection = e.message; e.status = 502; throw e;
      }
    }
    for (const [addr, list] of this.utxos) this.utxos.set(addr, list.filter((u) => !spends.includes(`${u.txid}:${u.vout}`)));
    this.broadcasts.push(id);
    this.txs.set(id, { hex: rawHex, height: null });
    return id;
  }
}
