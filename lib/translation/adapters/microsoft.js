'use strict';

const { createHttpTranslationAdapter, endpointUrl, automaticSource } = require('./http-transport');

// https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate
const spec = {
  id: 'microsoft',
  required: ['apiKey'],
  buildRequest(input, config) {
    const url = endpointUrl(config.endpoint, 'https://api.cognitive.microsofttranslator.com', '/translate');
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', input.target);
    url.searchParams.set('textType', 'plain');
    if (!automaticSource(input.source)) url.searchParams.set('from', input.source);
    const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': String(config.apiKey).trim() };
    if (config.region) headers['Ocp-Apim-Subscription-Region'] = String(config.region).trim();
    return { url, init: { headers, body: JSON.stringify([{ Text: input.text }]) } };
  },
  parseResponse(body) {
    if (!Array.isArray(body) || body.length !== 1 || !Array.isArray(body[0].translations) || body[0].translations.length !== 1) return null;
    return { text: body[0].translations[0].text };
  }
};

module.exports = { id: spec.id, createMicrosoftTranslationAdapter: (options) => createHttpTranslationAdapter(spec, options) };
