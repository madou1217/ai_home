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
    const provider = inferModelFamilyProvider(model) || String(route.modelProvider || '').trim();
    return runner({
      ...input,
      model,
      provider,
      sessionKey: `aih-translation:${provider || 'auto'}:${model}`
    }, context, context.emit || (() => {}));
  };
}

module.exports = { createTranslationGatewayExecutor };
