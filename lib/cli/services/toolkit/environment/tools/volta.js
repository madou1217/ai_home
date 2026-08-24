'use strict';

const { buildBrewPlan } = require('../plan-builders');
const {
  buildProfileAwareCleanupPlan,
  buildWindowsCleanupPlan
} = require('../platforms/shared');
const { defineEnvironmentToolAdapter, parameters, PLATFORM_IDS } = require('./adapter');
const {
  buildOfficialShellPlan,
  commandDetector,
  wingetPlan
} = require('./shared');

const INSTALLER = Object.freeze({
  url: 'https://get.volta.sh',
  hosts: ['get.volta.sh']
});

module.exports = defineEnvironmentToolAdapter({
  id: 'volta',
  name: 'Volta',
  runtime: 'node',
  category: 'version-manager',
  description: '项目级 Node.js 工具链固定',
  platforms: PLATFORM_IDS,
  probe: { command: 'volta', args: ['--version'] },
  tasks: [
    { id: 'install-node', label: '安装 Node.js 版本', template: 'volta install node@{{version}}', category: 'install', parameters: parameters('version') },
    { id: 'pin-node', label: '固定项目 Node.js 版本', template: 'volta pin node@{{version}}', category: 'configure', parameters: parameters('version') },
    { id: 'list-tools', label: '查看已管理工具', template: 'volta list', category: 'inspect', parameters: [] }
  ],
  detect: commandDetector('volta'),
  buildPlans(action, options = {}) {
    if (options.platform === 'windows') {
      const plans = [wingetPlan('volta', 'Volta', action, 'Volta.Volta')];
      if (action === 'uninstall') {
        plans.push(buildWindowsCleanupPlan('volta', 'Volta', options, { trees: ['.volta'] }));
      }
      return plans;
    }
    if (action === 'uninstall') {
      const cleanup = buildProfileAwareCleanupPlan(
        'volta',
        'Volta',
        ['VOLTA_HOME', '\\.volta/bin'],
        { trees: ['.volta'] },
        options
      );
      return options.platform === 'macos'
        ? [buildBrewPlan('volta', action, 'volta', { name: 'Volta' }), cleanup]
        : [cleanup];
    }
    const official = buildOfficialShellPlan('volta', action, 'Volta', INSTALLER, options);
    return options.platform === 'macos'
      ? [buildBrewPlan('volta', action, 'volta', { name: 'Volta' }), official]
      : [official];
  }
});
