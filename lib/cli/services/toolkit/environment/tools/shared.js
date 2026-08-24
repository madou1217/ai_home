'use strict';

const {
  buildBrewPlan,
  buildNpmGlobalPlan,
  buildPowerShellScriptPlan,
  buildShellScriptPlan,
  buildWingetPlan
} = require('../plan-builders');
const { probeCommand } = require('../probe');

function buildOfficialShellPlan(toolId, action, name, installer, options = {}) {
  return buildShellScriptPlan(toolId, action, {
    ...installer,
    label: `${action === 'update' ? '更新' : '安装'} ${name}`,
    method: '官方安装器',
    options
  });
}

function buildOfficialPowerShellPlan(toolId, action, name, installer, options = {}) {
  return buildPowerShellScriptPlan(toolId, action, {
    ...installer,
    label: `${action === 'update' ? '更新' : '安装'} ${name}`,
    method: '官方安装器',
    options
  });
}

function buildNpmPackagePlans(toolId, name, action, options = {}) {
  const npmPlan = buildNpmGlobalPlan(toolId, action, toolId, { ...options, name });
  if (options.platform !== 'macos') return [npmPlan];
  return [buildBrewPlan(toolId, action, toolId, { name }), npmPlan];
}

function commandDetector(command, args = ['--version']) {
  return (options = {}) => probeCommand(command, args, options);
}

function wingetPlan(toolId, name, action, packageId) {
  return buildWingetPlan(toolId, action, packageId, { name });
}

module.exports = {
  buildNpmPackagePlans,
  buildOfficialPowerShellPlan,
  buildOfficialShellPlan,
  commandDetector,
  wingetPlan
};
