'use strict';

const {
  CLAUDE_PROVIDER,
  CLAUDE_WINDOWS_INSTALL_URL,
  QODER_REGIONS,
  collectStrategyPathEntries,
  resolveStrategyInstallPlans,
  listStrategyBinaryNames,
  buildWindowsPs1Plan,
  buildPosixCurlBashPlan,
  findInstallStrategy
} = require('./native-cli-install-strategies');

const QODER_INSTALLERS = QODER_REGIONS;

function normalizePlatform(processObj = process) {
  return String(processObj.platform || process.platform || '').trim();
}

function isQoderProvider(provider) {
  const key = String(provider || '').trim();
  return key === 'qoder' || key === 'qodercn';
}

function collectNativeCliPathEntries(provider, options = {}) {
  return collectStrategyPathEntries(provider, options);
}

function resolveWindowsClaudeExecutablePath(options = {}) {
  const pathImpl = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!pathImpl || !hostHomeDir) return '';
  return pathImpl.join(hostHomeDir, '.local', 'bin', 'claude.exe');
}

function resolveWindowsClaudeInstallPlan(options = {}) {
  return buildWindowsPs1Plan(
    'claude_windows_native',
    'Claude Code official Windows installer',
    CLAUDE_WINDOWS_INSTALL_URL,
    options
  );
}

function resolveQoderInstallPlan(provider, options = {}) {
  const plans = resolveStrategyInstallPlans(provider, '', options);
  return plans[0] || null;
}

function resolveNativeCliInstallPlans(provider, pkg, options = {}) {
  const normalizedProvider = String(provider || '').trim();
  const plans = [...resolveStrategyInstallPlans(normalizedProvider, pkg, options)];

  // Generic npm fallback when a package is declared (Open/Closed for non-strategy
  // providers and as secondary plan after strategy-native installers).
  if (typeof options.resolveNpmInstall === 'function' && String(pkg || '').trim()) {
    const npmPlan = options.resolveNpmInstall(pkg);
    if (npmPlan) {
      plans.push({
        id: 'npm_global',
        label: 'npm global installer',
        command: npmPlan.command,
        args: npmPlan.args,
        timeoutMs: 120000
      });
    }
  }
  return plans;
}

function listProviderBinaryNames(provider, options = {}) {
  const names = listStrategyBinaryNames(provider, options);
  if (names.length) return names;
  const fallback = String(provider || '').trim();
  return fallback ? [fallback] : [];
}

module.exports = {
  CLAUDE_WINDOWS_INSTALL_URL,
  QODER_INSTALLERS,
  collectNativeCliPathEntries,
  resolveNativeCliInstallPlans,
  resolveQoderInstallPlan,
  resolveWindowsClaudeExecutablePath,
  resolveWindowsClaudeInstallPlan,
  listProviderBinaryNames,
  isQoderProvider,
  findInstallStrategy,
  normalizePlatform
};
