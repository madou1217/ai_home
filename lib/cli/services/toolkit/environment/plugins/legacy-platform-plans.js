'use strict';

const { resolveLinuxEnvironmentPlans } = require('../platforms/linux');
const { resolveMacosEnvironmentPlans } = require('../platforms/macos');
const { resolveWindowsEnvironmentPlans } = require('../platforms/windows');

// Node / Python 插件沿用既有的按平台计划表（platforms/*.js），插件只做分派。
function resolveLegacyPlatformPlans(toolId, action, options = {}) {
  if (options.platform === 'macos') return resolveMacosEnvironmentPlans(toolId, action, options);
  if (options.platform === 'windows') return resolveWindowsEnvironmentPlans(toolId, action, options);
  return resolveLinuxEnvironmentPlans(toolId, action, options);
}

module.exports = {
  resolveLegacyPlatformPlans
};
