'use strict';

const { defineEnvironmentToolAdapter, parameters, PLATFORM_IDS } = require('./adapter');
const { buildNpmPackagePlans, commandDetector } = require('./shared');

module.exports = defineEnvironmentToolAdapter({
  id: 'pnpm',
  name: 'pnpm',
  runtime: 'node',
  category: 'package-manager',
  description: 'Node.js 包管理',
  platforms: PLATFORM_IDS,
  probe: { command: 'pnpm', args: ['--version'] },
  tasks: [
    { id: 'install-dependencies', label: '安装项目依赖', template: 'pnpm install', category: 'use', parameters: [] },
    { id: 'add-package', label: '添加依赖', template: 'pnpm add {{package}}', category: 'use', parameters: parameters('package') },
    { id: 'remove-package', label: '移除依赖', template: 'pnpm remove {{package}}', category: 'uninstall', parameters: parameters('package') },
    { id: 'run-script', label: '运行脚本', template: 'pnpm run {{script}}', category: 'use', parameters: parameters('script') }
  ],
  detect: commandDetector('pnpm'),
  buildPlans(action, options = {}) {
    return buildNpmPackagePlans('pnpm', 'pnpm', action, options);
  }
});
