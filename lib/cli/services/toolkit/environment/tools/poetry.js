'use strict';

const { getClientPlatformAdapter } = require('../../../../../runtime/client-platform');
const {
  buildBrewPlan,
  createLifecyclePlan,
  powershellQuote,
  shellQuote
} = require('../plan-builders');
const { buildSelfUpdatePlan } = require('../platforms/shared');
const { defineEnvironmentToolAdapter, parameters, PLATFORM_IDS } = require('./adapter');
const { commandDetector } = require('./shared');

function buildInstallerPlan(action, options = {}) {
  const python = options.platform === 'windows' ? 'py.exe' : 'python3';
  const scriptUrl = 'https://install.python-poetry.org';
  if (options.platform === 'windows') {
    const adapter = getClientPlatformAdapter('windows');
    const processObj = options.processObj || process;
    const env = processObj.env || {};
    const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || '').trim();
    const powershell = systemRoot
      ? adapter.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : adapter.commands.shell;
    const installerArgs = action === 'uninstall' ? ', "--uninstall"' : '';
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$dest = Join-Path $env:TEMP ('aih-poetry-' + [guid]::NewGuid().ToString('n') + '.py')`,
      `Invoke-WebRequest -Uri ${powershellQuote(scriptUrl)} -OutFile $dest -UseBasicParsing`,
      `try { & ${python} $dest${installerArgs} } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
    ].join('; ');
    return createLifecyclePlan('poetry', action, powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], {
      id: `poetry_${action}_official_installer`,
      label: `${action === 'uninstall' ? '卸载' : '安装'} Poetry`,
      method: 'Poetry 官方安装器',
      effect: `${action === 'uninstall' ? '卸载' : '安装'} Poetry`
    });
  }
  const script = [
    'set -euo pipefail',
    'tmp="$(mktemp -t aih-poetry.XXXXXX)"',
    'trap \'rm -f "$tmp"\' EXIT',
    `curl --compressed -fsSL ${shellQuote(scriptUrl)} -o "$tmp"`,
    `${python} "$tmp"${action === 'uninstall' ? ' --uninstall' : ''}`
  ].join('; ');
  return createLifecyclePlan('poetry', action, 'bash', ['-c', script], {
    id: `poetry_${action}_official_installer`,
    label: `${action === 'uninstall' ? '卸载' : '安装'} Poetry`,
    method: 'Poetry 官方安装器',
    effect: `${action === 'uninstall' ? '卸载' : '安装'} Poetry`
  });
}

module.exports = defineEnvironmentToolAdapter({
  id: 'poetry',
  name: 'Poetry',
  runtime: 'python',
  category: 'package-manager',
  description: 'Python 依赖与打包管理',
  platforms: PLATFORM_IDS,
  probe: { command: 'poetry', args: ['--version'] },
  tasks: [
    { id: 'install-dependencies', label: '安装项目依赖', template: 'poetry install', category: 'use', parameters: [] },
    { id: 'add-package', label: '添加依赖', template: 'poetry add {{package}}', category: 'use', parameters: parameters('package') },
    { id: 'remove-package', label: '移除依赖', template: 'poetry remove {{package}}', category: 'uninstall', parameters: parameters('package') },
    { id: 'run-script', label: '运行脚本', template: 'poetry run python {{script}}', category: 'use', parameters: parameters('script') }
  ],
  detect: commandDetector('poetry'),
  buildPlans(action, options = {}) {
    const installerAction = action === 'uninstall' ? 'uninstall' : 'install';
    const installer = buildInstallerPlan(installerAction, options);
    if (options.platform !== 'macos') {
      return action === 'update'
        ? [buildSelfUpdatePlan('poetry', 'Poetry', options.platform === 'windows' ? 'poetry.exe' : 'poetry', ['self', 'update']), installer]
        : [installer];
    }
    const brew = buildBrewPlan('poetry', action, 'poetry', { name: 'Poetry' });
    return action === 'update'
      ? [buildSelfUpdatePlan('poetry', 'Poetry', 'poetry', ['self', 'update']), brew, installer]
      : [brew, installer];
  }
});
