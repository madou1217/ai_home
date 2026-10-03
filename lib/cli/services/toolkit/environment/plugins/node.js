'use strict';

const { PLATFORM_IDS, parameters } = require('../parameters');
const { detectNodeEnvironment } = require('../probe');
const { resolveLegacyPlatformPlans } = require('./legacy-platform-plans');

const TOOLS = Object.freeze([
  Object.freeze({
    id: 'nvm',
    name: 'NVM',
    runtime: 'node',
    category: 'version-manager',
    description: 'Node.js 多版本管理',
    platforms: Object.freeze(['macos', 'linux']),
    probe: Object.freeze({ kind: 'nvm' }),
    tasks: Object.freeze([
      { id: 'install-version', label: '安装 Node.js 版本', template: 'nvm install {{version}}', category: 'install', parameters: parameters('version') },
      { id: 'use-version', label: '切换当前 Shell 版本', template: 'nvm use {{version}}', category: 'use', parameters: parameters('version') },
      { id: 'default-version', label: '设置默认版本', template: 'nvm alias default {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'list-versions', label: '查看已安装版本', template: 'nvm ls', category: 'inspect', parameters: [] },
      { id: 'remove-version', label: '卸载 Node.js 版本', template: 'nvm uninstall {{version}}', category: 'uninstall', parameters: parameters('version') }
    ])
  }),
  Object.freeze({
    id: 'fnm',
    name: 'FNM',
    runtime: 'node',
    category: 'version-manager',
    description: '快速 Node.js 多版本管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ command: 'fnm', args: Object.freeze(['--version']) }),
    tasks: Object.freeze([
      { id: 'install-version', label: '安装 Node.js 版本', template: 'fnm install {{version}}', category: 'install', parameters: parameters('version') },
      { id: 'use-version', label: '切换当前 Shell 版本', template: 'fnm use {{version}}', category: 'use', parameters: parameters('version') },
      { id: 'default-version', label: '设置默认版本', template: 'fnm default {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'list-versions', label: '查看已安装版本', template: 'fnm list', category: 'inspect', parameters: [] },
      { id: 'remove-version', label: '卸载 Node.js 版本', template: 'fnm uninstall {{version}}', category: 'uninstall', parameters: parameters('version') }
    ])
  }),
  Object.freeze({
    id: 'volta',
    name: 'Volta',
    runtime: 'node',
    category: 'version-manager',
    description: '项目级 Node.js 工具链固定',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ command: 'volta', args: Object.freeze(['--version']) }),
    tasks: Object.freeze([
      { id: 'install-node', label: '安装 Node.js 版本', template: 'volta install node@{{version}}', category: 'install', parameters: parameters('version') },
      { id: 'pin-node', label: '固定项目 Node.js 版本', template: 'volta pin node@{{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'list-tools', label: '查看已管理工具', template: 'volta list', category: 'inspect', parameters: [] }
    ])
  }),
  Object.freeze({
    id: 'pnpm',
    name: 'pnpm',
    runtime: 'node',
    category: 'package-manager',
    description: 'Node.js 包管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ command: 'pnpm', args: Object.freeze(['--version']) }),
    tasks: Object.freeze([
      { id: 'install-dependencies', label: '安装项目依赖', template: 'pnpm install', category: 'use', parameters: [] },
      { id: 'add-package', label: '添加依赖', template: 'pnpm add {{package}}', category: 'use', parameters: parameters('package') },
      { id: 'remove-package', label: '移除依赖', template: 'pnpm remove {{package}}', category: 'uninstall', parameters: parameters('package') },
      { id: 'run-script', label: '运行脚本', template: 'pnpm run {{script}}', category: 'use', parameters: parameters('script') }
    ])
  }),
  Object.freeze({
    id: 'yarn',
    name: 'Yarn',
    runtime: 'node',
    category: 'package-manager',
    description: 'Node.js 包管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ command: 'yarn', args: Object.freeze(['--version']) }),
    tasks: Object.freeze([
      { id: 'install-dependencies', label: '安装项目依赖', template: 'yarn install', category: 'use', parameters: [] },
      { id: 'add-package', label: '添加依赖', template: 'yarn add {{package}}', category: 'use', parameters: parameters('package') },
      { id: 'remove-package', label: '移除依赖', template: 'yarn remove {{package}}', category: 'uninstall', parameters: parameters('package') },
      { id: 'run-script', label: '运行脚本', template: 'yarn {{script}}', category: 'use', parameters: parameters('script') }
    ])
  }),
  Object.freeze({
    id: 'bun',
    name: 'Bun',
    runtime: 'node',
    category: 'runtime',
    description: 'JavaScript 运行时与包管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ command: 'bun', args: Object.freeze(['--version']) }),
    tasks: Object.freeze([
      { id: 'install-dependencies', label: '安装项目依赖', template: 'bun install', category: 'use', parameters: [] },
      { id: 'add-package', label: '添加依赖', template: 'bun add {{package}}', category: 'use', parameters: parameters('package') },
      { id: 'remove-package', label: '移除依赖', template: 'bun remove {{package}}', category: 'uninstall', parameters: parameters('package') },
      { id: 'run-script', label: '运行脚本', template: 'bun run {{script}}', category: 'use', parameters: parameters('script') }
    ])
  })
]);

module.exports = Object.freeze({
  id: 'node',
  name: 'Node.js',
  icon: 'node',
  tools: TOOLS,
  detectRuntime: detectNodeEnvironment,
  resolvePlans: resolveLegacyPlatformPlans
});
