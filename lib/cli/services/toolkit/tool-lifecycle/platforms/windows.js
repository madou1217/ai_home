'use strict';

const { buildExternalRemovalPlan, buildOfficialReleasePlan } = require('../shared');

function resolveWindowsToolPlans(toolId, action, state = {}, options = {}) {
  if (toolId !== 'frpc') return [];
  if (action === 'install' || action === 'update') return [buildOfficialReleasePlan(action, options)];
  if (action === 'uninstall' && state.managed) return [buildOfficialReleasePlan(action, options)];
  if (action === 'uninstall' && state.external) return [buildExternalRemovalPlan(state.executablePath, options)];
  return [];
}

module.exports = { resolveWindowsToolPlans };
