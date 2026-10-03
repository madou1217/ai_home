'use strict';

const frpcPlugin = require('./frpc');
const herdrPlugin = require('./herdr');
const psmuxPlugin = require('./psmux');
const tmuxPlugin = require('./tmux');

/**
 * 托管工具插件注册表（显式数组，便于依赖注入与测试）。
 *
 * 插件契约：
 * - 描述字段：id/category/name/role/platforms/commands/versionArgs/capabilities/config
 * - resolveExecutableFallback(options)?：PATH 之外的已知安装位置
 * - preferredExecutable(options)?：AIH 自管安装位置（优先于 PATH）
 * - lifecycle?：{ describe(tool, options), resolvePlans(tool, action, options) }
 * - service?：进程守护/系统服务控制（见 frpc 插件）
 */
const TOOL_PLUGINS = Object.freeze([tmuxPlugin, psmuxPlugin, herdrPlugin, frpcPlugin]);

const PLUGIN_BY_ID = new Map(TOOL_PLUGINS.map((plugin) => [plugin.id, plugin]));

function getToolPlugin(toolId) {
  return PLUGIN_BY_ID.get(String(toolId || '').trim().toLowerCase()) || null;
}

// 只返回当前平台可用的插件：不适用的平台直接不展示，避免误解。
function listToolPlugins(nodePlatform = '') {
  const platform = String(nodePlatform || '').trim();
  return TOOL_PLUGINS.filter((plugin) => !platform || plugin.platforms.includes(platform));
}

module.exports = {
  TOOL_PLUGINS,
  getToolPlugin,
  listToolPlugins
};
