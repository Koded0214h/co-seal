import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EsploraChain } from '../src/lib/chain.js';

function fake(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/signet/api` }));
  });
}

test('EsploraChain parses tip, utxos, tx status and broadcast responses', async () => {
  let posted = null;
  const { srv, url } = await fake((req, res) => {
    if (req.url === '/signet/api/blocks/tip/height') return res.end('250');
    if (req.url === '/signet/api/address/tb1qx/utxo') {
      return res.end(JSON.stringify([
        { txid: 'aa', vout: 1, value: 5000, status: { confirmed: true, block_height: 248 } },
        { txid: 'bb', vout: 0, value: 7000, status: { confirmed: false } },
      ]));
    }
    if (req.url === '/signet/api/tx/aa/status') return res.end(JSON.stringify({ confirmed: true, block_height: 248 }));
    if (req.url === '/signet/api/tx/zz/status') { res.statusCode = 404; return res.end('Transaction not found'); }
    if (req.url === '/signet/api/tx' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { posted = b; if (b === 'dup') { res.statusCode = 400; return res.end('txn-already-in-mempool'); } res.end('f'.repeat(64)); });
      return;
    }
    res.statusCode = 500; res.end('?');
  });
  try {
    const c = new EsploraChain(url);
    assert.equal(await c.getTipHeight(), 250);
    const u = await c.getUtxos('tb1qx');
    assert.deepEqual(u[0], { txid: 'aa', vout: 1, value: 5000, confirmed: true, blockHeight: 248 });
    assert.equal(u[1].confirmed, false);
    assert.deepEqual(await c.getTxStatus('aa'), { found: true, confirmed: true, blockHeight: 248 });
    assert.equal((await c.getTxStatus('zz')).found, false);
    assert.equal(await c.broadcast('0200'), 'f'.repeat(64));
    assert.equal(posted, '0200');
    await assert.rejects(() => c.broadcast('dup'), (e) => /already/.test(e.broadcastRejection));
  } finally { srv.close(); }
});
