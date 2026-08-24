'use strict';

const { buildManagedPathCleanupPlan } = require('../../../../runtime/managed-path-cleaner');
const { getClientPlatformAdapter } = require('../../../../runtime/client-platform');

function createLifecyclePlan(toolId, action, command, args = [], options = {}) {
  return {
    id: String(options.id || `${toolId}_${action}`).trim(),
    toolId: String(toolId || '').trim().toLowerCase(),
    action: String(action || '').trim().toLowerCase(),
    label: String(options.label || '').trim(),
    method: String(options.method || '').trim(),
    command: String(command || '').trim(),
    args: Array.isArray(args) ? args.map((arg) => String(arg)) : [],
    env: options.env && typeof options.env === 'object' ? { ...options.env } : {},
    cwd: String(options.cwd || '').trim() || null,
    effect: String(options.effect || '').trim(),
    timeoutMs: Math.min(Math.max(Number(options.timeoutMs) || 30 * 60 * 1000, 1000), 60 * 60 * 1000),
    requiresConfirmation: true
  };
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function assertHttpsUrl(value, allowedHosts = []) {
  const url = new URL(String(value || '').trim());
  const hosts = (Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts])
    .map((host) => String(host || '').trim().toLowerCase())
    .filter(Boolean);
  if (url.protocol !== 'https:') throw new Error('environment_installer_requires_https');
  if (hosts.length && !hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error(`environment_installer_host_not_allowed:${url.hostname}`);
  }
  return url.toString();
}

function buildShellScriptPlan(toolId, action, { url, hosts, label, method, options = {} }) {
  const sourceUrl = assertHttpsUrl(url, hosts);
  const script = [
    'set -euo pipefail',
    'tmp="$(mktemp -t aih-env-install.XXXXXX)"',
    'trap \'rm -f "$tmp"\' EXIT',
    `curl --compressed -fsSL ${shellQuote(sourceUrl)} -o "$tmp"`,
    'bash "$tmp"'
  ].join('; ');
  return createLifecyclePlan(toolId, action, 'bash', ['-c', script], {
    id: `${toolId}_${action}_official_script`,
    label,
    method,
    effect: `${label}`,
    ...options
  });
}

function buildPowerShellScriptPlan(toolId, action, { url, hosts, label, method, options = {} }) {
  const sourceUrl = assertHttpsUrl(url, hosts);
  const adapter = getClientPlatformAdapter('windows');
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || '').trim();
  const powershell = systemRoot
    ? adapter.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : adapter.commands.shell;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$dest = Join-Path $env:TEMP ('aih-env-' + [guid]::NewGuid().ToString('n') + '.ps1')`,
    `Invoke-WebRequest -Uri ${powershellQuote(sourceUrl)} -OutFile $dest -UseBasicParsing`,
    'try { & $dest } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }'
  ].join('; ');
  return createLifecyclePlan(toolId, action, powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    id: `${toolId}_${action}_official_script`,
    label,
    method,
    effect: `${label}`,
    ...options
  });
}

function buildBrewPlan(toolId, action, packageName, options = {}) {
  const argsByAction = {
    install: ['install', ...(options.cask ? ['--cask'] : []), packageName],
    update: ['upgrade', ...(options.cask ? ['--cask'] : []), packageName],
    uninstall: ['uninstall', ...(options.cask ? ['--cask'] : []), packageName]
  };
  const labelAction = { install: '安装', update: '更新', uninstall: '卸载' }[action];
  return createLifecyclePlan(toolId, action, 'brew', argsByAction[action], {
    id: `${toolId}_${action}_homebrew`,
    label: `Homebrew ${labelAction} ${options.name || toolId}`,
    method: 'Homebrew',
    effect: `${labelAction}${options.name || toolId}`
  });
}

function buildWingetPlan(toolId, action, packageId, options = {}) {
  const argsByAction = {
    install: ['install', '--id', packageId, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'],
    update: ['upgrade', '--id', packageId, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'],
    uninstall: ['uninstall', '--id', packageId, '--exact']
  };
  const labelAction = { install: '安装', update: '更新', uninstall: '卸载' }[action];
  return createLifecyclePlan(toolId, action, 'winget.exe', argsByAction[action], {
    id: `${toolId}_${action}_winget`,
    label: `WinGet ${labelAction} ${options.name || toolId}`,
    method: 'WinGet',
    effect: `${labelAction}${options.name || toolId}`
  });
}

function buildNpmGlobalPlan(toolId, action, packageName, options = {}) {
  const adapter = getClientPlatformAdapter(options.platform || process.platform);
  const command = adapter && adapter.commands.npm || 'npm';
  const userConfig = options.platform === 'windows' ? 'NUL' : '/dev/null';
  const argsByAction = {
    install: ['install', '--global', `${packageName}@latest`],
    update: ['install', '--global', `${packageName}@latest`],
    uninstall: ['uninstall', '--global', packageName]
  };
  const labelAction = { install: '安装', update: '更新', uninstall: '卸载' }[action];
  return createLifecyclePlan(toolId, action, command, [
    ...argsByAction[action],
    `--userconfig=${userConfig}`,
    '--registry=https://registry.npmjs.org'
  ], {
    id: `${toolId}_${action}_npm`,
    label: `npm ${labelAction} ${options.name || toolId}`,
    method: 'npm',
    effect: `${labelAction}${options.name || toolId}`
  });
}

function buildCommandPlan(toolId, action, command, args, options = {}) {
  return createLifecyclePlan(toolId, action, command, args, options);
}

function buildCleanupPlan(toolId, options = {}) {
  const plan = buildManagedPathCleanupPlan({
    id: `${toolId}_uninstall_managed_cleanup`,
    label: options.label || `移除 ${options.name || toolId} 程序文件`,
    files: options.files || [],
    trees: options.trees || [],
    options: options.runtimeOptions || options
  });
  if (!plan) return null;
  return createLifecyclePlan(toolId, 'uninstall', plan.command, plan.args, {
    id: plan.id,
    label: plan.label,
    method: 'AIH 清理器',
    effect: options.effect || plan.label,
    timeoutMs: plan.timeoutMs
  });
}

function quoteForPreview(value, platform) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return platform === 'windows'
    ? `"${text.replace(/"/g, '\\"')}"`
    : shellQuote(text);
}

function renderPlanCommand(plan, platform) {
  return [plan.command, ...(plan.args || [])]
    .map((part) => quoteForPreview(part, platform))
    .join(' ');
}

module.exports = {
  assertHttpsUrl,
  buildBrewPlan,
  buildCleanupPlan,
  buildCommandPlan,
  buildNpmGlobalPlan,
  buildPowerShellScriptPlan,
  buildShellScriptPlan,
  buildWingetPlan,
  createLifecyclePlan,
  powershellQuote,
  renderPlanCommand,
  shellQuote
};
