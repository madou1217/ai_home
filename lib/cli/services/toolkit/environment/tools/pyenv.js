'use strict';

const { buildBrewPlan, buildCommandPlan } = require('../plan-builders');
const {
  buildProfileAwareCleanupPlan,
  resolveHome
} = require('../platforms/shared');
const { probePyenv } = require('../probe');
const { defineEnvironmentToolAdapter, parameters } = require('./adapter');
const { buildOfficialShellPlan } = require('./shared');

const INSTALLER = Object.freeze({
  url: 'https://pyenv.run',
  hosts: ['pyenv.run']
});

module.exports = defineEnvironmentToolAdapter({
  id: 'pyenv',
  name: 'Pyenv',
  runtime: 'python',
  category: 'version-manager',
  description: 'Python 多版本管理',
  platforms: ['macos', 'linux'],
  probe: { kind: 'pyenv' },
  tasks: [
    { id: 'install-version', label: '安装 Python 版本', template: 'pyenv install {{version}}', category: 'install', parameters: parameters('version') },
    { id: 'global-version', label: '设置全局版本', template: 'pyenv global {{version}}', category: 'configure', parameters: parameters('version') },
    { id: 'local-version', label: '设置当前项目版本', template: 'pyenv local {{version}}', category: 'configure', parameters: parameters('version') },
    { id: 'list-versions', label: '查看已安装版本', template: 'pyenv versions', category: 'inspect', parameters: [] },
    { id: 'remove-version', label: '卸载 Python 版本', template: 'pyenv uninstall --force {{version}}', category: 'uninstall', parameters: parameters('version') }
  ],
  detect: probePyenv,
  buildPlans(action, options = {}) {
    if (action === 'uninstall') {
      const cleanup = buildProfileAwareCleanupPlan(
        'pyenv',
        'Pyenv',
        ['PYENV_ROOT', 'pyenv init'],
        { trees: ['.pyenv'] },
        options
      );
      return options.platform === 'macos'
        ? [buildBrewPlan('pyenv', action, 'pyenv', { name: 'Pyenv' }), cleanup]
        : [cleanup];
    }
    const official = buildOfficialShellPlan('pyenv', action, 'Pyenv', INSTALLER, options);
    if (options.platform === 'macos') {
      return [buildBrewPlan('pyenv', action, 'pyenv', { name: 'Pyenv' }), official];
    }
    if (action === 'update') {
      return [
        buildCommandPlan('pyenv', 'update', 'git', ['-C', `${resolveHome(options)}/.pyenv`, 'pull', '--ff-only'], {
          id: 'pyenv_git_update',
          label: '更新 Pyenv',
          method: 'Git',
          effect: '更新用户目录中的 Pyenv'
        }),
        official
      ];
    }
    return [official];
  }
});
