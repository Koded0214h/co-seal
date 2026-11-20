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
    const id = txid || Transaction.fromHex(rawHex).getId();
    this.broadcasts.push(id);
    this.txs.set(id, { hex: rawHex, height: null });
    return id;
  }
}
