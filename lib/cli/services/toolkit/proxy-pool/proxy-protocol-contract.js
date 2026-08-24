'use strict';

// 订阅解析、节点存储和不同代理核心共享的中立协议契约。
// 这里不包含任何运行时或配置格式细节，避免节点领域反向依赖某个具体核心。

const SUPPORTED_PROTOCOLS = new Set([
  'shadowsocks',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'socks5',
  'http',
  'https'
]);
const SUPPORTED_TRANSPORTS = new Set(['tcp', 'ws', 'grpc']);

function normalizeProtocol(protocol) {
  const value = String(protocol || '').trim().toLowerCase();
  if (value === 'ss') return 'shadowsocks';
  if (value === 'hy2') return 'hysteria2';
  return value;
}

function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

module.exports = {
  SUPPORTED_PROTOCOLS,
  SUPPORTED_TRANSPORTS,
  isValidPort,
  normalizeProtocol
};
