'use strict';

const { getEnvironmentToolAdapter } = require('../tools');

function resolveLinuxEnvironmentPlans(toolId, action, options = {}) {
  const adapter = getEnvironmentToolAdapter(toolId);
  if (!adapter || !adapter.supports('linux') || typeof adapter[action] !== 'function') return [];
  return adapter[action]({ ...options, platform: 'linux' }) || [];
}

module.exports = {
  resolveLinuxEnvironmentPlans
};
