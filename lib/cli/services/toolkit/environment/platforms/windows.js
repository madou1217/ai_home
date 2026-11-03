'use strict';

const {
  buildCommandPlan,
  buildNpmGlobalPlan,
  buildPowerShellScriptPlan,
  buildWingetPlan,
  createLifecyclePlan,
  powershellQuote
} = require('../plan-builders');
const {
  buildPoetryInstallerPlan,
  buildSelfUpdatePlan,
  buildWindowsCleanupPlan,
  resolveHome,
  resolvePath
} = require('./shared');

const INSTALLERS = Object.freeze({
  bun: Object.freeze({ url: 'https://bun.sh/install.ps1', hosts: ['bun.sh'] }),
  uv: Object.freeze({ url: 'https://astral.sh/uv/install.ps1', hosts: ['astral.sh'] })
});

function officialPowerShell(toolId, action, name, options = {}) {
  return buildPowerShellScriptPlan(toolId, action, {
    ...INSTALLERS[toolId],
    label: `${action === 'update' ? '更新' : '安装'} ${name}`,
    method: '官方安装器',
    options
  });
}

function buildCondaUpdatePlan(options = {}) {
  const home = resolveHome(options);
  const pathImpl = resolvePath(options, 'windows');
  const condaPath = pathImpl.join(home, 'miniconda3', 'Scripts', 'conda.exe');
  const adapter = require('../../../../../runtime/client-platform').getClientPlatformAdapter('windows');
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || '').trim();
  const powershell = systemRoot
    ? adapter.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : adapter.commands.shell;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$conda = ${powershellQuote(condaPath)}`,
    `if (-not (Test-Path $conda)) { $conda = (Get-Command conda.exe -ErrorAction Stop).Source }`,
    `& $conda update --name base --yes conda`,
    `if ($LASTEXITCODE -ne 0) { throw ('conda update exit ' + $LASTEXITCODE) }`
  ].join('; ');
  return createLifecyclePlan('conda', 'update', powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], {
    id: 'conda_update_base',
    label: '更新 Miniconda',
    method: 'conda',
    effect: '更新 base 环境中的 conda'
  });
}

function buildCondaCleanupPlan(options = {}) {
  const home = resolveHome(options);
  const pathImpl = resolvePath(options, 'windows');
  const condaPath = pathImpl.join(home, 'miniconda3', 'Scripts', 'conda.exe');
  const roots = [
    pathImpl.join(home, 'miniconda3'),
    pathImpl.join(home, 'anaconda3'),
    pathImpl.join(home, '.conda')
  ];
  const adapter = require('../../../../../runtime/client-platform').getClientPlatformAdapter('windows');
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || '').trim();
  const powershell = systemRoot
    ? adapter.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : adapter.commands.shell;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$conda = ${powershellQuote(condaPath)}`,
    `if (Test-Path $conda) { & $conda init --reverse --all | Out-Null }`,
    ...roots.map((target) => `Remove-Item -LiteralPath ${powershellQuote(target)} -Recurse -Force -ErrorAction SilentlyContinue`)
  ].join('; ');
  return createLifecyclePlan('conda', 'uninstall', powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], {
    id: 'conda_uninstall_managed_cleanup',
    label: '卸载 Miniconda',
    method: 'AIH 清理器',
    effect: '撤销 Conda Shell 初始化并移除用户目录下的 Miniconda/Conda 程序目录'
  });
}

function resolveWindowsEnvironmentPlans(toolId, action, options = {}) {
  const name = options.name || toolId;
  if (toolId === 'fnm') {
    if (action === 'uninstall') {
      return [
        buildWingetPlan('fnm', action, 'Schniz.fnm', { name: 'FNM' }),
        buildWindowsCleanupPlan('fnm', 'FNM', options, { files: ['.local/bin/fnm.exe'], trees: ['.local/share/fnm', '.fnm'] })
      ];
    }
    return [buildWingetPlan('fnm', action, 'Schniz.fnm', { name: 'FNM' })];
  }

  if (toolId === 'volta') {
    if (action === 'uninstall') {
      return [
        buildWingetPlan('volta', action, 'Volta.Volta', { name: 'Volta' }),
        buildWindowsCleanupPlan('volta', 'Volta', options, { trees: ['.volta'] })
      ];
    }
    return [buildWingetPlan('volta', action, 'Volta.Volta', { name: 'Volta' })];
  }

  if (toolId === 'pnpm' || toolId === 'yarn') {
    return [buildNpmGlobalPlan(toolId, action, toolId, { ...options, platform: 'windows', name })];
  }

  if (toolId === 'bun') {
    if (action === 'update') return [buildSelfUpdatePlan('bun', 'Bun', 'bun.exe', ['upgrade']), buildWingetPlan('bun', action, 'Oven-sh.Bun', { name: 'Bun' }), officialPowerShell('bun', action, 'Bun', options)];
    if (action === 'uninstall') {
      return [
        buildWingetPlan('bun', action, 'Oven-sh.Bun', { name: 'Bun' }),
        buildWindowsCleanupPlan('bun', 'Bun', options, { trees: ['.bun'] })
      ];
    }
    return [buildWingetPlan('bun', action, 'Oven-sh.Bun', { name: 'Bun' }), officialPowerShell('bun', action, 'Bun', options)];
  }

  if (toolId === 'conda') {
    if (action === 'update') return [buildCondaUpdatePlan(options), buildWingetPlan('conda', action, 'Anaconda.Miniconda3', { name: 'Miniconda' })];
    if (action === 'uninstall') return [buildWingetPlan('conda', action, 'Anaconda.Miniconda3', { name: 'Miniconda' }), buildCondaCleanupPlan(options)];
    return [buildWingetPlan('conda', action, 'Anaconda.Miniconda3', { name: 'Miniconda' })];
  }

  if (toolId === 'uv') {
    if (action === 'update') return [buildSelfUpdatePlan('uv', 'uv', 'uv.exe', ['self', 'update']), buildWingetPlan('uv', action, 'astral-sh.uv', { name: 'uv' }), officialPowerShell('uv', action, 'uv', options)];
    if (action === 'uninstall') {
      return [
        buildWingetPlan('uv', action, 'astral-sh.uv', { name: 'uv' }),
        buildCommandPlan('uv', 'uninstall', 'uv.exe', ['self', 'uninstall'], {
          id: 'uv_self_uninstall',
          label: 'uv 自卸载',
          method: '内置卸载器',
          effect: '卸载 uv'
        }),
        buildWindowsCleanupPlan('uv', 'uv', options, { files: ['.local/bin/uv.exe', '.local/bin/uvx.exe'], trees: ['.local/share/uv'] })
      ];
    }
    return [buildWingetPlan('uv', action, 'astral-sh.uv', { name: 'uv' }), officialPowerShell('uv', action, 'uv', options)];
  }

  if (toolId === 'poetry') {
    if (action === 'update') return [buildSelfUpdatePlan('poetry', 'Poetry', 'poetry.exe', ['self', 'update']), buildPoetryInstallerPlan('install', { ...options, platform: 'windows' })];
    if (action === 'uninstall') return [buildPoetryInstallerPlan('uninstall', { ...options, platform: 'windows' })];
    return [buildPoetryInstallerPlan('install', { ...options, platform: 'windows' })];
  }

  return [];
}

module.exports = {
  resolveWindowsEnvironmentPlans
};
