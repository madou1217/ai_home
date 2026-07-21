'use strict';

const CLAUDE_PROVIDER = 'claude';
const CLAUDE_WINDOWS_INSTALL_URL = 'https://claude.ai/install.ps1';

// Official Qoder install scripts (global vs CN). Primary install path is the
// shell/PowerShell installer; npm is a best-effort fallback for global only.
const QODER_INSTALLERS = Object.freeze({
  qoder: Object.freeze({
    id: 'qoder_global',
    label: 'Qoder CLI (global) official installer',
    bashUrl: 'https://qoder.com/install',
    ps1Url: 'https://qoder.com/install.ps1',
    binaryNames: Object.freeze(['qodercli'])
  }),
  qodercn: Object.freeze({
    id: 'qoder_cn',
    label: 'Qoder CLI CN official installer',
    bashUrl: 'https://qoder.com.cn/install',
    ps1Url: 'https://qoder.com.cn/install.ps1',
    binaryNames: Object.freeze(['qoderclicn'])
  })
});

function normalizePlatform(processObj = process) {
  return String(processObj.platform || process.platform || '').trim();
}

function isQoderProvider(provider) {
  return Object.prototype.hasOwnProperty.call(QODER_INSTALLERS, String(provider || '').trim());
}

function collectNativeCliPathEntries(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim();
  const processObj = options.processObj || process;
  const platform = normalizePlatform(processObj);
  const pathImpl = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!pathImpl || !hostHomeDir) return [];
  const entries = [];
  if (normalizedProvider === CLAUDE_PROVIDER && platform === 'win32') {
    entries.push(pathImpl.join(hostHomeDir, '.local', 'bin'));
  }
  // Qoder's `install` subcommand places entry points under ~/.local/bin (POSIX)
  // and on Windows typically under PATH-visible user dirs; include .local/bin.
  if (isQoderProvider(normalizedProvider)) {
    entries.push(pathImpl.join(hostHomeDir, '.local', 'bin'));
  }
  return entries;
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

function resolveQoderInstallPlan(provider, options = {}) {
  const installer = QODER_INSTALLERS[String(provider || '').trim()];
  if (!installer) return null;
  const processObj = options.processObj || process;
  const platform = normalizePlatform(processObj);
  if (platform === 'win32') {
    const systemRoot = String(processObj.env && (processObj.env.SystemRoot || processObj.env.SYSTEMROOT) || '').trim();
    const powershell = systemRoot && options.path
      ? options.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$installer = Invoke-RestMethod -Uri '${installer.ps1Url}'`,
      'Invoke-Expression $installer'
    ].join('; ');
    return {
      id: `${installer.id}_windows`,
      label: installer.label,
      command: powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      timeoutMs: 300000
    };
  }
  // macOS / Linux / WSL: curl | bash
  return {
    id: `${installer.id}_posix`,
    label: installer.label,
    command: 'bash',
    args: ['-lc', `curl -fsSL '${installer.bashUrl}' | bash`],
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
  if (isQoderProvider(normalizedProvider)) {
    const qoderPlan = resolveQoderInstallPlan(normalizedProvider, options);
    if (qoderPlan) plans.push(qoderPlan);
  }
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

module.exports = {
  CLAUDE_WINDOWS_INSTALL_URL,
  QODER_INSTALLERS,
  collectNativeCliPathEntries,
  resolveNativeCliInstallPlans,
  resolveQoderInstallPlan,
  resolveWindowsClaudeExecutablePath,
  resolveWindowsClaudeInstallPlan
};
