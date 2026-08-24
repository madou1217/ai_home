'use strict';

const { buildBrewPlan } = require('../plan-builders');
const {
  buildPoetryInstallerPlan,
  buildSelfUpdatePlan
} = require('../platforms/shared');
const { defineEnvironmentToolAdapter, parameters, PLATFORM_IDS } = require('./adapter');
const { commandDetector } = require('./shared');

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
    const installer = buildPoetryInstallerPlan(installerAction, options);
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
