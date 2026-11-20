import { config } from '../../config.js';
import { createOpenAIAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';

/**
 * LLM provider adapters. ai.js talks only to `completeJson`; swapping providers is a config
 * change (LLM_PROVIDER=openai|anthropic) and adding one is a new file implementing
 * `complete({ system, prompt, images }) -> { ok, data | reason }`.
 */
const FACTORIES = { openai: createOpenAIAdapter, anthropic: createAnthropicAdapter };

export function createAdapter(cfg = config.llm) {
  const make = FACTORIES[cfg.provider];
  if (!make) throw new Error(`Unknown LLM_PROVIDER "${cfg.provider}" (supported: ${Object.keys(FACTORIES).join(', ')})`);
  return make(cfg);
}

let _adapter = null;
export const getAdapter = () => (_adapter ??= createAdapter());
export const setAdapter = (a) => { _adapter = a; }; // tests / custom providers

export const completeJson = (req) => getAdapter().complete(req);
