'use strict';

const { PLATFORM_IDS, parameters } = require('../parameters');
const { detectPythonEnvironment } = require('../probe');
const { resolveLegacyPlatformPlans } = require('./legacy-platform-plans');

const TOOLS = Object.freeze([
  Object.freeze({
    id: 'pyenv',
    name: 'Pyenv',
    runtime: 'python',
    category: 'version-manager',
    description: 'Python 多版本管理',
    platforms: Object.freeze(['macos', 'linux']),
    probe: Object.freeze({ kind: 'pyenv' }),
    tasks: Object.freeze([
      { id: 'install-version', label: '安装 Python 版本', template: 'pyenv install {{version}}', category: 'install', parameters: parameters('version') },
      { id: 'global-version', label: '设置全局版本', template: 'pyenv global {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'local-version', label: '设置当前项目版本', template: 'pyenv local {{version}}', category: 'configure', parameters: parameters('version') },
      { id: 'list-versions', label: '查看已安装版本', template: 'pyenv versions', category: 'inspect', parameters: [] },
      { id: 'remove-version', label: '卸载 Python 版本', template: 'pyenv uninstall --force {{version}}', category: 'uninstall', parameters: parameters('version') }
    ])
  }),
  Object.freeze({
    id: 'conda',
    name: 'Miniconda',
    runtime: 'python',
    category: 'environment-manager',
    description: 'Python 环境与依赖管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ kind: 'conda' }),
    tasks: Object.freeze([
      { id: 'create-environment', label: '创建环境', template: 'conda create -n {{environment}} python={{version}}', category: 'install', parameters: parameters('environment', 'version') },
      { id: 'activate-environment', label: '激活环境', template: 'conda activate {{environment}}', category: 'use', parameters: parameters('environment') },
      { id: 'list-environments', label: '查看环境', template: 'conda env list', category: 'inspect', parameters: [] },
      { id: 'remove-environment', label: '删除环境', template: 'conda env remove -n {{environment}}', category: 'uninstall', parameters: parameters('environment') }
    ])
  }),
  Object.freeze({
    id: 'uv',
    name: 'uv',
    runtime: 'python',
    category: 'package-manager',
    description: 'Python 包与虚拟环境管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ command: 'uv', args: Object.freeze(['--version']) }),
    tasks: Object.freeze([
      { id: 'create-venv', label: '创建虚拟环境', template: 'uv venv {{environmentPath}}', category: 'install', parameters: parameters('environmentPath') },
      { id: 'add-package', label: '安装包', template: 'uv pip install {{package}}', category: 'use', parameters: parameters('package') },
      { id: 'run-script', label: '运行脚本', template: 'uv run {{script}}', category: 'use', parameters: parameters('script') }
    ])
  }),
  Object.freeze({
    id: 'poetry',
    name: 'Poetry',
    runtime: 'python',
    category: 'package-manager',
    description: 'Python 依赖与打包管理',
    platforms: Object.freeze(PLATFORM_IDS),
    probe: Object.freeze({ command: 'poetry', args: Object.freeze(['--version']) }),
    tasks: Object.freeze([
      { id: 'install-dependencies', label: '安装项目依赖', template: 'poetry install', category: 'use', parameters: [] },
      { id: 'add-package', label: '添加依赖', template: 'poetry add {{package}}', category: 'use', parameters: parameters('package') },
      { id: 'remove-package', label: '移除依赖', template: 'poetry remove {{package}}', category: 'uninstall', parameters: parameters('package') },
      { id: 'run-script', label: '运行脚本', template: 'poetry run python {{script}}', category: 'use', parameters: parameters('script') }
    ])
  })
]);

module.exports = Object.freeze({
  id: 'python',
  name: 'Python',
  icon: 'python',
  tools: TOOLS,
  detectRuntime: detectPythonEnvironment,
  resolvePlans: resolveLegacyPlatformPlans
});
