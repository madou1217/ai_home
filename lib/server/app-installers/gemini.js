'use strict';

const { createProviderInstaller } = require('./provider-factory');
const { buildNpmPlan, buildCaskPlan, normalizePlatform } = require('./official-install');

module.exports = createProviderInstaller({
  provider: 'gemini',
  cli: {
    resolveInstallPlans: (options = {}) => {
      const plans = [buildNpmPlan('@google/gemini-cli', options)].filter(Boolean);
      if (normalizePlatform(options) === 'macos') plans.push(buildCaskPlan('gemini-cli', 'Homebrew 安装 Gemini CLI'));
      return plans;
    }
  }
});
