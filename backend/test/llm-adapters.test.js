import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llm, llmPort_ } from './helpers.js';
import { createAdapter } from '../src/lib/llm/index.js';
import { createOpenAIAdapter } from '../src/lib/llm/openai.js';
import { createAnthropicAdapter } from '../src/lib/llm/anthropic.js';

const IMG = [{ mediaType: 'image/jpeg', data: Buffer.from('x').toString('base64') }];
const req = { system: 'sys', prompt: 'a proof of dispatch', images: IMG };
const base = { apiKey: 'k', timeoutMs: 1500 };
const openai = () => createOpenAIAdapter({ ...base, baseUrl: `http://127.0.0.1:${llmPort_}/v1`, model: 'gpt-5-nano', imageDetail: 'low', reasoningEffort: '' });
const claude = () => createAnthropicAdapter({ ...base, baseUrl: `http://127.0.0.1:${llmPort_}`, model: 'claude-haiku-5-5' });

for (const [name, make] of [['openai', openai], ['anthropic', claude]]) {
  test(`${name} adapter: success returns parsed JSON; every failure mode returns {ok:false} instead of throwing`, async () => {
    llm.mode = 'ok';
    const a = make();
    const ok = await a.complete(req);
    assert.equal(ok.ok, true);
    assert.equal(ok.data.genuine, true);
    assert.equal(a.provider, name);

    for (const [mode, expect] of [['ratelimit', /rate limited/], ['down', /LLM error/], ['autherr', /authentication/], ['malformed', /parse/], ['refusal', /declined/], ['slow', /timeout/]]) {
      llm.mode = mode;
      const r = await make().complete(req);
      assert.equal(r.ok, false, mode);
      assert.match(r.reason, expect, `${name}/${mode}: ${r.reason}`);
    }
    llm.mode = 'ok';
  });

  test(`${name} adapter: missing API key is reported, not thrown`, async () => {
    const a = name === 'openai' ? createOpenAIAdapter({ ...base, apiKey: '', baseUrl: '', model: 'gpt-5-nano', imageDetail: 'low' }) : createAnthropicAdapter({ ...base, apiKey: '', baseUrl: '', model: 'claude-haiku-5-5' });
    const r = await a.complete(req);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not configured/);
  });
}

test('openai adapter: a model that rejects reasoning_effort/response_format is retried with plain params', async () => {
  llm.mode = 'reject-params'; llm.requests.length = 0;
  const r = await openai().complete(req);
  assert.equal(r.ok, true);
  assert.equal(llm.requests.length, 2);
  assert.ok(llm.requests[0].reasoning_effort && llm.requests[0].response_format);
  assert.equal('reasoning_effort' in llm.requests[1], false);
  assert.equal('response_format' in llm.requests[1], false);
  llm.mode = 'ok';
});

test('openai adapter: non-gpt-5 models do not get reasoning_effort', async () => {
  llm.requests.length = 0;
  await createOpenAIAdapter({ ...base, baseUrl: `http://127.0.0.1:${llmPort_}/v1`, model: 'gpt-4.1-nano', imageDetail: 'low' }).complete(req);
  assert.equal('reasoning_effort' in llm.requests[0], false);
});

test('adapter factory selects by provider and rejects unknown ones', () => {
  assert.equal(createAdapter({ ...base, provider: 'openai', model: 'm' }).provider, 'openai');
  assert.equal(createAdapter({ ...base, provider: 'anthropic', model: 'm' }).provider, 'anthropic');
  assert.throws(() => createAdapter({ provider: 'nope' }), /Unknown LLM_PROVIDER/);
});
