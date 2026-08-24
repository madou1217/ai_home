'use strict';

const PLATFORM_IDS = Object.freeze(['macos', 'windows', 'linux']);

const PARAMETER_DEFINITIONS = Object.freeze({
  version: Object.freeze({ key: 'version', label: '版本号', placeholder: '例如 22 或 3.12.7' }),
  package: Object.freeze({ key: 'package', label: '包名', placeholder: '例如 typescript' }),
  script: Object.freeze({ key: 'script', label: '脚本路径', placeholder: '例如 scripts/check.py' }),
  environment: Object.freeze({ key: 'environment', label: '环境名称', placeholder: '例如 analytics' }),
  environmentPath: Object.freeze({ key: 'environmentPath', label: '环境目录', placeholder: '例如 .venv' })
});

function parameters(...keys) {
  return keys.map((key) => PARAMETER_DEFINITIONS[key]).filter(Boolean);
}

const ENVIRONMENT_TOOLS = Object.freeze([
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
  }),
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

const GUIDE_ONLY_TOOLS = Object.freeze([
  Object.freeze({
    id: 'venv',
    name: 'Python venv',
    runtime: 'python',
    category: 'virtual-environment',
    description: 'Python 标准库虚拟环境',
    platforms: Object.freeze(PLATFORM_IDS),
    tasks: Object.freeze([
      { id: 'create', label: '创建虚拟环境', template: 'python3 -m venv {{environmentPath}}', windowsTemplate: 'python -m venv {{environmentPath}}', category: 'install', parameters: parameters('environmentPath') },
      { id: 'activate', label: '激活虚拟环境', template: 'source {{environmentPath}}/bin/activate', windowsTemplate: '.\\{{environmentPath}}\\Scripts\\Activate.ps1', category: 'use', parameters: parameters('environmentPath') },
      { id: 'remove', label: '删除虚拟环境', template: 'rm -rf {{environmentPath}}', windowsTemplate: 'Remove-Item -Recurse -Force {{environmentPath}}', category: 'uninstall', parameters: parameters('environmentPath') }
    ])
  })
]);

function getEnvironmentTool(toolId) {
  const normalized = String(toolId || '').trim().toLowerCase();
  return ENVIRONMENT_TOOLS.find((tool) => tool.id === normalized) || null;
}

function listEnvironmentTools(platform = '') {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  return ENVIRONMENT_TOOLS.filter((tool) => !normalizedPlatform || tool.platforms.includes(normalizedPlatform));
}

function listGuideTools(platform = '') {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  return [...ENVIRONMENT_TOOLS, ...GUIDE_ONLY_TOOLS]
    .filter((tool) => !normalizedPlatform || tool.platforms.includes(normalizedPlatform));
}

module.exports = {
  ENVIRONMENT_TOOLS,
  GUIDE_ONLY_TOOLS,
  PARAMETER_DEFINITIONS,
  PLATFORM_IDS,
  getEnvironmentTool,
  listEnvironmentTools,
  listGuideTools
};
