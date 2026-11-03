'use strict';

// 这里故意不维护 Provider 安装参数。每个 Provider 的安装计划位于
// lib/server/app-installers/<provider>.js，由注册表按 Provider 身份分派。
const { getAppInstaller } = require('../../../server/app-installers');

function resolveDesktopInstallPlans(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (typeof options.resolveDesktopInstallPlans === 'function') {
    const custom = options.resolveDesktopInstallPlans(normalizedProvider, options);
    return Array.isArray(custom) ? custom : [];
  }
  const installer = getAppInstaller(normalizedProvider);
  if (!installer || typeof installer.resolveDesktopInstallPlans !== 'function') return [];
  return installer.resolveDesktopInstallPlans(options) || [];
}

function hasDesktopInstallPlan(provider, options = {}) {
  return resolveDesktopInstallPlans(provider, options).length > 0;
}

function buildDesktopInstallHint(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const installer = getAppInstaller(normalizedProvider);
  if (installer && typeof installer.buildDesktopInstallHint === 'function') {
    return installer.buildDesktopInstallHint(options);
  }
  return '当前 Provider 没有可用的桌面安装器，请手动安装官方 Desktop 应用后重试。';
}

module.exports = {
  buildDesktopInstallHint,
  hasDesktopInstallPlan,
  resolveDesktopInstallPlans
};
