'use strict';

const { defineInstallLifecycle } = require('../install-lifecycle');

function pickLifecyclePlan(buildPlans, action, context) {
  return (buildPlans(context) || []).find((item) => item && item.action === action) || null;
}

function defineClientTerminalAdapter(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('client terminal adapter must be an object');
  }
  const id = String(definition.id || '').trim();
  if (!id || typeof definition.supports !== 'function' || typeof definition.detect !== 'function'
    || typeof definition.buildLaunch !== 'function' || typeof definition.buildPlans !== 'function') {
    throw new TypeError(`invalid client terminal adapter: ${id || '(empty)'}`);
  }
  const lifecycle = defineInstallLifecycle({
    install: definition.install || ((context) => pickLifecyclePlan(definition.buildPlans, 'install', context)),
    update: definition.update || ((context) => pickLifecyclePlan(definition.buildPlans, 'update', context)),
    uninstall: definition.uninstall || ((context) => pickLifecyclePlan(definition.buildPlans, 'uninstall', context))
  }, `client terminal adapter ${id}`);
  return Object.freeze({
    id,
    name: String(definition.name || id),
    description: String(definition.description || ''),
    sourceUrl: String(definition.sourceUrl || ''),
    platforms: definition.platforms || {},
    supports: definition.supports,
    detect: definition.detect,
    buildLaunch: definition.buildLaunch,
    buildPlans: definition.buildPlans,
    ...lifecycle,
    default: Boolean(definition.default)
  });
}

module.exports = {
  defineClientTerminalAdapter,
  pickLifecyclePlan
};
