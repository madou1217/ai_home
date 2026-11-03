'use strict';

const { runTranslationStream } = require('./translation-runner');
const { inferModelFamilyProvider } = require('./account-capabilities');

// Composition adapter for the existing gateway stream. Routing does not know
// gateway model-provider names or duplicate the inference provider dispatch.
function createTranslationGatewayExecutor(runner = runTranslationStream) {
  return (input, context = {}) => {
    const route = context.route || input.route || {};
    const model = String(route.model || '').trim();
    // Translation routes may carry an old/stale provider (for example a saved
    // `gemini-* + codex` pair). Resolve the actual model family before building
    // the gateway request so Gemini/Antigravity models use AGY accounts and
    // protocol adapters instead of producing a misleading Codex shortage.
    // A model family is only a fallback hint.  A translation route may point at
    // a healthy Codex API-key account whose custom AWS endpoint serves Gemini
    // models (AGY -> Codex protocol relay).  Do not overwrite that explicit
    // transport provider with the model-family provider.
    const provider = String(route.modelProvider || '').trim().toLowerCase()
      || inferModelFamilyProvider(model);
    return runner({
      ...input,
      model,
      provider,
      // 首字对冲的第 N 个请求换一个亲和键，避开第一个请求所在账号的排队。
      sessionKey: `aih-translation:${provider || 'auto'}:${model}${context.hedgeIndex > 0 ? `:hedge${context.hedgeIndex}` : ''}`
    }, context, context.emit || (() => {}));
  };
}

module.exports = { createTranslationGatewayExecutor };
