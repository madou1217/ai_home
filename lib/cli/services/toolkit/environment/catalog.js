'use strict';

const {
  PARAMETER_DEFINITIONS,
  PLATFORM_IDS,
  parameters
} = require('./tools/adapter');
const {
  getEnvironmentToolAdapter,
  listEnvironmentToolAdapters
} = require('./tools');

const ENVIRONMENT_TOOLS = Object.freeze(listEnvironmentToolAdapters());

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
  return getEnvironmentToolAdapter(toolId);
}

function listEnvironmentTools(platform = '') {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  return ENVIRONMENT_TOOLS.filter((tool) => !normalizedPlatform || tool.supports(normalizedPlatform));
}

function listGuideTools(platform = '') {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  return [...ENVIRONMENT_TOOLS, ...GUIDE_ONLY_TOOLS]
    .filter((tool) => !normalizedPlatform
      || (typeof tool.supports === 'function'
        ? tool.supports(normalizedPlatform)
        : tool.platforms.includes(normalizedPlatform)));
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
