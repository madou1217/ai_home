'use strict';

const { getEnvironmentToolAdapter } = require('../tools');

function resolveWindowsEnvironmentPlans(toolId, action, options = {}) {
  const adapter = getEnvironmentToolAdapter(toolId);
  if (!adapter || !adapter.supports('windows') || typeof adapter[action] !== 'function') return [];
  return adapter[action]({ ...options, platform: 'windows' }) || [];
}

module.exports = {
  resolveWindowsEnvironmentPlans
};
