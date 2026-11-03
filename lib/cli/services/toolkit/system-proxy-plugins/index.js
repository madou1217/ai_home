'use strict';

const macosPlugin = require('./macos');
const linuxPlugin = require('./linux');
const windowsPlugin = require('./windows');

/**
 * 系统代理平台插件注册表：每个操作系统一个插件，平台差异全部收在插件里，
 * 调用方（网络层探测、代理诊断、ZCode 出口）只按宿主平台取插件，不再自己分支。插件只读探测，不改系统设置。
 *
 * 插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability / platforms）：
 * - id / name / capability='toolkit.system-proxy' / platforms（数据）/ hostPlatform（process.platform 值）
 * - detectProxy(options, result) → 填充当前生效的系统代理（只读诊断）
 * - tun: { probe(options), interfaceDetected(outputs), routeDetected(outputs) } TUN 探测
 */
const SYSTEM_PROXY_PLUGINS = Object.freeze([macosPlugin, linuxPlugin, windowsPlugin]);

const PLUGIN_BY_HOST_PLATFORM = new Map(SYSTEM_PROXY_PLUGINS.map((plugin) => [plugin.hostPlatform, plugin]));

function getSystemProxyPlugin(hostPlatform = process.platform) {
  return PLUGIN_BY_HOST_PLATFORM.get(String(hostPlatform || '').toLowerCase()) || null;
}

module.exports = {
  SYSTEM_PROXY_PLUGINS,
  getSystemProxyPlugin
};
