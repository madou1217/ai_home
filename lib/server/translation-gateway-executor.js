'use strict';

const { runTranslationStream } = require('./translation-runner');

// Composition adapter for the existing gateway stream. Routing does not know
// gateway model-provider names or duplicate the inference provider dispatch.
function createTranslationGatewayExecutor(runner = runTranslationStream) {
  return (input, context = {}) => {
    const route = context.route || input.route || {};
    const provider = String(route.modelProvider || '').trim();
    const model = String(route.model || '').trim();
    return runner({
      ...input,
      model,
      provider,
      sessionKey: `aih-translation:${provider || 'auto'}:${model}`
    }, context, context.emit || (() => {}));
  };
}

module.exports = { createTranslationGatewayExecutor };
