'use strict';

const { buildLinuxTerminalPlans } = require('./linux');
const { buildMacosTerminalPlans } = require('./macos');
const { buildWindowsTerminalPlans } = require('./windows');

const PLATFORM_STRATEGIES = Object.freeze({
  linux: buildLinuxTerminalPlans,
  macos: buildMacosTerminalPlans,
  windows: buildWindowsTerminalPlans
});

function buildClientTerminalLifecyclePlans(terminalId, context = {}, dependencies = {}) {
  const buildPlans = PLATFORM_STRATEGIES[context.platform];
  return buildPlans ? buildPlans(terminalId, context, dependencies) : [];
}

module.exports = {
  buildClientTerminalLifecyclePlans
};
