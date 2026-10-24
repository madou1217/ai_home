'use strict';

const { createHttpTranslationAdapter, endpointUrl, automaticSource } = require('./http-transport');

// LibreTranslate uses zh for Simplified Chinese and zt for Traditional Chinese.
// Installed language packages determine which targets a particular host serves.
const LANGUAGE_CODES = Object.freeze({ 'zh-Hans': 'zh', 'zh-Hant': 'zt' });
// https://docs.libretranslate.com/api/operations/translate/
const spec = {
  id: 'libretranslate',
  required: ['endpoint'],
  buildRequest(input, config) {
    const url = endpointUrl(config.endpoint, '', '/translate');
    const body = {
      q: input.text,
      source: automaticSource(input.source) ? 'auto' : LANGUAGE_CODES[input.source] || input.source,
      target: LANGUAGE_CODES[input.target] || input.target,
      format: 'text'
    };
    if (config.apiKey) body.api_key = String(config.apiKey).trim();
    return { url, init: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } };
  },
  parseResponse(body) {
    return body && !body.error ? { text: body.translatedText } : null;
  }
};

module.exports = { id: spec.id, createLibreTranslateAdapter: (options) => createHttpTranslationAdapter(spec, options) };
