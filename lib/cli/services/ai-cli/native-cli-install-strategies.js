'use strict';

// 兼容旧调用方的适配层。Provider 安装计划、二进制别名和额外 PATH 均由
// lib/server/app-installers/<provider>.js 独立声明；这里不再维护 Provider
// 名称数组或第二份安装策略注册表。

function getInstaller(provider) {
  try {
    return require('../../../server/app-installers').getAppInstaller(provider);
  } catch (_error) {
    return null;
  }
}

function createStrategy(provider, installer) {
  if (!installer) return null;
  const normalized = String(provider || '').trim().toLowerCase();
  return Object.freeze({
    name: normalized,
    matches(value) {
      return String(value || '').trim().toLowerCase() === normalized;
    },
    collectPathEntries(_value, options = {}) {
      return typeof installer.collectCliPathEntries === 'function'
        ? installer.collectCliPathEntries(options)
        : [];
    },
    resolveInstallPlans(_value, _pkg, options = {}) {
      return typeof installer.resolveCliInstallPlans === 'function'
        ? installer.resolveCliInstallPlans(options)
        : [];
    },
    binaryNames: typeof installer.listCliBinaryNames === 'function'
      ? installer.listCliBinaryNames()
      : []
  });
}

function listInstallStrategies(options = {}) {
  // Tests and embedders may still inject explicit strategies. Production code
  // resolves the requested provider lazily and therefore remains open for new files.
  return Array.isArray(options.strategies) ? options.strategies : [];
}

function findInstallStrategy(provider, options = {}) {
  const normalized = String(provider || '').trim().toLowerCase();
  const injected = listInstallStrategies(options).find((strategy) => (
    strategy && typeof strategy.matches === 'function' && strategy.matches(normalized)
  ));
  if (injected) return injected;
  return createStrategy(normalized, getInstaller(normalized));
}

function collectStrategyPathEntries(provider, options = {}) {
  const strategy = findInstallStrategy(provider, options);
  if (!strategy || typeof strategy.collectPathEntries !== 'function') return [];
  return (strategy.collectPathEntries(provider, options) || []).filter(Boolean);
}

function resolveStrategyInstallPlans(provider, pkg, options = {}) {
  const strategy = findInstallStrategy(provider, options);
  if (!strategy || typeof strategy.resolveInstallPlans !== 'function') return [];
  return (strategy.resolveInstallPlans(provider, pkg, options) || []).filter(Boolean);
}

function listStrategyBinaryNames(provider, options = {}) {
  const strategy = findInstallStrategy(provider, options);
  return strategy && Array.isArray(strategy.binaryNames)
    ? strategy.binaryNames.map((name) => String(name || '').trim()).filter(Boolean)
    : [];
}

module.exports = {
  listInstallStrategies,
  findInstallStrategy,
  collectStrategyPathEntries,
  resolveStrategyInstallPlans,
  listStrategyBinaryNames
};
