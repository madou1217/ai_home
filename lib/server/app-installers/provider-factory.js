'use strict';

// 只提供安装器的生命周期骨架；ensure-native-cli 延迟加载，避免 provider
// 注册表 -> 安装器 -> CLI facade 的循环依赖。
const { resolveClientPlatform } = require('../../runtime/client-platform');

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

function createProviderInstaller({ provider, desktop = {}, cli = {} }) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const hasCli = Boolean(cli && (
    typeof cli.resolveInstallPlans === 'function'
    || typeof cli.collectPathEntries === 'function'
    || typeof cli.binaryNames === 'function'
    || Array.isArray(cli.binaryNames)
  ));

  function resolveDesktopInstallPlans(options = {}) {
    const platform = resolveClientPlatform(options);
    const descriptor = desktop[platform];
    if (!descriptor) return [];
    if (typeof descriptor.resolveInstallPlans === 'function') {
      const resolved = descriptor.resolveInstallPlans(options);
      return (Array.isArray(resolved) ? resolved : []).map(normalizePlan).filter(Boolean);
    }
    if (Array.isArray(descriptor.plans)) {
      return descriptor.plans.map(normalizePlan).filter(Boolean);
    }
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
    const { installNativeCliWithProgress } = require('../../cli/services/ai-cli/ensure-native-cli');
    const resolveInstallPlans = typeof cli.resolveInstallPlans === 'function'
      ? (providerId, pkg, planOptions) => cli.resolveInstallPlans(planOptions)
      : options.resolveInstallPlans;
    return installNativeCliWithProgress(normalizedProvider, {
      ...options,
      ...(resolveInstallPlans ? { resolveInstallPlans } : {})
    });
  }

  function resolveCliInstallPlans(options = {}) {
    if (typeof cli.resolveInstallPlans !== 'function') return [];
    return cli.resolveInstallPlans(options) || [];
  }

  function collectCliPathEntries(options = {}) {
    if (typeof cli.collectPathEntries !== 'function') return [];
    const entries = cli.collectPathEntries(options);
    return Array.isArray(entries) ? entries.filter(Boolean) : [];
  }

  function listCliBinaryNames() {
    const names = typeof cli.binaryNames === 'function' ? cli.binaryNames() : cli.binaryNames;
    return (Array.isArray(names) ? names : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean);
  }

  function buildDesktopInstallHint(options = {}) {
    const platform = resolveClientPlatform(options);
    const descriptor = desktop[platform];
    if (descriptor && descriptor.cask) {
      return `请先安装 Homebrew，然后执行 brew install --cask ${descriptor.cask}。`;
    }
    if (descriptor && descriptor.wingetId) {
      return `请先安装 winget，然后执行 winget install --id ${descriptor.wingetId} --exact。`;
    }
    if (descriptor && descriptor.hint) return String(descriptor.hint);
    return `当前平台没有 ${normalizedProvider} Desktop 的无交互安装器，请手动安装官方应用后重试。`;
  }

  const installer = {
    provider: normalizedProvider,
    resolveDesktopInstallPlans,
    buildDesktopInstallHint
  };
  if (hasCli) {
    Object.assign(installer, {
      installCli,
      resolveCliInstallPlans,
      collectCliPathEntries,
      listCliBinaryNames
    });
  }
  return Object.freeze(installer);
}

module.exports = {
  createProviderInstaller
};
