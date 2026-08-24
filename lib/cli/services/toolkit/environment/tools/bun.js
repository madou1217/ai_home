'use strict';

const { buildBrewPlan } = require('../plan-builders');
const {
  buildProfileAwareCleanupPlan,
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
  url: 'https://bun.sh/install',
  hosts: ['bun.sh']
});
const WINDOWS_INSTALLER = Object.freeze({
  url: 'https://bun.sh/install.ps1',
  hosts: ['bun.sh']
});

function buildPosixPlans(action, options) {
  const brewPlan = options.platform === 'macos'
    ? buildBrewPlan('bun', action, 'oven-sh/bun/bun', { name: 'Bun' })
    : null;
  if (action === 'update') {
    return [
      buildSelfUpdatePlan('bun', 'Bun', 'bun', ['upgrade']),
      brewPlan,
      buildOfficialShellPlan('bun', action, 'Bun', POSIX_INSTALLER, options)
    ].filter(Boolean);
  }
  if (action === 'uninstall') {
    const cleanup = buildProfileAwareCleanupPlan(
      'bun',
      'Bun',
      ['BUN_INSTALL', '\\.bun/bin'],
      { trees: ['.bun'] },
      options
    );
    return [brewPlan, cleanup].filter(Boolean);
  }
  return [
    brewPlan,
    buildOfficialShellPlan('bun', action, 'Bun', POSIX_INSTALLER, options)
  ].filter(Boolean);
}

module.exports = defineEnvironmentToolAdapter({
  id: 'bun',
  name: 'Bun',
  runtime: 'node',
  category: 'runtime',
  description: 'JavaScript 运行时与包管理',
  platforms: PLATFORM_IDS,
  probe: { command: 'bun', args: ['--version'] },
  tasks: [
    { id: 'install-dependencies', label: '安装项目依赖', template: 'bun install', category: 'use', parameters: [] },
    { id: 'add-package', label: '添加依赖', template: 'bun add {{package}}', category: 'use', parameters: parameters('package') },
    { id: 'remove-package', label: '移除依赖', template: 'bun remove {{package}}', category: 'uninstall', parameters: parameters('package') },
    { id: 'run-script', label: '运行脚本', template: 'bun run {{script}}', category: 'use', parameters: parameters('script') }
  ],
  detect: commandDetector('bun'),
  buildPlans(action, options = {}) {
    if (options.platform !== 'windows') return buildPosixPlans(action, options);
    if (action === 'update') {
      return [
        buildSelfUpdatePlan('bun', 'Bun', 'bun.exe', ['upgrade']),
        wingetPlan('bun', 'Bun', action, 'Oven-sh.Bun'),
        buildOfficialPowerShellPlan('bun', action, 'Bun', WINDOWS_INSTALLER, options)
      ];
    }
    if (action === 'uninstall') {
      return [
        wingetPlan('bun', 'Bun', action, 'Oven-sh.Bun'),
        buildWindowsCleanupPlan('bun', 'Bun', options, { trees: ['.bun'] })
      ];
    }
    return [
      wingetPlan('bun', 'Bun', action, 'Oven-sh.Bun'),
      buildOfficialPowerShellPlan('bun', action, 'Bun', WINDOWS_INSTALLER, options)
    ];
  }
});
