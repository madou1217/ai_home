'use strict';

const { buildProfileAwareCleanupPlan } = require('../platforms/shared');
const { probeNvm } = require('../probe');
const { defineEnvironmentToolAdapter, parameters } = require('./adapter');
const { buildOfficialShellPlan } = require('./shared');

const INSTALLER = Object.freeze({
  url: 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh',
  hosts: ['raw.githubusercontent.com']
});

module.exports = defineEnvironmentToolAdapter({
  id: 'nvm',
  name: 'NVM',
  runtime: 'node',
  category: 'version-manager',
  description: 'Node.js 多版本管理',
  platforms: ['macos', 'linux'],
  probe: { kind: 'nvm' },
  tasks: [
    { id: 'install-version', label: '安装 Node.js 版本', template: 'nvm install {{version}}', category: 'install', parameters: parameters('version') },
    { id: 'use-version', label: '切换当前 Shell 版本', template: 'nvm use {{version}}', category: 'use', parameters: parameters('version') },
    { id: 'default-version', label: '设置默认版本', template: 'nvm alias default {{version}}', category: 'configure', parameters: parameters('version') },
    { id: 'list-versions', label: '查看已安装版本', template: 'nvm ls', category: 'inspect', parameters: [] },
    { id: 'remove-version', label: '卸载 Node.js 版本', template: 'nvm uninstall {{version}}', category: 'uninstall', parameters: parameters('version') }
  ],
  detect: probeNvm,
  buildPlans(action, options = {}) {
    if (action === 'uninstall') {
      return [buildProfileAwareCleanupPlan('nvm', 'NVM', [
        'NVM_DIR',
        'nvm\\.sh',
        'bash_completion'
      ], { trees: ['.nvm'] }, options)];
    }
    return [buildOfficialShellPlan('nvm', action, 'NVM', INSTALLER, options)];
  }
});
