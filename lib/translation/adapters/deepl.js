'use strict';

const { createHttpTranslationAdapter, endpointUrl, automaticSource } = require('./http-transport');

const TARGET_CODES = Object.freeze({ 'zh-Hans': 'ZH-HANS', 'zh-Hant': 'ZH-HANT', en: 'EN-US', pt: 'PT-PT' });
const SOURCE_CODES = Object.freeze({ 'zh-Hans': 'ZH', 'zh-Hant': 'ZH' });
const FORMALITY = Object.freeze({ formal: 'prefer_more', casual: 'prefer_less', default: 'default' });
// https://developers.deepl.com/api-reference/translate
const spec = {
  id: 'deepl',
  required: ['apiKey'],
  formality: true,
  buildRequest(input, config) {
    const apiKey = String(config.apiKey).trim();
    const fallback = apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const url = endpointUrl(config.endpoint, fallback, '/v2/translate');
    const body = {
      text: [input.text],
      target_lang: TARGET_CODES[input.target] || String(input.target).toUpperCase(),
      show_billed_characters: true,
      formality: FORMALITY[input.formality]
    };
    if (!automaticSource(input.source)) body.source_lang = SOURCE_CODES[input.source] || String(input.source).toUpperCase();
    return { url, init: { headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${apiKey}` }, body: JSON.stringify(body) } };
  },
  parseResponse(body) {
    if (!body || !Array.isArray(body.translations) || body.translations.length !== 1) return null;
    const translation = body.translations[0];
    const count = translation.billed_characters;
    return { text: translation.text, usage: Number.isFinite(count) && count >= 0 ? { billedCharacters: count } : null };
  }
};

module.exports = { id: spec.id, createDeepLTranslationAdapter: (options) => createHttpTranslationAdapter(spec, options) };
