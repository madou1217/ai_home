'use strict';

const { createHttpTranslationAdapter, endpointUrl } = require('./http-transport');
const { buildTranslationPrompt } = require('./llm-prompt');

// Accept both https://host and https://host/v1 as the configured base URL.
function llmEndpoint(endpoint, fallback, path) {
  const base = String(endpoint || fallback || '').trim().replace(/\/+$/, '');
  return endpointUrl(base.endsWith('/v1') ? base.slice(0, -3) : base, '', path);
}

// OpenAI Chat Completions and every compatible endpoint (DeepSeek, Qwen, Ollama,
// OpenRouter, vLLM …): https://platform.openai.com/docs/api-reference/chat/create
function createSpec(id, fallbackEndpoint) {
  return {
    id,
    required: ['apiKey', 'model'],
    formality: true,
    buildRequest(input, config) {
      const prompt = buildTranslationPrompt(input);
      const url = llmEndpoint(config.endpoint, fallbackEndpoint, '/v1/chat/completions');
      return {
        url,
        init: {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(config.apiKey).trim()}` },
          body: JSON.stringify({
            model: String(config.model).trim(),
            temperature: 0,
            messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]
          })
        }
      };
    },
    parseResponse(body) {
      const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
      const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
      if (!text) return null;
      const usage = body.usage && Number.isFinite(body.usage.total_tokens)
        ? { inputTokens: body.usage.prompt_tokens || 0, outputTokens: body.usage.completion_tokens || 0 }
        : null;
      return { text, usage };
    }
  };
}

const openai = createSpec('openai', 'https://api.openai.com');
const compatible = createSpec('openai-compatible', '');

module.exports = {
  openaiId: openai.id,
  compatibleId: compatible.id,
  createOpenAITranslationAdapter: (options) => createHttpTranslationAdapter(openai, options),
  createOpenAICompatibleTranslationAdapter: (options) => createHttpTranslationAdapter(compatible, options)
};
