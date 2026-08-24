'use strict';

// 只提供安装器的生命周期骨架；ensure-native-cli 延迟加载，避免 provider
// 注册表 -> 安装器 -> CLI facade 的循环依赖。
const { resolveClientPlatform } = require('../../runtime/client-platform');
const { defineInstallLifecycle } = require('../../runtime/install-lifecycle');
const { resolvePlatformPath } = require('../../runtime/platform-path');
const {
  buildBrewFormulaUninstallPlan,
  buildBrewFormulaUpdatePlan,
  buildCaskUninstallPlan,
  buildCaskUpdatePlan,
  buildLinuxPackageUninstallPlan,
  buildManagedPathUninstallPlan,
  buildNpmUninstallPlan,
  buildNpmUpdatePlan,
  buildWingetUninstallPlan,
  buildWingetUpdatePlan,
  buildWindowsRegistryUninstallPlan
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

function commandBasename(plan) {
  return String(plan && plan.command || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .pop();
}

function firstPackageArgument(args, startIndex) {
  for (let index = startIndex; index < args.length; index += 1) {
    const value = String(args[index] || '').trim();
    if (value && !value.startsWith('-')) return value;
  }
  return '';
}

function inferLifecyclePlansFromInstallPlans(action, installPlans, options = {}) {
  const plans = [];
  for (const plan of installPlans) {
    const command = commandBasename(plan);
    const args = Array.isArray(plan && plan.args) ? plan.args.map((arg) => String(arg || '').trim()) : [];
    if ((command === 'npm' || command === 'npm.cmd') && args[0] === 'install') {
      const globalIndex = args.findIndex((arg) => arg === '--global' || arg === '-g');
      const packageName = globalIndex >= 0 ? firstPackageArgument(args, globalIndex + 1) : '';
      if (packageName) {
        plans.push(action === 'update'
          ? buildNpmUpdatePlan(packageName.replace(/@(?:latest|next|stable)$/i, ''), options)
          : buildNpmUninstallPlan(packageName.replace(/@(?:latest|next|stable)$/i, ''), options));
      }
      continue;
    }
    if (command === 'brew' && args[0] === 'install') {
      const caskIndex = args.indexOf('--cask');
      const packageName = caskIndex >= 0 ? args[caskIndex + 1] : firstPackageArgument(args, 1);
      if (!packageName) continue;
      plans.push(caskIndex >= 0
        ? (action === 'update'
          ? buildCaskUpdatePlan(packageName)
          : buildCaskUninstallPlan(packageName))
        : (action === 'update'
          ? buildBrewFormulaUpdatePlan(packageName)
          : buildBrewFormulaUninstallPlan(packageName)));
      continue;
    }
    if ((command === 'winget' || command === 'winget.exe') && args[0] === 'install') {
      const idIndex = args.findIndex((arg) => arg.toLowerCase() === '--id');
      const packageId = idIndex >= 0 ? args[idIndex + 1] : '';
      if (packageId) {
        plans.push(action === 'update'
          ? buildWingetUpdatePlan(packageId)
          : buildWingetUninstallPlan(packageId));
      }
    }
  }
  return plans.filter(Boolean);
}

function uniquePlans(plans) {
  const seen = new Set();
  return (Array.isArray(plans) ? plans : []).filter((plan) => {
    if (!plan || typeof plan !== 'object') return false;
    const key = `${String(plan.command || '')}\0${JSON.stringify(plan.args || [])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveDeclaredPaths(value, options = {}) {
  const resolved = typeof value === 'function' ? value(options) : value;
  return (Array.isArray(resolved) ? resolved : [resolved])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function resolveHomePaths(value, options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  if (!home) return [];
  const pathImpl = resolvePlatformPath(resolveClientPlatform(options), options.path || require('node:path'));
  return resolveDeclaredPaths(value, options).map((entry) => pathImpl.join(home, entry));
}

function buildCliPathCleanupPlan(provider, cli, options = {}) {
  const files = [];
  const pathImpl = options.path || require('node:path');
  const binaryNames = typeof cli.binaryNames === 'function' ? cli.binaryNames() : cli.binaryNames;
  const names = (Array.isArray(binaryNames) ? binaryNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const installedPath = String(options.installedPath || '').trim();
  if (installedPath) files.push(installedPath);
  const entries = typeof cli.collectPathEntries === 'function'
    ? cli.collectPathEntries(options)
    : [];
  for (const entryValue of Array.isArray(entries) ? entries : []) {
    const entry = String(entryValue || '').trim();
    if (!entry) continue;
    const basename = pathImpl.basename(entry).replace(/\.(?:cmd|exe|ps1)$/i, '');
    if (names.some((name) => name.toLowerCase() === basename.toLowerCase())) {
      files.push(entry);
      continue;
    }
    for (const name of names) {
      files.push(pathImpl.join(entry, name));
      if (resolveClientPlatform(options) === 'windows') {
        files.push(pathImpl.join(entry, `${name}.exe`));
        files.push(pathImpl.join(entry, `${name}.cmd`));
        files.push(pathImpl.join(entry, `${name}.ps1`));
      }
    }
  }
  files.push(...resolveDeclaredPaths(cli.cleanupFiles, options));
  files.push(...resolveHomePaths(cli.cleanupHomeFiles, options));
  const trees = [
    ...resolveDeclaredPaths(cli.cleanupTrees, options),
    ...resolveHomePaths(cli.cleanupHomeTrees, options)
  ];
  return buildManagedPathUninstallPlan({
    id: `${provider}_managed_cli_uninstall`,
    label: `移除 ${provider} CLI 程序文件`,
    files,
    trees,
    options
  });
}

function buildDesktopFallbackPlans(provider, descriptor, options = {}) {
  const platform = resolveClientPlatform(options);
  const plans = [];
  if (platform === 'windows') {
    const displayNames = resolveDeclaredPaths(descriptor.windowsDisplayNames, options);
    if (displayNames.length) {
      plans.push(buildWindowsRegistryUninstallPlan(displayNames, `卸载 ${provider} Desktop`, options));
    }
  }
  if (platform === 'linux') {
    const packageNames = resolveDeclaredPaths(descriptor.linuxPackages, options);
    if (packageNames.length) {
      plans.push(buildLinuxPackageUninstallPlan(packageNames, `卸载 ${provider} Desktop`));
    }
  }

  const record = options.installedRecord && typeof options.installedRecord === 'object'
    ? options.installedRecord
    : {};
  const displayPath = String(record.bundlePath || record.displayPath || '').trim();
  const executablePath = String(record.executablePath || '').trim();
  const files = [
    ...resolveDeclaredPaths(descriptor.cleanupFiles, options),
    ...resolveHomePaths(descriptor.cleanupHomeFiles, options)
  ];
  const trees = [
    ...resolveDeclaredPaths(descriptor.cleanupTrees, options),
    ...resolveHomePaths(descriptor.cleanupHomeTrees, options)
  ];
  if (displayPath) {
    if (/\.app$/i.test(displayPath)) trees.push(displayPath);
    else if (displayPath === executablePath || !executablePath) files.push(displayPath);
  }
  if (executablePath && platform !== 'windows' && !files.includes(executablePath)) files.push(executablePath);
  const cleanup = buildManagedPathUninstallPlan({
    id: `${provider}_managed_desktop_uninstall`,
    label: `移除 ${provider} Desktop 程序文件`,
    files,
    trees,
    options
  });
  if (cleanup) plans.push(cleanup);
  return plans.filter(Boolean);
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
    const explicitPlans = typeof explicit === 'function'
      ? (() => {
          const resolved = explicit(options);
          return (Array.isArray(resolved) ? resolved : []).map(normalizePlan).filter(Boolean);
        })()
      : [];
    if (normalizedAction === 'install') return resolveDesktopInstallPlans(options);
    const installPlans = resolveDesktopInstallPlans(options);
    const cask = descriptor.cask || installPlans
      .find((plan) => plan && plan.command === 'brew' && plan.args && plan.args[0] === 'install' && plan.args[1] === '--cask')
      ?.args?.[2];
    const wingetId = descriptor.wingetId || installPlans
      .find((plan) => plan && plan.command === 'winget.exe' && plan.args && plan.args[0] === 'install')
      ?.args?.[2];
    const inferredPlans = [];
    if (cask) {
      const plan = normalizedAction === 'update'
        ? buildCaskUpdatePlan(cask, `Homebrew 更新 ${normalizedProvider} Desktop`)
        : buildCaskUninstallPlan(cask, `Homebrew 卸载 ${normalizedProvider} Desktop`);
      inferredPlans.push(plan);
    }
    if (wingetId) {
      const plan = normalizedAction === 'update'
        ? buildWingetUpdatePlan(wingetId, `winget 更新 ${normalizedProvider} Desktop`)
        : buildWingetUninstallPlan(wingetId, `winget 卸载 ${normalizedProvider} Desktop`);
      inferredPlans.push(plan);
    }
    if (normalizedAction === 'update') {
      inferredPlans.push(...inferLifecyclePlansFromInstallPlans('update', installPlans, options));
      const updatePlans = uniquePlans([...explicitPlans, ...inferredPlans])
        .map(normalizePlan)
        .filter(Boolean);
      // 官方下载器通常以覆盖安装完成升级；仅在没有专用或可推导更新入口时复用安装计划。
      return updatePlans.length ? updatePlans : installPlans;
    } else if (normalizedAction === 'uninstall') {
      inferredPlans.push(...inferLifecyclePlansFromInstallPlans('uninstall', installPlans, options));
      inferredPlans.push(...buildDesktopFallbackPlans(normalizedProvider, descriptor, options));
    }
    return uniquePlans([...explicitPlans, ...inferredPlans])
      .map(normalizePlan)
      .filter(Boolean);
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
    const normalizedAction = String(action || '').trim().toLowerCase();
    const installPlans = resolveCliInstallPlans(options);
    if (normalizedAction === 'install') return installPlans;
    const explicit = normalizedAction === 'uninstall' && typeof cli.resolveUninstallPlans === 'function'
      ? cli.resolveUninstallPlans(options) || []
      : normalizedAction === 'update' && typeof cli.resolveUpdatePlans === 'function'
        ? cli.resolveUpdatePlans(options) || []
        : [];
    const inferred = inferLifecyclePlansFromInstallPlans(normalizedAction, installPlans, options);
    if (normalizedAction === 'update') {
      const updatePlans = uniquePlans([...explicit, ...inferred]).map(normalizePlan).filter(Boolean);
      return updatePlans.length ? updatePlans : installPlans;
    }
    if (normalizedAction === 'uninstall') {
      const cleanup = buildCliPathCleanupPlan(normalizedProvider, cli, options);
      return uniquePlans([...explicit, ...inferred, cleanup]).map(normalizePlan).filter(Boolean);
    }
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
