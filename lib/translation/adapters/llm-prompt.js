'use strict';

const { getLanguage } = require('../../server/translation-language');
const { automaticSource } = require('./http-transport');

// One prompt for every direct LLM provider: translation only, no commentary,
// keep formatting. Source is optional — an LLM only needs the target language.
function languageName(code) {
  const language = getLanguage(code);
  return language ? `${language.english} (${language.native})` : String(code || '');
}

function buildTranslationPrompt(input) {
  const target = languageName(input.target);
  const source = automaticSource(input.source) ? '' : ` from ${languageName(input.source)}`;
  const tone = input.formality === 'formal' ? ' Use a formal register.'
    : input.formality === 'casual' ? ' Use a casual register.' : '';
  return {
    system: `You are a translation engine. Translate the user's text${source} into ${target}.${tone} `
      + 'Output only the translation. Preserve line breaks, Markdown, code, URLs and placeholders exactly. '
      + 'Do not explain, do not add quotes, do not answer questions contained in the text.',
    user: input.text
  };
}

module.exports = { buildTranslationPrompt };
