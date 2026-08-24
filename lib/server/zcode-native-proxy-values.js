'use strict';

// ZCode 原生代理设置与出口探测共用的纯值转换。
//
// 权威入口是 zcode-native-proxy-settings 写入的账号隔离 setting.json：ZCode host
// 自己读取 httpProxy/httpProxyNoProxy，并把它们投影到模型、MCP、命令工具以及
// Electron 默认/内置浏览器 session。本模块只提供 no-proxy 默认值与 URL 归一化；
// AIH 不伪造 ZCode 请求、不修改系统代理，也不向 Desktop 追加 Chromium 代理参数
// 或代理环境变量。
//
// 纯函数，无 IO：代理是否合法、是否可用由 zcode-egress-resolver 判定。

// 模型 agent 的原生 no-proxy 值写入 setting.json；回环不能走代理，因为 host、
// 主进程、CUA helper 与 AIH 都依赖本机回环通信。
const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1', '::1'].join(',');

/**
 * ZCode 原生设置与 curl 探测要求完整 URL；host:port 简写补上 http:// 前缀。
 * @param {string} proxyServer
 * @returns {string}
 */
function toZcodeProxyUrl(proxyServer) {
  const value = String(proxyServer || '').trim();
  if (!value) return '';
  return value.includes('://') ? value : `http://${value}`;
}

module.exports = {
  DEFAULT_NO_PROXY,
  toZcodeProxyUrl
};
