'use strict';

const { createHttpTranslationAdapter, endpointUrl, automaticSource } = require('./http-transport');

const LANGUAGE_CODES = Object.freeze({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' });
// https://cloud.google.com/translate/docs/reference/rest/v2/translate
const spec = {
  id: 'google',
  required: ['apiKey'],
  buildRequest(input, config) {
    const url = endpointUrl(config.endpoint, 'https://translation.googleapis.com', '/language/translate/v2');
    const body = { q: [input.text], target: LANGUAGE_CODES[input.target] || input.target, format: 'text' };
    if (!automaticSource(input.source)) body.source = LANGUAGE_CODES[input.source] || input.source;
    return { url, init: { headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': String(config.apiKey).trim() }, body: JSON.stringify(body) } };
  },
  parseResponse(body) {
    const translations = body && body.data && body.data.translations;
    if (!Array.isArray(translations) || translations.length !== 1) return null;
    // format=text returns plain text; decoding entities again would corrupt
    // literal user text such as "&amp;".
    return { text: translations[0].translatedText };
  }
};

module.exports = { id: spec.id, createGoogleTranslationAdapter: (options) => createHttpTranslationAdapter(spec, options) };
