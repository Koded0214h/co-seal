import Anthropic from '@anthropic-ai/sdk';
import { extractJson } from './json.js';

/**
 * Claude adapter (Anthropic SDK, vision). Default model: claude-haiku-5-5 — the smallest/cheapest
 * Claude — at low effort. Same contract as the OpenAI adapter. Select with LLM_PROVIDER=anthropic.
 */
export function createAnthropicAdapter(cfg) {
  let client = null;
  const getClient = () => (client ??= new Anthropic({
    apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined, maxRetries: 1, timeout: cfg.timeoutMs,
  }));

  return {
    provider: 'anthropic',
    model: cfg.model,
    async complete({ system, prompt, images = [] }) {
      if (!cfg.apiKey) return { ok: false, reason: 'ANTHROPIC_API_KEY not configured' };
      const content = [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        { type: 'text', text: prompt },
      ];
      let lastReason = 'unknown';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await getClient().messages.create({
            model: cfg.model,
            max_tokens: 2000,
            system,
            output_config: { effort: 'low' },
            messages: [{ role: 'user', content: attempt === 0 ? content : [...content, { type: 'text', text: 'Reply with ONLY the JSON object, nothing else.' }] }],
          });
          if (res.stop_reason === 'refusal') return { ok: false, reason: 'model declined to assess this content' };
          const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          const parsed = extractJson(raw);
          if (parsed) return { ok: true, data: parsed, usage: res.usage };
          lastReason = 'Could not parse model JSON';
        } catch (err) {
          if (err instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, reason: 'LLM timeout' };
          if (err instanceof Anthropic.RateLimitError) return { ok: false, reason: 'LLM rate limited' };
          if (err instanceof Anthropic.AuthenticationError) return { ok: false, reason: 'LLM authentication failed (check ANTHROPIC_API_KEY)' };
          if (err instanceof Anthropic.APIError) return { ok: false, reason: `LLM error ${err.status ?? ''}`.trim() };
          return { ok: false, reason: err?.message ? String(err.message).slice(0, 120) : 'LLM request failed' };
        }
      }
      return { ok: false, reason: lastReason };
    },
  };
}
