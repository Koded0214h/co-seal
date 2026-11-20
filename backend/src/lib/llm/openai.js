import OpenAI from 'openai';
import { extractJson } from './json.js';

/**
 * OpenAI adapter (Chat Completions, vision). Default model: gpt-5-nano — OpenAI's smallest,
 * cheapest model — at minimal reasoning effort. Contract shared by all adapters:
 *
 *   complete({ system, prompt, images:[{mediaType, data(base64)}] })
 *     -> { ok:true, data:<parsed JSON>, usage } | { ok:false, reason }
 *
 * It never throws: the AI is advisory, so every failure is reported as unavailable (PRD §3.5/§8).
 */
export function createOpenAIAdapter(cfg) {
  let client = null;
  const getClient = () => (client ??= new OpenAI({
    apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined,
    maxRetries: 1, // one retry on 429/5xx/connection errors, then give up
    timeout: cfg.timeoutMs,
  }));
  const isGpt5 = /^(gpt-5|o\d)/.test(cfg.model);

  return {
    provider: 'openai',
    model: cfg.model,
    async complete({ system, prompt, images = [] }) {
      if (!cfg.apiKey) return { ok: false, reason: 'OPENAI_API_KEY not configured' };

      const messages = [
        ...(system ? [{ role: 'system', content: system }] : []),
        {
          role: 'user',
          content: [
            ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}`, detail: cfg.imageDetail } })),
            { type: 'text', text: prompt },
          ],
        },
      ];

      // Attempt 1: JSON mode (+ minimal reasoning on the gpt-5 family). Attempt 2: plain call, in
      // case the model rejects one of those params. No temperature: gpt-5 only allows the default.
      const attempts = [
        { model: cfg.model, messages, max_completion_tokens: 1500, response_format: { type: 'json_object' },
          ...((cfg.reasoningEffort || (isGpt5 ? 'minimal' : '')) ? { reasoning_effort: cfg.reasoningEffort || 'minimal' } : {}) },
        { model: cfg.model, messages, max_completion_tokens: 1500 },
      ];

      let lastReason = 'unknown';
      for (let i = 0; i < attempts.length; i++) {
        try {
          const res = await getClient().chat.completions.create(attempts[i]);
          const choice = res.choices?.[0];
          if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
            return { ok: false, reason: 'model declined to assess this content' };
          }
          const parsed = extractJson(choice?.message?.content);
          if (parsed) return { ok: true, data: parsed, usage: res.usage };
          lastReason = 'Could not parse model JSON';
        } catch (err) {
          if (err instanceof OpenAI.APIConnectionTimeoutError) return { ok: false, reason: 'LLM timeout' };
          if (err instanceof OpenAI.RateLimitError) return { ok: false, reason: 'LLM rate limited' };
          if (err instanceof OpenAI.AuthenticationError) return { ok: false, reason: 'LLM authentication failed (check OPENAI_API_KEY)' };
          if (err instanceof OpenAI.BadRequestError && i === 0 && /reasoning_effort|response_format|unsupported|not supported|max_completion_tokens/i.test(err.message)) {
            lastReason = err.message.slice(0, 120);
            continue; // retry without the optional params
          }
          if (err instanceof OpenAI.APIError) return { ok: false, reason: `LLM error ${err.status ?? ''}`.trim() };
          return { ok: false, reason: err?.message ? String(err.message).slice(0, 120) : 'LLM request failed' };
        }
      }
      return { ok: false, reason: lastReason };
    },
  };
}
