'use strict';

const facade = require('./provider-facade');

// Translation consumers use this facade instead of importing the registry or
// keeping a provider-name list.  Optional adapters/descriptors are supplied by
// the composition root without changing routing code.
const translationProviders = facade.getTranslationProviderFacade();

module.exports = {
  ...facade,
  ...require('./route-planner'),
  ...require('./route-runner'),
  ...require('./replacement'),
  ...require('./adapters'),
  ...require('./execution-port'),
  translationProviders
};
