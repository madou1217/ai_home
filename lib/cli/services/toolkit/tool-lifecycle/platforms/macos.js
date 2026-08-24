'use strict';

const {
  buildExternalRemovalPlan,
  buildHomebrewPlan,
  buildOfficialReleasePlan,
  resolveCommand
} = require('../shared');

function resolveMacosToolPlans(toolId, action, state = {}, options = {}) {
  if (toolId !== 'frpc') return [];
  const plans = [];
  const brewPath = resolveCommand('brew', options);
  if (action === 'install' || action === 'update') {
    if (brewPath) plans.push(buildHomebrewPlan(action, brewPath, options));
    plans.push(buildOfficialReleasePlan(action, options));
    return plans;
  }
  if (action === 'uninstall') {
    if (state.homebrew && brewPath) plans.push(buildHomebrewPlan(action, brewPath, options));
    if (state.managed) plans.push(buildOfficialReleasePlan(action, options));
    if (state.homebrew || state.external) {
      const externalRemoval = buildExternalRemovalPlan(state.executablePath, options);
      if (externalRemoval) plans.push(externalRemoval);
    }
  }
  return plans;
}

module.exports = { resolveMacosToolPlans };
