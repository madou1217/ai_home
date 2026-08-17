'use strict';

const { installNativeCliWithProgress } = require('../../cli/services/ai-cli/ensure-native-cli');

function normalizePlatform(options = {}) {
  const value = String(
    options.platform || options.processObj && options.processObj.platform || process.platform
  ).trim().toLowerCase();
  if (value === 'macos' || value === 'mac') return 'darwin';
  if (value === 'windows' || value === 'win') return 'win32';
  return value;
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const command = String(plan.command || '').trim();
  if (!command) return null;
  return {
    id: String(plan.id || '').trim(),
    label: String(plan.label || '').trim(),
    command,
    args: Array.isArray(plan.args) ? plan.args.map((arg) => String(arg)) : [],
    timeoutMs: Number(plan.timeoutMs) > 0 ? Number(plan.timeoutMs) : 30 * 60 * 1000
  };
}

function createProviderInstaller({ provider, desktop = {} }) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();

  function resolveDesktopInstallPlans(options = {}) {
    const platform = normalizePlatform(options);
    const descriptor = desktop[platform];
    if (!descriptor) return [];
    const plans = [];
    if (descriptor.cask) {
      plans.push(normalizePlan({
        id: 'homebrew_cask',
        label: `Homebrew 安装 ${normalizedProvider} Desktop`,
        command: 'brew',
        args: ['install', '--cask', descriptor.cask]
      }));
    }
    if (descriptor.wingetId) {
      plans.push(normalizePlan({
        id: 'winget',
        label: `winget 安装 ${normalizedProvider} Desktop`,
        command: 'winget.exe',
        args: [
          'install',
          '--id', descriptor.wingetId,
          '--exact',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ]
      }));
    }
    return plans.filter(Boolean);
  }

  function installCli(options = {}) {
    return installNativeCliWithProgress(normalizedProvider, options);
  }

  function buildDesktopInstallHint(options = {}) {
    const platform = normalizePlatform(options);
    const descriptor = desktop[platform];
    if (descriptor && descriptor.cask) {
      return `请先安装 Homebrew，然后执行 brew install --cask ${descriptor.cask}。`;
    }
    if (descriptor && descriptor.wingetId) {
      return `请先安装 winget，然后执行 winget install --id ${descriptor.wingetId} --exact。`;
    }
    return `当前平台没有 ${normalizedProvider} Desktop 的无交互安装器，请手动安装官方应用后重试。`;
  }

  return Object.freeze({
    provider: normalizedProvider,
    installCli,
    resolveDesktopInstallPlans,
    buildDesktopInstallHint
  });
}

module.exports = {
  createProviderInstaller
};
