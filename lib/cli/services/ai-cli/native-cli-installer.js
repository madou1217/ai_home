'use strict';

const { getAppInstaller } = require('../../../server/app-installers');
const { CLIENT_PLATFORMS } = require('../../../runtime/client-platform');

function getProviderInstaller(provider) {
  return getAppInstaller(String(provider || '').trim().toLowerCase());
}

// 保留 Claude 原生二进制修复模块使用的窄兼容接口；实际安装计划仍由
// app-installers/claude.js 独立声明，避免在这里重新维护 Provider 事实。
function resolveWindowsClaudeExecutablePath(options = {}) {
  const pathImpl = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!pathImpl || !hostHomeDir) return '';
  return pathImpl.join(hostHomeDir, '.local', 'bin', 'claude.exe');
}

function resolveWindowsClaudeInstallPlan(options = {}) {
  const installer = getProviderInstaller('claude');
  const plans = installer && typeof installer.resolveCliInstallPlans === 'function'
    ? installer.resolveCliInstallPlans({
      ...options,
      platform: CLIENT_PLATFORMS.WINDOWS,
      processObj: options.processObj || { platform: 'win32' }
    })
    : [];
  const plan = plans.find((candidate) => candidate && candidate.id === 'claude_windows_official')
    || plans[0];
  if (plan) {
    return {
      ...plan,
      id: 'claude_windows_native',
      installUrl: 'https://claude.ai/install.ps1'
    };
  }
  throw new Error('Claude Windows official install plan is unavailable');
}

function collectNativeCliPathEntries(provider, options = {}) {
  const installer = getProviderInstaller(provider);
  if (!installer || typeof installer.collectCliPathEntries !== 'function') return [];
  return installer.collectCliPathEntries(options).filter(Boolean);
}

function resolveNativeCliInstallPlans(provider, pkg, options = {}) {
  const installer = getProviderInstaller(provider);
  if (installer && typeof installer.resolveCliInstallPlans === 'function') {
    const plans = installer.resolveCliInstallPlans(options);
    if (Array.isArray(plans) && plans.length > 0) return plans.filter(Boolean);
  }
  const packageName = String(pkg || '').trim();
  if (packageName && typeof options.resolveNpmInstall === 'function') {
    const npmPlan = options.resolveNpmInstall(packageName);
    if (npmPlan) {
      return [{
        id: 'npm_global',
        label: 'npm 全局安装',
        command: npmPlan.command,
        args: npmPlan.args,
        timeoutMs: 120000
      }];
    }
  }
  return [];
}

function listProviderBinaryNames(provider) {
  const installer = getProviderInstaller(provider);
  if (installer && typeof installer.listCliBinaryNames === 'function') {
    const names = installer.listCliBinaryNames();
    if (Array.isArray(names) && names.length > 0) return names;
  }
  const fallback = String(provider || '').trim();
  return fallback ? [fallback] : [];
}

module.exports = {
  collectNativeCliPathEntries,
  resolveNativeCliInstallPlans,
  listProviderBinaryNames,
  resolveWindowsClaudeExecutablePath,
  resolveWindowsClaudeInstallPlan
};
