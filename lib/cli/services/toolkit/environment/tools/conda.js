'use strict';

const { getClientPlatformAdapter } = require('../../../../../runtime/client-platform');
const {
  buildBrewPlan,
  createLifecyclePlan,
  powershellQuote,
  shellQuote
} = require('../plan-builders');
const {
  buildCondaCleanupPlan: buildPosixCondaCleanupPlan,
  resolveHome,
  resolvePath
} = require('../platforms/shared');
const { probeConda } = require('../probe');
const { defineEnvironmentToolAdapter, parameters, PLATFORM_IDS } = require('./adapter');
const { wingetPlan } = require('./shared');

function windowsPowerShell(options = {}) {
  const adapter = getClientPlatformAdapter('windows');
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || '').trim();
  return systemRoot
    ? adapter.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : adapter.commands.shell;
}

function buildPosixInstallPlan(action, options = {}) {
  const home = resolveHome(options);
  const platform = options.platform;
  const assetSelection = platform === 'macos'
    ? 'case "$arch" in arm64) asset="Miniconda3-latest-MacOSX-arm64.sh" ;; x86_64) asset="Miniconda3-latest-MacOSX-x86_64.sh" ;; *) echo "不支持的 macOS 架构: $arch" >&2; exit 64 ;; esac'
    : 'case "$arch" in x86_64|amd64) asset="Miniconda3-latest-Linux-x86_64.sh" ;; aarch64|arm64) asset="Miniconda3-latest-Linux-aarch64.sh" ;; *) echo "不支持的 Linux 架构: $arch" >&2; exit 64 ;; esac';
  const mktemp = platform === 'macos'
    ? 'tmp="$(mktemp -t aih-miniconda.XXXXXX)"'
    : 'tmp="$(mktemp --suffix=.sh aih-miniconda.XXXXXX)"';
  const script = [
    'set -euo pipefail',
    'arch="$(uname -m)"',
    assetSelection,
    'url="https://repo.anaconda.com/miniconda/$asset"',
    mktemp,
    'trap \'rm -f "$tmp"\' EXIT',
    'curl --compressed -fsSL "$url" -o "$tmp"',
    `bash "$tmp" -b -u -p ${shellQuote(`${home}/miniconda3`)}`
  ].join('\n');
  return createLifecyclePlan('conda', action, 'bash', ['-c', script], {
    id: `conda_${action}_official_installer`,
    label: `${action === 'update' ? '更新' : '安装'} Miniconda`,
    method: 'Miniconda 官方安装器',
    effect: `${action === 'update' ? '覆盖更新' : '安装'} Miniconda 到用户目录`
  });
}

function buildPosixUpdatePlan(options = {}) {
  const home = resolveHome(options);
  const script = [
    'set -e',
    `conda_bin=${shellQuote(`${home}/miniconda3/bin/conda`)}`,
    'if [ ! -x "$conda_bin" ]; then conda_bin="$(command -v conda)"; fi',
    '"$conda_bin" update --name base --yes conda'
  ].join('\n');
  return createLifecyclePlan('conda', 'update', 'bash', ['-c', script], {
    id: 'conda_update_base',
    label: '更新 Miniconda',
    method: 'conda',
    effect: '更新 base 环境中的 conda'
  });
}

function windowsCondaPath(options = {}) {
  return resolvePath(options, 'windows').join(resolveHome(options), 'miniconda3', 'Scripts', 'conda.exe');
}

function buildWindowsUpdatePlan(options = {}) {
  const powershell = windowsPowerShell(options);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$conda = ${powershellQuote(windowsCondaPath(options))}`,
    'if (-not (Test-Path $conda)) { $conda = (Get-Command conda.exe -ErrorAction Stop).Source }',
    '& $conda update --name base --yes conda',
    "if ($LASTEXITCODE -ne 0) { throw ('conda update exit ' + $LASTEXITCODE) }"
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

function buildWindowsCleanupPlan(options = {}) {
  const home = resolveHome(options);
  const pathImpl = resolvePath(options, 'windows');
  const powershell = windowsPowerShell(options);
  const roots = [
    pathImpl.join(home, 'miniconda3'),
    pathImpl.join(home, 'anaconda3'),
    pathImpl.join(home, '.conda')
  ];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$conda = ${powershellQuote(windowsCondaPath(options))}`,
    'if (Test-Path $conda) { & $conda init --reverse --all | Out-Null }',
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

module.exports = defineEnvironmentToolAdapter({
  id: 'conda',
  name: 'Miniconda',
  runtime: 'python',
  category: 'environment-manager',
  description: 'Python 环境与依赖管理',
  platforms: PLATFORM_IDS,
  probe: { kind: 'conda' },
  tasks: [
    { id: 'create-environment', label: '创建环境', template: 'conda create -n {{environment}} python={{version}}', category: 'install', parameters: parameters('environment', 'version') },
    { id: 'activate-environment', label: '激活环境', template: 'conda activate {{environment}}', category: 'use', parameters: parameters('environment') },
    { id: 'list-environments', label: '查看环境', template: 'conda env list', category: 'inspect', parameters: [] },
    { id: 'remove-environment', label: '删除环境', template: 'conda env remove -n {{environment}}', category: 'uninstall', parameters: parameters('environment') }
  ],
  detect: probeConda,
  buildPlans(action, options = {}) {
    if (options.platform === 'windows') {
      if (action === 'update') {
        return [buildWindowsUpdatePlan(options), wingetPlan('conda', 'Miniconda', action, 'Anaconda.Miniconda3')];
      }
      if (action === 'uninstall') {
        return [wingetPlan('conda', 'Miniconda', action, 'Anaconda.Miniconda3'), buildWindowsCleanupPlan(options)];
      }
      return [wingetPlan('conda', 'Miniconda', action, 'Anaconda.Miniconda3')];
    }
    const installer = buildPosixInstallPlan(action, options);
    if (options.platform === 'macos') {
      const brew = buildBrewPlan('conda', action, 'miniconda', { name: 'Miniconda', cask: true });
      if (action === 'update') return [buildPosixUpdatePlan(options), brew, installer];
      if (action === 'uninstall') return [brew, buildPosixCondaCleanupPlan(options)];
      return [brew, installer];
    }
    if (action === 'update') return [buildPosixUpdatePlan(options), installer];
    if (action === 'uninstall') return [buildPosixCondaCleanupPlan(options)];
    return [installer];
  }
});
