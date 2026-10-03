'use strict';

const npmPlugin = require('./npm');
const pipPlugin = require('./pip');

/**
 * 软件源（镜像）插件注册表，顺序即界面顺序。
 *
 * 插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability）：
 * - id / name / label / capability='toolkit.mirror' / settingLabel（当前值的含义）
 * - platforms: 支持的平台（数据）
 * - presets: 预置镜像 [{ id, name, url, official, speed, desc }]
 * - guide: { title, commands: [{ platform, platforms, label, cmd }] }，<URL>/<HOST> 为占位符
 * - read(options) → 当前地址；write(url, options) → 写入结果
 */
const MIRROR_PLUGINS = Object.freeze([npmPlugin, pipPlugin]);

const PLUGIN_BY_ID = new Map(MIRROR_PLUGINS.map((plugin) => [plugin.id, plugin]));

function getMirrorPlugin(id) {
  return PLUGIN_BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

function listMirrorPlugins(platform = '') {
  return MIRROR_PLUGINS.filter((plugin) => !platform || plugin.platforms.includes(platform));
}

module.exports = {
  MIRROR_PLUGINS,
  getMirrorPlugin,
  listMirrorPlugins
};
