'use strict';

const { getEnvironmentToolAdapter } = require('../tools');

function resolveMacosEnvironmentPlans(toolId, action, options = {}) {
  const adapter = getEnvironmentToolAdapter(toolId);
  if (!adapter || !adapter.supports('macos') || typeof adapter[action] !== 'function') return [];
  return adapter[action]({ ...options, platform: 'macos' }) || [];
}

module.exports = {
  resolveMacosEnvironmentPlans
};
