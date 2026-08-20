'use strict';

// 只提供安装器的生命周期骨架；ensure-native-cli 延迟加载，避免 provider
// 注册表 -> 安装器 -> CLI facade 的循环依赖。
const { resolveClientPlatform } = require('../../runtime/client-platform');
const { defineInstallLifecycle } = require('../../runtime/install-lifecycle');
const {
  buildCaskUninstallPlan,
  buildCaskUpdatePlan,
  buildWingetUninstallPlan,
  buildWingetUpdatePlan
} = require('./official-install');

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

function normalizeVersionSource(source) {
  if (!source || typeof source !== 'object') return null;
  const type = String(source.type || source.kind || '').trim().toLowerCase();
  if (type === 'homebrew_cask') {
    const cask = String(source.cask || source.name || source.id || '').trim();
    return cask ? { type, cask } : null;
  }
  if (type === 'winget') {
    const id = String(source.id || source.packageId || source.name || '').trim();
    return id ? { type, id } : null;
  }
  return null;
}

function inferVersionSourceFromPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const command = String(plan.command || '').trim().toLowerCase().replace(/\\/g, '/').split('/').pop();
  const args = Array.isArray(plan.args) ? plan.args.map((arg) => String(arg || '').trim()) : [];
  if (command === 'brew' && args[0] === 'install' && args[1] === '--cask' && args[2]) {
    return { type: 'homebrew_cask', cask: args[2] };
  }
  if ((command === 'winget' || command === 'winget.exe') && args[0] === 'install') {
    const idIndex = args.findIndex((arg) => arg.toLowerCase() === '--id');
    if (idIndex >= 0 && args[idIndex + 1]) return { type: 'winget', id: args[idIndex + 1] };
  }
  return null;
}

function createProviderInstaller({ provider, desktop = {}, cli = {}, lifecycle = {}, managedApp = null }) {
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

  function resolveDesktopLifecyclePlans(action, options = {}) {
    const platform = resolveClientPlatform(options);
    const descriptor = desktop[platform];
    if (!descriptor) return [];
    const normalizedAction = String(action || '').trim().toLowerCase();
    const explicit = descriptor[`resolve${normalizedAction[0].toUpperCase()}${normalizedAction.slice(1)}Plans`];
    if (typeof explicit === 'function') {
      const resolved = explicit(options);
      return (Array.isArray(resolved) ? resolved : []).map(normalizePlan).filter(Boolean);
    }
    if (normalizedAction === 'install') return resolveDesktopInstallPlans(options);
    const installPlans = resolveDesktopInstallPlans(options);
    const cask = descriptor.cask || installPlans
      .find((plan) => plan && plan.command === 'brew' && plan.args && plan.args[0] === 'install' && plan.args[1] === '--cask')
      ?.args?.[2];
    const wingetId = descriptor.wingetId || installPlans
      .find((plan) => plan && plan.command === 'winget.exe' && plan.args && plan.args[0] === 'install')
      ?.args?.[2];
    if (cask) {
      const plan = normalizedAction === 'update'
        ? buildCaskUpdatePlan(cask, `Homebrew 更新 ${normalizedProvider} Desktop`)
        : buildCaskUninstallPlan(cask, `Homebrew 卸载 ${normalizedProvider} Desktop`);
      return [normalizePlan(plan)].filter(Boolean);
    }
    if (wingetId) {
      const plan = normalizedAction === 'update'
        ? buildWingetUpdatePlan(wingetId, `winget 更新 ${normalizedProvider} Desktop`)
        : buildWingetUninstallPlan(wingetId, `winget 卸载 ${normalizedProvider} Desktop`);
      return [normalizePlan(plan)].filter(Boolean);
    }
    return [];
  }

  function resolveDesktopVersionSource(options = {}) {
    const platform = resolveClientPlatform(options);
    const descriptor = desktop[platform];
    if (!descriptor) return null;
    const explicit = normalizeVersionSource(descriptor.versionSource);
    if (explicit) return explicit;
    return resolveDesktopInstallPlans(options)
      .map(inferVersionSourceFromPlan)
      .find(Boolean) || null;
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

  function resolveLifecyclePlans(action, options = {}) {
    const kind = String(options.kind || 'cli').trim().toLowerCase();
    if (kind === 'desktop') return resolveDesktopLifecyclePlans(action, options);
    if (!hasCli) return [];
    if (action === 'uninstall' && typeof cli.resolveUninstallPlans === 'function') {
      return cli.resolveUninstallPlans(options) || [];
    }
    if (action === 'update' && typeof cli.resolveUpdatePlans === 'function') {
      return cli.resolveUpdatePlans(options) || [];
    }
    // Official CLI installers are intentionally idempotent. Providers that
    // expose no dedicated update plan reuse their official install plan;
    // uninstall stays unavailable unless the provider explicitly declares it.
    if (action === 'install' || action === 'update') return resolveCliInstallPlans(options);
    return [];
  }

  const installLifecycle = defineInstallLifecycle({
    install: lifecycle.install || ((options = {}) => resolveLifecyclePlans('install', options)),
    update: lifecycle.update || ((options = {}) => resolveLifecyclePlans('update', options)),
    uninstall: lifecycle.uninstall || ((options = {}) => resolveLifecyclePlans('uninstall', options))
  }, `provider installer ${normalizedProvider}`);

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
    ...(managedApp && typeof managedApp === 'object' ? { managedApp: Object.freeze({
      ...managedApp,
      id: String(managedApp.id || normalizedProvider).trim().toLowerCase(),
      provider: String(managedApp.provider || normalizedProvider).trim().toLowerCase()
    }) } : {}),
    ...installLifecycle,
    resolveLifecyclePlans,
    resolveDesktopInstallPlans,
    resolveDesktopLifecyclePlans,
    resolveDesktopVersionSource,
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
