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
  url: 'https://fnm.vercel.app/install',
  hosts: ['fnm.vercel.app']
});

module.exports = defineEnvironmentToolAdapter({
  id: 'fnm',
  name: 'FNM',
  runtime: 'node',
  category: 'version-manager',
  description: '快速 Node.js 多版本管理',
  platforms: PLATFORM_IDS,
  probe: { command: 'fnm', args: ['--version'] },
  tasks: [
    { id: 'install-version', label: '安装 Node.js 版本', template: 'fnm install {{version}}', category: 'install', parameters: parameters('version') },
    { id: 'use-version', label: '切换当前 Shell 版本', template: 'fnm use {{version}}', category: 'use', parameters: parameters('version') },
    { id: 'default-version', label: '设置默认版本', template: 'fnm default {{version}}', category: 'configure', parameters: parameters('version') },
    { id: 'list-versions', label: '查看已安装版本', template: 'fnm list', category: 'inspect', parameters: [] },
    { id: 'remove-version', label: '卸载 Node.js 版本', template: 'fnm uninstall {{version}}', category: 'uninstall', parameters: parameters('version') }
  ],
  detect: commandDetector('fnm'),
  buildPlans(action, options = {}) {
    if (options.platform === 'windows') {
      const plans = [wingetPlan('fnm', 'FNM', action, 'Schniz.fnm')];
      if (action === 'uninstall') {
        plans.push(buildWindowsCleanupPlan('fnm', 'FNM', options, {
          files: ['.local/bin/fnm.exe'],
          trees: ['.local/share/fnm', '.fnm']
        }));
      }
      return plans;
    }
    if (action === 'uninstall') {
      const cleanup = buildProfileAwareCleanupPlan('fnm', 'FNM', ['fnm env', 'FNM_DIR'], {
        files: ['.local/bin/fnm'],
        trees: ['.local/share/fnm', '.fnm']
      }, options);
      return options.platform === 'macos'
        ? [buildBrewPlan('fnm', action, 'fnm', { name: 'FNM' }), cleanup]
        : [cleanup];
    }
    const official = buildOfficialShellPlan('fnm', action, 'FNM', INSTALLER, options);
    return options.platform === 'macos'
      ? [buildBrewPlan('fnm', action, 'fnm', { name: 'FNM' }), official]
      : [official];
  }
});
