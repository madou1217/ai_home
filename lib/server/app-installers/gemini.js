'use strict';

const { createProviderInstaller } = require('./provider-factory');
const { buildNpmPlan, buildNpmUpdatePlan, buildNpmUninstallPlan, buildCaskPlan, normalizePlatform } = require('./official-install');
const { CLIENT_PLATFORMS } = require('../../runtime/client-platform');

module.exports = createProviderInstaller({
  provider: 'gemini',
  cli: {
    resolveInstallPlans: (options = {}) => {
      const plans = [buildNpmPlan('@google/gemini-cli', options)].filter(Boolean);
      if (normalizePlatform(options) === CLIENT_PLATFORMS.MACOS) plans.push(buildCaskPlan('gemini-cli', 'Homebrew 安装 Gemini CLI'));
      return plans;
    },
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan('@google/gemini-cli', options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan('@google/gemini-cli', options)].filter(Boolean)
  }
});
