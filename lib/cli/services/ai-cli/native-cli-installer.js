'use strict';

const CLAUDE_PROVIDER = 'claude';
const CLAUDE_WINDOWS_INSTALL_URL = 'https://claude.ai/install.ps1';

function normalizePlatform(processObj = process) {
  return String(processObj.platform || process.platform || '').trim();
}

function collectNativeCliPathEntries(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim();
  const processObj = options.processObj || process;
  if (normalizedProvider !== CLAUDE_PROVIDER || normalizePlatform(processObj) !== 'win32') return [];
  const pathImpl = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!pathImpl || !hostHomeDir) return [];
  return [pathImpl.join(hostHomeDir, '.local', 'bin')];
}

function resolveWindowsClaudeExecutablePath(options = {}) {
  const pathImpl = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!pathImpl || !hostHomeDir) return '';
  return pathImpl.join(hostHomeDir, '.local', 'bin', 'claude.exe');
}

function resolveWindowsClaudeInstallPlan(options = {}) {
  const processObj = options.processObj || process;
  const systemRoot = String(processObj.env && (processObj.env.SystemRoot || processObj.env.SYSTEMROOT) || '').trim();
  const powershell = systemRoot && options.path
    ? options.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$installer = Invoke-RestMethod -Uri '${CLAUDE_WINDOWS_INSTALL_URL}'`,
    'Invoke-Expression $installer'
  ].join('; ');
  return {
    id: 'claude_windows_native',
    label: 'Claude Code official Windows installer',
    command: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    timeoutMs: 300000
  };
}

function resolveNativeCliInstallPlans(provider, pkg, options = {}) {
  const normalizedProvider = String(provider || '').trim();
  const processObj = options.processObj || process;
  const plans = [];
  if (normalizedProvider === CLAUDE_PROVIDER && normalizePlatform(processObj) === 'win32') {
    plans.push(resolveWindowsClaudeInstallPlan(options));
  }
  if (typeof options.resolveNpmInstall === 'function') {
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

module.exports = {
  CLAUDE_WINDOWS_INSTALL_URL,
  collectNativeCliPathEntries,
  resolveNativeCliInstallPlans,
  resolveWindowsClaudeExecutablePath,
  resolveWindowsClaudeInstallPlan
};
