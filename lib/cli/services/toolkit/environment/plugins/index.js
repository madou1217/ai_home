'use strict';

const goPlugin = require('./go');
const nodePlugin = require('./node');
const pythonPlugin = require('./python');
const rustPlugin = require('./rust');

/**
 * 运行环境插件注册表（显式数组，顺序即界面顺序）。
 *
 * 插件契约：
 * - id / name / icon：运行时标识与展示
 * - tools：该运行时下可管理的工具定义（含 platforms、probe、tasks）
 * - detectRuntime(options)：探测运行时本体（版本、路径、包管理器）
 * - resolvePlans(toolId, action, options)：按 options.platform 生成安装/更新/卸载计划（回退链）
 *
 * 新增运行时只需新增一个插件文件并登记到此数组。
 */
const ENVIRONMENT_RUNTIME_PLUGINS = Object.freeze([nodePlugin, pythonPlugin, rustPlugin, goPlugin]);

const PLUGIN_BY_TOOL_ID = new Map(ENVIRONMENT_RUNTIME_PLUGINS.flatMap(
  (plugin) => plugin.tools.map((tool) => [tool.id, plugin])
));

function getRuntimePluginForTool(toolId) {
  return PLUGIN_BY_TOOL_ID.get(String(toolId || '').trim().toLowerCase()) || null;
}

function listRuntimeTools() {
  return ENVIRONMENT_RUNTIME_PLUGINS.flatMap((plugin) => plugin.tools);
}

module.exports = {
  ENVIRONMENT_RUNTIME_PLUGINS,
  getRuntimePluginForTool,
  listRuntimeTools
};
