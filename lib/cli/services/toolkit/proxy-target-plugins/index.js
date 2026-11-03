'use strict';

const gitPlugin = require('./git');
const npmPlugin = require('./npm');

/**
 * 工具代理目标插件注册表（Git、npm…），顺序即界面顺序。
 *
 * 插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability）：
 * - id / name / capability='toolkit.proxy-target' / scopeLabel（写入的配置范围）
 * - platforms: 支持的平台（数据）
 * - read(options) → { scope, source, probeStatus, httpProxy, httpsProxy, ... }
 * - write(proxyUrl, options) → 写入（空字符串表示清除）结果，附带最新 read 结果
 */
const PROXY_TARGET_PLUGINS = Object.freeze([gitPlugin, npmPlugin]);

const PLUGIN_BY_ID = new Map(PROXY_TARGET_PLUGINS.map((plugin) => [plugin.id, plugin]));

function getProxyTargetPlugin(id) {
  return PLUGIN_BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

function listProxyTargetPlugins(platform = '') {
  return PROXY_TARGET_PLUGINS.filter((plugin) => !platform || plugin.platforms.includes(platform));
}

module.exports = {
  PROXY_TARGET_PLUGINS,
  getProxyTargetPlugin,
  listProxyTargetPlugins
};
