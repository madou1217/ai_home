'use strict';

const microsoft = require('./microsoft');
const google = require('./google');
const libretranslate = require('./libretranslate');
const deepl = require('./deepl');

const BUILTIN_TRANSLATION_ADAPTER_FACTORIES = Object.freeze([
  { id: microsoft.id, create: microsoft.createMicrosoftTranslationAdapter },
  { id: google.id, create: google.createGoogleTranslationAdapter },
  { id: libretranslate.id, create: libretranslate.createLibreTranslateAdapter },
  { id: deepl.id, create: deepl.createDeepLTranslationAdapter }
]);

// Composition-only registration. Dispatch is owned by the provider facade;
// adding a service requires a descriptor and factory, never a routing branch.
function createTranslationAdapterRegistry(options = {}) {
  const adapters = Object.create(null);
  for (const entry of options.factories || BUILTIN_TRANSLATION_ADAPTER_FACTORIES) {
    if (!entry || !entry.id || typeof entry.create !== 'function') throw new Error('translation_adapter_factory_invalid');
    if (Object.prototype.hasOwnProperty.call(adapters, entry.id)) throw new Error('translation_adapter_factory_duplicate');
    adapters[entry.id] = entry.create(options);
  }
  return adapters;
}

module.exports = { createTranslationAdapterRegistry, BUILTIN_TRANSLATION_ADAPTER_FACTORIES };
