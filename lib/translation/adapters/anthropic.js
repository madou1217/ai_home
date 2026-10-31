'use strict';

const { createHttpTranslationAdapter, endpointUrl } = require('./http-transport');
const { buildTranslationPrompt } = require('./llm-prompt');

// Accept both https://host and https://host/v1 as the configured base URL.
function llmEndpoint(endpoint, fallback, path) {
  const base = String(endpoint || fallback || '').trim().replace(/\/+$/, '');
  return endpointUrl(base.endsWith('/v1') ? base.slice(0, -3) : base, '', path);
}

// Anthropic Messages API: https://docs.claude.com/en/api/messages
const spec = {
  id: 'anthropic',
  required: ['apiKey', 'model'],
  formality: true,
  buildRequest(input, config) {
    const prompt = buildTranslationPrompt(input);
    const url = llmEndpoint(config.endpoint, 'https://api.anthropic.com', '/v1/messages');
    return {
      url,
      init: {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': String(config.apiKey).trim(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: String(config.model).trim(),
          max_tokens: 4096,
          temperature: 0,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }]
        })
      }
    };
  },
  parseResponse(body) {
    const blocks = body && Array.isArray(body.content) ? body.content : [];
    const text = blocks.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('').trim();
    if (!text) return null;
    const usage = body.usage ? { inputTokens: body.usage.input_tokens || 0, outputTokens: body.usage.output_tokens || 0 } : null;
    return { text, usage };
  }
};

module.exports = { id: spec.id, createAnthropicTranslationAdapter: (options) => createHttpTranslationAdapter(spec, options) };
