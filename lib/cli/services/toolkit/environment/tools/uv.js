'use strict';

const { buildBrewPlan, buildCommandPlan } = require('../plan-builders');
const {
  buildHomeCleanupPlan,
  buildSelfUpdatePlan,
  buildWindowsCleanupPlan
} = require('../platforms/shared');
const { defineEnvironmentToolAdapter, parameters, PLATFORM_IDS } = require('./adapter');
const {
  buildOfficialPowerShellPlan,
  buildOfficialShellPlan,
  commandDetector,
  wingetPlan
} = require('./shared');

const POSIX_INSTALLER = Object.freeze({
  url: 'https://astral.sh/uv/install.sh',
  hosts: ['astral.sh']
});
const WINDOWS_INSTALLER = Object.freeze({
  url: 'https://astral.sh/uv/install.ps1',
  hosts: ['astral.sh']
});

function buildPosixPlans(action, options) {
  const brewPlan = options.platform === 'macos'
    ? buildBrewPlan('uv', action, 'uv', { name: 'uv' })
    : null;
  if (action === 'update') {
    return [
      buildSelfUpdatePlan('uv', 'uv', 'uv', ['self', 'update']),
      brewPlan,
      buildOfficialShellPlan('uv', action, 'uv', POSIX_INSTALLER, options)
    ].filter(Boolean);
  }
  if (action === 'uninstall') {
    return [
      brewPlan,
      buildCommandPlan('uv', 'uninstall', 'uv', ['self', 'uninstall'], {
        id: 'uv_self_uninstall',
        label: 'uv 自卸载',
        method: '内置卸载器',
        effect: '卸载 uv'
      }),
      buildHomeCleanupPlan('uv', 'uv', options, {
        files: ['.local/bin/uv', '.local/bin/uvx'],
        trees: ['.local/share/uv']
      })
    ].filter(Boolean);
  }
  return [
    brewPlan,
    buildOfficialShellPlan('uv', action, 'uv', POSIX_INSTALLER, options)
  ].filter(Boolean);
}

module.exports = defineEnvironmentToolAdapter({
  id: 'uv',
  name: 'uv',
  runtime: 'python',
  category: 'package-manager',
  description: 'Python 包与虚拟环境管理',
  platforms: PLATFORM_IDS,
  probe: { command: 'uv', args: ['--version'] },
  tasks: [
    { id: 'create-venv', label: '创建虚拟环境', template: 'uv venv {{environmentPath}}', category: 'install', parameters: parameters('environmentPath') },
    { id: 'add-package', label: '安装包', template: 'uv pip install {{package}}', category: 'use', parameters: parameters('package') },
    { id: 'run-script', label: '运行脚本', template: 'uv run {{script}}', category: 'use', parameters: parameters('script') }
  ],
  detect: commandDetector('uv'),
  buildPlans(action, options = {}) {
    if (options.platform !== 'windows') return buildPosixPlans(action, options);
    if (action === 'update') {
      return [
        buildSelfUpdatePlan('uv', 'uv', 'uv.exe', ['self', 'update']),
        wingetPlan('uv', 'uv', action, 'astral-sh.uv'),
        buildOfficialPowerShellPlan('uv', action, 'uv', WINDOWS_INSTALLER, options)
      ];
    }
    if (action === 'uninstall') {
      return [
        wingetPlan('uv', 'uv', action, 'astral-sh.uv'),
        buildCommandPlan('uv', 'uninstall', 'uv.exe', ['self', 'uninstall'], {
          id: 'uv_self_uninstall',
          label: 'uv 自卸载',
          method: '内置卸载器',
          effect: '卸载 uv'
        }),
        buildWindowsCleanupPlan('uv', 'uv', options, {
          files: ['.local/bin/uv.exe', '.local/bin/uvx.exe'],
          trees: ['.local/share/uv']
        })
      ];
    }
    return [
      wingetPlan('uv', 'uv', action, 'astral-sh.uv'),
      buildOfficialPowerShellPlan('uv', action, 'uv', WINDOWS_INSTALLER, options)
    ];
  }
});
